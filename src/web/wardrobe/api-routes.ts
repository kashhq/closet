import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { todayIn } from '../../calendar-date';
import { QUANTITY_MAX } from '../../wardrobe/availability';
import { CARE_WASH } from '../../wardrobe/care';
import {
  FORMALITIES,
  GARMENT_COLORS,
  MATERIALS,
  WARMTHS,
} from '../../wardrobe/properties';
import { apiResponses } from '../api/contract';
import type { ApiOptions } from '../api/plugin';
import {
  ListCursor,
  ListLimit,
  ListOf,
  literals,
  rankedIdCursor,
  readRankedIdCursor,
  withoutNulls,
} from '../api/resource';
import type { Queryable } from '../../db/client';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { GarmentParams, RowId } from '../schemas';
import { enforceLimit, LINK_IMPORT_LIMIT } from '../security/rate-limit';
import { actorOf } from '../sharing/access';
import { API_PREFIX } from '../surface';
import { destinationValues, postedDestination } from './destination';
import { garmentAddress, garmentGuard, searchGarments } from './garment-access';
import {
  addGarmentCopies,
  deleteOwnGarment,
  editGarment,
  garmentToMend,
  logRepair,
  putGarmentStatus,
  removeRepair,
  replaceGarmentPhoto,
  retryGarmentCutout,
  saveEditedGarmentCutout,
  setGarmentCondition,
  tagGarment,
  turnGarmentPhoto,
} from './garment-actions';
import {
  BulkInput,
  bulkChangeOf,
  ConditionInput,
  CopiesInput,
  CutoutUpload,
  GarmentClone,
  garmentChangesOf,
  GarmentPatch,
  GarmentQuery,
  ignoredPaths,
  LinkImportInput,
  NewGarment,
  OwnerId,
  PhotoUpload,
  refusedGarmentBody,
  refusedRepairBody,
  refuseBoughtForOffCloset,
  refuseReplacesOffWishlist,
  RepairInput,
  RotateInput,
  StatusInput,
  tagBodyOf,
  TagsInput,
} from './garment-api-input';
import { readGarmentEdit, readNewGarment } from './garment-changes';
import { garmentContext } from './garment-context';
import {
  CATEGORY_MAX,
  formAudience,
  NAME_MAX,
  readCondition,
  SIZE_MAX,
  storedFormValues,
} from './garment-input';
import {
  CutoutRetried,
  Garment,
  GarmentCondition,
  GarmentImported,
  GarmentListItem,
  GarmentPhotoResource,
  GarmentPhotoSaved,
  GarmentQuantity,
  GarmentRef,
  GarmentRetried,
  GarmentsUpdated,
  GarmentStatusAnswer,
  GarmentTagged,
  GarmentUpdated,
  RepairRef,
  toGarmentListItem,
  toGarmentPhoto,
  toGarmentResource,
} from './garment-resource';
import { searchFilters } from './garment-search';
import { GRID_PAGE_SIZE } from './grid-page-size';
import { KEYWORD_RANKS } from './keyword-search';
import { REFUSALS } from './link-import/import';
import { linkIn } from './link-import/link-text';
import { saveGarmentFromLink } from './link-import/save';
import { bulkSetProperty } from './queries';
import { readRepairForm, RepairParams } from './repairs';
import {
  cloneGarment,
  createGarment,
  createGarmentOnce,
  type WardrobeDeps,
} from './writes';
import { BY_PERSON } from '../write-origin';

const flag = (description: string) =>
  Type.Boolean({ default: false, description });

/**
 * GET /garments' query: the grid's filters as search_garments names them
 * (GarmentSearchInput), the wardrobe, and the page.
 */
const GarmentListQuery = Type.Object({
  ownerId: OwnerId,
  keyword: Type.Optional(
    Type.String({
      maxLength: NAME_MAX,
      description:
        'Words, each matching the name, brand, colour, type, category or notes (punctuation ignored); notes-only matches last',
    }),
  ),
  category: Type.Optional(Type.String({ maxLength: CATEGORY_MAX })),
  type: Type.Optional(
    Type.String({
      maxLength: 40,
      description: 'A type of `category`, which it needs',
    }),
  ),
  color: Type.Optional(literals(GARMENT_COLORS)),
  size: Type.Optional(Type.String({ maxLength: SIZE_MAX })),
  warmth: Type.Optional(literals(WARMTHS)),
  formality: Type.Optional(literals(FORMALITIES)),
  material: Type.Optional(literals(MATERIALS)),
  wash: Type.Optional(literals(CARE_WASH)),
  capsuleId: Type.Optional(RowId),
  includeArchived: flag('Also garments no longer in the closet'),
  needsWash: flag(
    'Only garments with a copy that needs a wash: your own wardrobe only',
  ),
  needsAttention: flag('Only garments that need repair or replacing soon'),
  needsTagging: flag(
    'Only closet garments still missing their type, warmth or formality',
  ),
  cursor: Type.Optional(ListCursor),
  limit: ListLimit(GRID_PAGE_SIZE),
});

const GarmentList = ListOf(GarmentListItem, {
  title: 'GarmentList',
  description: 'A page of the wardrobe, newest first',
  extra: {
    /** The grid's "N results": every garment the filters match. */
    total: Type.Integer({ minimum: 0 }),
  },
});

/** A garment's resource; its writes are paths under it. */
const GARMENT_PATH = '/garments/:id';

/**
 * The wardrobe's API routes (#192a reads, #192b writes, #192c the photo,
 * the repair log and the link import; plan section 6), registered by
 * apiPlugin under /api/v1, each calling what its page twin calls
 * (operations.ts names the twin).
 *  - GET /garments: the wardrobe's closet, filtered and paged as the grid
 *    (searchGarments, MCP's search_garments): one statement for the page
 *    and one for the count, after the token's.
 *  - GET /garments/{id}: the garment in full, as its page reads it
 *    (requireGarment, garmentContext): the owner's own records only for
 *    the owner.
 *  - The writes (garment-actions.ts, or the page's guard and writer): a
 *    JSON body (garment-api-input.ts) saved by the garment form's rules,
 *    answering what changed, never the garment read again.
 *  - The photo's: multipart parts read by the handler after the garment is
 *    judged (so a refused upload stores nothing), documented through
 *    `multipartBody`, never a `body` schema.
 *  - The link import: the page's budget (linkImportLimit) and MCP's save
 *    (saveGarmentFromLink), answering the new garment.
 * A grantee's `?ownerId=` share rides in the token's read (#170), so none
 * costs more than its page twin but PATCH, which reads the garment it
 * merges into (as update_garment does).
 */
export const wardrobeApiRoutes: FastifyPluginCallbackTypebox<ApiOptions> = (
  app,
  options,
  done,
) => {
  const { db, config, logger, fetcher, linkImportLimit } = options;
  const authorize = garmentGuard(db);
  const deps: WardrobeDeps = {
    db,
    photos: options.photos,
    logger,
    cutouts: options.cutouts,
  };

  app.get(
    '/garments',
    {
      schema: {
        operationId: 'listGarments',
        tags: ['garments'],
        summary: "A wardrobe's garments, filtered as the grid filters them",
        description:
          'The closet (with `includeArchived` the archive too; never the wishlist), newest first. A type without its category is a 400; `needsWash` on a shared wardrobe is a 403; a capsule outside the wardrobe a 404.',
        querystring: GarmentListQuery,
        response: apiResponses({ 200: GarmentList }),
      },
    },
    async (request) => {
      const {
        ownerId,
        cursor,
        limit = GRID_PAGE_SIZE,
        ...search
      } = request.query;
      const { total, garments, next } = await searchGarments(
        db,
        actorOf(request),
        {
          ownerId,
          filters: searchFilters(search),
          before:
            cursor === undefined
              ? undefined
              : readRankedIdCursor(cursor, KEYWORD_RANKS),
          limit,
        },
      );
      return {
        data: garments.map((garment) =>
          toGarmentListItem(garment, options.cutouts.enabled),
        ),
        pagination: {
          ...(next !== null && { nextCursor: rankedIdCursor(next) }),
          limit,
        },
        total,
      };
    },
  );

  app.get(
    GARMENT_PATH,
    {
      schema: {
        operationId: 'getGarment',
        tags: ['garments'],
        summary: 'One garment in full, with its photo',
        description:
          'Any garment of a wardrobe you can see, a wishlist item included. A garment outside it is a 404 like an unknown id. `care` and `repairs` only on your own wardrobe.',
        params: GarmentParams,
        querystring: GarmentQuery,
        response: apiResponses({ 200: Garment }),
      },
    },
    async (request) => {
      const { access, garment } = await authorize.garment(request, 'view');
      const context = await garmentContext(
        db,
        garment,
        { ...access, viewerId: actorOf(request).userId },
        todayIn(config.timeZone, new Date()),
      );
      return toGarmentResource(garment, context, options.cutouts.enabled);
    },
  );

  app.post(
    '/garments',
    {
      schema: {
        operationId: 'createGarment',
        tags: ['garments'],
        summary: 'Adds a garment, without its photo',
        description:
          "To your wardrobe or one shared with you to MANAGE (VIEW is a 403). Saved by the garment form's rules: a blank category or a bad date is a 400 naming the field. The photo is its own upload. With a `clientId`, a retry answers the first garment of that id (200, its `Location`) and creates nothing; the id of a garment deleted since is a 410 `gone`.",
        querystring: GarmentQuery,
        body: NewGarment,
        response: apiResponses({ 200: GarmentRetried, 201: GarmentRef }),
      },
    },
    async (request, reply) => {
      const { access, viewOwner } = await authorize(request, 'manage');
      const {
        destination = 'closet',
        replacesGarmentId,
        boughtForNeedId,
        clientId,
        ...body
      } = request.body;
      refuseReplacesOffWishlist(destination, replacesGarmentId);
      refuseBoughtForOffCloset(destination, boughtForNeedId);
      const form = readNewGarment(
        destinationValues(
          { to: destination, replaces: replacesGarmentId },
          undefined,
        ),
        null,
        garmentChangesOf(body),
        formAudience({ kind: 'new' }, viewOwner),
      );
      if (!form.ok) throw refusedGarmentBody(form.errors);
      // "Bought a different one": the page's own check of the need before
      // anything is stored, and its settling in the garment's transaction.
      // A create with a clientId checks inside createGarmentOnce, after
      // the insert proves it is not a retry of one that settled the need.
      const posted = (on: Queryable) =>
        postedDestination(
          on,
          { to: destination, forNeed: boughtForNeedId },
          access,
        );
      const settle = boughtForNeedId
        ? async (tx: Queryable) => (await posted(tx)).withGarment
        : undefined;
      let created = true;
      let id: number;
      if (clientId) {
        ({ id, created } = await createGarmentOnce(
          deps,
          access.ownerId,
          form.fields,
          destination,
          clientId,
          settle,
        ));
      } else {
        id = await createGarment(
          deps,
          access.ownerId,
          form.fields,
          destination,
          BY_PERSON,
          (await posted(db)).withGarment,
        );
      }
      logger.info(
        `Garment ${id} ${created ? `created (${destination})` : 'already created, retry answered'} by user ${actorOf(request).userId} in wardrobe ${access.ownerId} (API)${
          boughtForNeedId && created
            ? `, bought for Muse need ${boughtForNeedId}`
            : ''
        }${clientId ? `, client id ${clientId.slice(0, 8)}` : ''}`,
      );
      return reply
        .status(created ? 201 : 200)
        .header('Location', apiGarmentUrl(id, viewOwner))
        .send({ id });
    },
  );

  app.patch(
    GARMENT_PATH,
    {
      schema: {
        operationId: 'updateGarment',
        tags: ['garments'],
        summary:
          "Changes a garment's fields, properties, care label and condition",
        description:
          "Only the fields sent: absent leaves one as stored, null clears it. Saved by the garment form's rules (a new type brings its presets, a new category drops what its role lacks: `ignored` names them). Your own wardrobe or a MANAGE share; the wash limit is the owner's alone.",
        params: GarmentParams,
        querystring: GarmentQuery,
        body: GarmentPatch,
        response: apiResponses({ 200: GarmentUpdated }),
      },
    },
    async (request) => {
      const changes = garmentChangesOf(request.body);
      // The merge needs the stored garment, as update_garment's does: the
      // one statement more than the form's save, which posts every field.
      const { edit } = await editGarment(
        db,
        actorOf(request),
        garmentAddress(request),
        (stored) => {
          const read = readGarmentEdit(stored.garment, changes, {
            owner: stored.access.isOwner,
          });
          if (!read.ok) throw refusedGarmentBody(read.errors);
          return read;
        },
      );
      const changed = Object.keys(edit.fields);
      logger.info(
        `Garment ${request.params.id} updated by user ${actorOf(request).userId} (API): ${
          changed.length > 0 ? changed.join(', ') : 'nothing changed'
        }`,
      );
      return { ignored: ignoredPaths(edit.ignored) };
    },
  );

  app.delete(
    GARMENT_PATH,
    {
      schema: {
        operationId: 'deleteGarment',
        tags: ['garments'],
        summary: 'Deletes a garment and its photo',
        description:
          'The owner only: a share, MANAGE included, is a 403. A garment already gone is a 404, which a retry may read as done. A Muse suggestion is a 409: it is set aside, never deleted.',
        params: GarmentParams,
        querystring: GarmentQuery,
        response: apiResponses({ 204: Type.Null({ description: 'Deleted' }) }),
      },
    },
    async (request, reply) => {
      const { access, status } = await deleteOwnGarment(
        deps,
        actorOf(request),
        garmentAddress(request),
      );
      logger.info(
        `Garment ${request.params.id} (${status}) deleted by user ${access.ownerId} (API)`,
      );
      return reply.status(204).send(null);
    },
  );

  app.put(
    `${GARMENT_PATH}/status`,
    {
      schema: {
        operationId: 'setGarmentStatus',
        tags: ['garments'],
        summary: 'Archives or restores a garment',
        description:
          'The owner only. `archived` takes a closet garment out of the closet, `closet` brings an archived one back; one already there is answered as it is. Anything else (a wishlist item) is a 409: "Bought it" is the wishlist\'s.',
        params: GarmentParams,
        querystring: GarmentQuery,
        body: StatusInput,
        response: apiResponses({ 200: GarmentStatusAnswer }),
      },
    },
    async (request) => {
      const { access, from, to } = await putGarmentStatus(
        db,
        actorOf(request),
        garmentAddress(request),
        request.body.status,
      );
      logger.info(
        `Garment ${request.params.id} put in ${to} (${from} -> ${to}) by user ${access.ownerId} (API)`,
      );
      return { status: to };
    },
  );

  app.put(
    `${GARMENT_PATH}/condition`,
    {
      schema: {
        operationId: 'setGarmentCondition',
        tags: ['garments'],
        summary: "Sets a garment's condition",
        description:
          'Your own wardrobe or a MANAGE share. The note is kept only while the condition is not good.',
        params: GarmentParams,
        querystring: GarmentQuery,
        body: ConditionInput,
        response: apiResponses({ 200: GarmentCondition }),
      },
    },
    async (request) => {
      const { condition, conditionNote } = request.body;
      const fields = readCondition({
        condition,
        conditionNote: conditionNote ?? undefined,
      });
      await setGarmentCondition(
        db,
        actorOf(request),
        garmentAddress(request),
        fields,
      );
      logger.info(
        `Garment ${request.params.id} condition ${fields.condition}${fields.conditionNote ? ' (with a note)' : ''} set by user ${actorOf(request).userId} (API)`,
      );
      return withoutNulls(fields);
    },
  );

  app.post(
    `${GARMENT_PATH}/clones`,
    {
      schema: {
        operationId: 'cloneGarment',
        tags: ['garments'],
        summary: 'Copies a garment into your own wardrobe',
        description:
          'Any garment you can see, a VIEW share included: the copy is yours, with its photo. The body changes what differs from the source (absent, the name is "<name> (cloned)"). The source\'s owner-only wash limit is not copied from a share.',
        params: GarmentParams,
        querystring: GarmentQuery,
        body: GarmentClone,
        response: apiResponses({ 201: GarmentRef }),
      },
    },
    async (request, reply) => {
      const {
        access,
        viewOwner,
        garment: source,
      } = await authorize.garment(request, 'view');
      const userId = actorOf(request).userId;
      const values = storedFormValues(source, { owner: access.isOwner });
      const form = readNewGarment(
        {
          ...values,
          name: source.name ? t('CLONE_NAME', { name: source.name }) : '',
        },
        source.fabricWeight,
        garmentChangesOf(request.body ?? {}),
        // The clone is the requester's own garment, whoever owns the source.
        formAudience({ kind: 'clone' }, viewOwner),
      );
      if (!form.ok) throw refusedGarmentBody(form.errors);
      const id = await cloneGarment(deps, source, userId, form.fields);
      logger.info(
        `Garment ${id} cloned from ${source.id} by user ${userId} (API)`,
      );
      return reply
        .status(201)
        .header('Location', apiGarmentUrl(id, undefined))
        .send({ id });
    },
  );

  app.post(
    `${GARMENT_PATH}/copies`,
    {
      schema: {
        operationId: 'addGarmentCopies',
        tags: ['garments'],
        summary: 'Counts more identical copies of a closet garment',
        description: `Its quantity, instead of a new garment (at most ${QUANTITY_MAX}). Your own wardrobe or a MANAGE share. A wishlist item, an archived garment or one past the cap is a 409. Not idempotent: each call adds.`,
        params: GarmentParams,
        querystring: GarmentQuery,
        body: CopiesInput,
        response: apiResponses({ 200: GarmentQuantity }),
      },
    },
    async (request) => {
      const { access, from, to } = await addGarmentCopies(
        db,
        actorOf(request),
        garmentAddress(request),
        request.body?.copies ?? 1,
      );
      logger.info(
        `Garment ${request.params.id} copies added by user ${actorOf(request).userId} in wardrobe ${access.ownerId} (API): quantity ${from} -> ${to}`,
      );
      return { quantity: to };
    },
  );

  app.patch(
    `${GARMENT_PATH}/tags`,
    {
      schema: {
        operationId: 'tagGarment',
        tags: ['garments'],
        summary: "Tags a garment's type, warmth and formality",
        description:
          "The tagging queue's tap (GET /garments?needsTagging=true lists it): only what differs is written, and a new type fills its presets where nothing was set or still at the old type's. A type not of the category is a 400. Your own wardrobe or a MANAGE share.",
        params: GarmentParams,
        querystring: GarmentQuery,
        body: TagsInput,
        response: apiResponses({ 200: GarmentTagged }),
      },
    },
    async (request) => {
      const { changed } = await tagGarment(
        db,
        actorOf(request),
        garmentAddress(request),
        tagBodyOf(request.body),
      );
      if (changed.length > 0) {
        logger.info(
          `Garment ${request.params.id} tagged by user ${actorOf(request).userId} (API): ${changed.join(', ')}`,
        );
      }
      return { changed };
    },
  );

  app.patch(
    '/garments',
    {
      schema: {
        operationId: 'bulkUpdateGarments',
        tags: ['garments'],
        summary: 'Sets one property on many garments',
        description:
          'Select mode\'s "Set…": every garment named whose role has the property; the rest are counted as skipped. Your own wardrobe or a MANAGE share.',
        querystring: GarmentQuery,
        body: BulkInput,
        response: apiResponses({ 200: GarmentsUpdated }),
      },
    },
    async (request) => {
      const { access } = await authorize(request, 'manage');
      const { ids, change } = bulkChangeOf(request.body);
      const result =
        ids.length > 0
          ? await bulkSetProperty(db, access.ownerId, ids, change)
          : { updated: 0, skipped: 0 };
      logger.info(
        `Bulk ${change.property} by user ${actorOf(request).userId} in wardrobe ${access.ownerId} (API): ${result.updated} set, ${result.skipped} skipped, ${ids.length} named`,
      );
      return result;
    },
  );

  app.put(
    `${GARMENT_PATH}/photo`,
    {
      config: { photoUpload: true },
      schema: {
        operationId: 'replaceGarmentPhoto',
        tags: ['photos'],
        summary: "Uploads a garment's photo, replacing the one it has",
        description:
          'multipart/form-data with one `photo` part, read as the photo sheet reads it (a second file is a 413; an image it cannot read, or one past 64 megapixels, a 400). Your own wardrobe or a MANAGE share, checked before the upload is read. The background removal follows: poll GET /garments/{id} until `photo.cutoutStatus` is no longer `pending`. Each call stores a new photo, which replaces the last.',
        params: GarmentParams,
        querystring: GarmentQuery,
        multipartBody: PhotoUpload,
        response: apiResponses({ 200: GarmentPhotoSaved }),
      },
    },
    async (request) => {
      // One file: the photo sheet's second part (pages from before
      // server-side removal sent the browser's cutout) is no client's here.
      const { access, cutoutStatus } = await replaceGarmentPhoto(
        deps,
        actorOf(request),
        garmentAddress(request),
        request.files({ limits: { files: 1 } }),
      );
      logger.info(
        `Garment ${request.params.id} photo uploaded by user ${actorOf(request).userId} in wardrobe ${access.ownerId} (API)`,
      );
      return { cutoutStatus };
    },
  );

  app.post(
    `${GARMENT_PATH}/photo/rotations`,
    {
      schema: {
        operationId: 'rotateGarmentPhoto',
        tags: ['photos'],
        summary: "Turns a garment's photo a quarter",
        description:
          'A turned copy replaces the photo (the original is never changed): an edited cutout turns with it, any other is made again. Your own wardrobe or a MANAGE share; a garment without a photo is a 400. A photo replaced or a mask saved meanwhile is a 409: read the garment and turn again. Not idempotent: each call turns.',
        params: GarmentParams,
        querystring: GarmentQuery,
        body: RotateInput,
        response: apiResponses({ 200: GarmentPhotoSaved }),
      },
    },
    async (request) => {
      const { cutoutStatus } = await turnGarmentPhoto(
        deps,
        actorOf(request),
        garmentAddress(request),
        request.body.direction,
      );
      return { cutoutStatus };
    },
  );

  app.put(
    `${GARMENT_PATH}/photo/cutout`,
    {
      config: { photoUpload: true },
      schema: {
        operationId: 'saveGarmentCutout',
        tags: ['photos'],
        summary: "Saves an edited cutout of a garment's photo",
        description:
          "The mask editor's save: multipart/form-data with one `cutout` part, which replaces the cutout the server made. Your own wardrobe or a MANAGE share; a garment without a photo, or no part, is a 400; a photo replaced meanwhile a 404.",
        params: GarmentParams,
        querystring: GarmentQuery,
        multipartBody: CutoutUpload,
        response: apiResponses({ 200: GarmentPhotoResource }),
      },
    },
    async (request) => {
      const edited = await saveEditedGarmentCutout(
        deps,
        actorOf(request),
        garmentAddress(request),
        () => request.file(),
      );
      logger.info(
        `Garment ${request.params.id} cutout replaced by user ${actorOf(request).userId}, photo version ${edited.version} (API)`,
      );
      return toGarmentPhoto(edited);
    },
  );

  app.post(
    `${GARMENT_PATH}/photo/cutout/retries`,
    {
      schema: {
        operationId: 'retryGarmentCutout',
        tags: ['photos'],
        summary: 'Queues a failed cutout again',
        description:
          '"Try again" on a failed background removal. Idempotent: a cutout that is not failed (pending, ready, edited) is left as it is, `requeued` false. Your own wardrobe or a MANAGE share; a garment without a photo is a 400.',
        params: GarmentParams,
        querystring: GarmentQuery,
        response: apiResponses({ 200: CutoutRetried }),
      },
    },
    async (request) => {
      const { id } = request.params;
      const { outcome } = await retryGarmentCutout(
        deps,
        actorOf(request),
        garmentAddress(request),
      );
      if (outcome.ok) {
        logger.info(
          `Garment ${id} cutout requeued by user ${actorOf(request).userId} (API)`,
        );
      } else {
        logger.info(
          `Garment ${id} cutout retry ignored (${outcome.reason}) (API)`,
        );
      }
      return { requeued: outcome.ok };
    },
  );

  app.post(
    `${GARMENT_PATH}/repairs`,
    {
      schema: {
        operationId: 'logGarmentRepair',
        tags: ['garments'],
        summary: 'Logs a repair or alteration on a garment',
        description:
          "The owner's own record: a share, MANAGE included, is a 403 (a 404 without `ownerId`), and a wishlist item a 409 (not bought yet). A day after today is a 400. The cost counts in the garment's cost per wear.",
        params: GarmentParams,
        querystring: GarmentQuery,
        body: RepairInput,
        response: apiResponses({ 201: RepairRef }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const address = garmentAddress(request);
      // Judged before the entry, as the page does: a refusal names the
      // garment, never the entry's fields.
      await garmentToMend(db, actor, address);
      const form = readRepairForm(
        request.body,
        todayIn(config.timeZone, new Date()),
      );
      if (!form.ok) throw refusedRepairBody(form.errors);
      const repairId = await logRepair(db, actor, address, form.entry);
      logger.info(
        `Repair ${repairId} (${form.entry.kind}, ${form.entry.day}${form.entry.cost === null ? '' : `, cost ${form.entry.cost}`}) logged on garment ${address.id} by user ${actor.userId} (API)`,
      );
      return reply.status(201).send({ id: repairId });
    },
  );

  app.delete(
    `${GARMENT_PATH}/repairs/:repairId`,
    {
      schema: {
        operationId: 'deleteGarmentRepair',
        tags: ['garments'],
        summary: "Removes an entry from a garment's repair log",
        description:
          "The owner only, as logging one. An entry already gone, or another garment's, is a 404, which a retry may read as done.",
        params: RepairParams,
        querystring: GarmentQuery,
        response: apiResponses({ 204: Type.Null({ description: 'Removed' }) }),
      },
    },
    async (request, reply) => {
      const { id, repairId } = request.params;
      await removeRepair(
        db,
        actorOf(request),
        garmentAddress(request),
        repairId,
      );
      logger.info(
        `Repair ${repairId} removed from garment ${id} by user ${actorOf(request).userId} (API)`,
      );
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/garments/link-imports',
    {
      schema: {
        operationId: 'importGarmentFromLink',
        tags: ['garments'],
        summary: 'Adds a garment from a product link',
        description: `Fetches the page (or an image link) and saves the garment as the link import prefills it: name, brand, colours, category, type, materials, price and the first readable photo (its background removal follows). Your own wardrobe or a MANAGE share. Rate limited with the page's link import: ${LINK_IMPORT_LIMIT.max} a minute between them, then a 429 with Retry-After. A refused fetch is a 400 or 422 whose detail leads with its reason (\`blocked-by-site\`: the shop refuses automated fetches, so try another retailer, never again); a form the prefill and the fields given cannot save (no category) is a 400 naming the field.`,
        querystring: GarmentQuery,
        body: LinkImportInput,
        response: apiResponses({ 201: GarmentImported }),
      },
    },
    async (request, reply) => {
      // The wardrobe and the cheap body checks before the budget, so a
      // refused call spends none of it.
      const { access, viewOwner } = await authorize(request, 'manage');
      const userId = actorOf(request).userId;
      const {
        url,
        destination = 'closet',
        properties,
        ...fields
      } = request.body;
      refuseReplacesOffWishlist(destination, fields.replacesGarmentId);
      const link = linkIn(url);
      if (!link) {
        const message = t(REFUSALS['no-link'].message);
        throw new HttpError(400, message, {
          validation: [{ path: 'body/url', message }],
        });
      }
      await enforceLimit(linkImportLimit, request, {
        logger,
        who: `user ${userId}`,
      });
      const saved = await saveGarmentFromLink(
        { ...deps, fetcher },
        userId,
        access,
        { ...fields, url: link, destination, type: properties?.type },
        'API',
        BY_PERSON,
      );
      if (!saved.ok) throw refusedGarmentBody(saved.errors);
      return reply
        .status(201)
        .header('Location', apiGarmentUrl(saved.id, viewOwner))
        .send({
          id: saved.id,
          notices: saved.notices,
          confidence: saved.confidence,
        });
    },
  );

  done();
};

/** A garment's API URL, in the wardrobe it was addressed in. */
function apiGarmentUrl(id: number, viewOwner: number | undefined): string {
  return `${API_PREFIX}/garments/${id}${viewOwner === undefined ? '' : `?ownerId=${viewOwner}`}`;
}
