import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply } from 'fastify';
import { sessionUserId } from '../auth/require-session';
import { AutosaveSaved } from '../autosave';
import { todayIn } from '../../calendar-date';
import type { FieldErrors } from '../auth/validation';
import { t } from '../i18n';
import type { WebOptions } from '../plugin';
import { actorOf } from '../sharing/access';
import { navigateTo, renderFragment, renderPage } from '../render';
import { viewContext } from '../view-context';
import { type GoesWithCloset, judgeGoesWithCloset } from '../gallery/ideas';
import { decisionToastOf } from '../wishlist/suggestion-parts';
import type { GoesWithInputs } from '../gallery/queries';
import { normalizeCategory } from './garment';
import { garmentContext } from './garment-context';
import {
  garmentAddress,
  garmentGuard,
  garmentIn,
  type GarmentRequest,
} from './garment-access';
import {
  changeGarmentStatus,
  setGarmentPublicShare,
  deleteOwnGarment,
  setGarmentCondition,
  updateGarment,
} from './garment-actions';
import { shownPhoto } from './cutout-shown';
import { GarmentPage } from './garment-page';
import { afterDraft } from './draft-redirects';
import { pendingPhotoView } from './link-import/photo-choice';
import { PropertiesFragment } from './property-fields';
import { repairPanel } from './repairs';
import {
  destinationValues,
  postedDestination,
  resolveDestination,
} from './destination';
import { formAudience } from './garment-form';
import {
  type GarmentFormRequest,
  refuseOtherWardrobesDraft,
  renderGarmentForm,
} from './render-form';
import { garmentUrl, wardrobeUrl, WISHLIST_PATH, readIdList } from './urls';
import {
  cloneGarment,
  createGarment,
  createGarmentWithPendingPhoto,
  type WardrobeDeps,
} from './writes';
import {
  ConditionBody,
  GarmentPageQuery,
  NewGarmentQuery,
  PropertiesFragmentQuery,
} from './garment-schemas';
import {
  formValues,
  GarmentBody,
  type GarmentField,
  propertyFormValues,
  readCondition,
  readGarmentForm,
  storedFormValues,
  withPresets,
} from './garment-input';
import { GarmentParams, OwnerQuery } from '../schemas';
import { BY_PERSON } from '../write-origin';

/** A garment's page; its actions are paths under it. */
const GARMENT_PATH = '/wardrobe/:id';

/**
 * One garment: the new form and its post, the properties fragment, the
 * garment page, the edit and clone forms and their posts, the condition
 * control, Share and Stop sharing, archive, restore and delete. Every route takes `?ownerId=` for a
 * shared wardrobe (garmentGuard). Adding from a link has its
 * own plugin (link-import/routes.tsx) that ends on the new form.
 */
export const garmentRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  options,
  done,
) => {
  const { db, logger, config } = options;
  const authorize = garmentGuard(db);
  const deps: WardrobeDeps = {
    db,
    photos: options.photos,
    logger,
    cutouts: options.cutouts,
  };

  /** The form again, with the posted values and what is wrong with them. */
  async function refuseForm(
    reply: FastifyReply,
    form: GarmentFormRequest & { errors: FieldErrors<GarmentField> },
  ): Promise<FastifyReply> {
    logger.warn(
      `Garment form refused (${form.mode.kind}): ${Object.keys(form.errors).join(', ')}`,
    );
    return renderGarmentForm(reply, db, form, 400);
  }

  // The new garment form: the closet's, or the wishlist's (`?to=wishlist`,
  // prefilled from the garment it replaces with `&replaces=`), or a closet
  // garment bought for a Muse need instead of its picks (`?forNeed=`,
  // prefilled from its best pick). `?photo=` is an add-sheet upload's
  // pending photo, shown only while it is still the
  // requester's (the save's claim is the real check); otherwise the form
  // says it is gone (a back navigation after saving lands here). A draft
  // of a batch (#200) also gets its queue (draft-queue.tsx).
  app.get(
    '/wardrobe/new',
    { schema: { querystring: NewGarmentQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await authorize(request, 'manage');
      const { destination, prefill, boughtFor } = await resolveDestination(
        db,
        request.query,
        access,
      );
      const { photo } = request.query;
      return renderGarmentForm(reply, db, {
        mode: { kind: 'new', destination },
        suggestionsFrom: access.ownerId,
        viewOwner,
        values: destinationValues(destination, prefill),
        boughtFor,
        pendingPhoto: photo
          ? {
              fileName: photo,
              scope: {
                userId: sessionUserId(request),
                ownerId: access.ownerId,
              },
              sayGone: true,
              carried: {
                saved: readIdList(request.query.saved),
                leftOut: request.query.leftOut ?? [],
              },
            }
          : undefined,
      });
    },
  );

  // The form's properties after its category, a type chip or the weight
  // changed (src/web/wardrobe/property-fields.tsx): both blocks, the second
  // out of band, with presets filled where the user has not chosen. Reads
  // nothing and writes nothing (a POST only because it carries the form).
  app.post(
    '/wardrobe/properties-fragment',
    { schema: { body: PropertiesFragmentQuery } },
    (request, reply) => {
      const category = normalizeCategory(request.body.category ?? '');
      return renderFragment(
        reply,
        <PropertiesFragment
          category={category}
          values={withPresets(propertyFormValues(request.body), category)}
        />,
      );
    },
  );

  // A new garment. A form holding a pending photo (prefilled from a link, or
  // started from an add-sheet upload) also posts it as `linkPhoto` (stored,
  // no row yet), which is claimed here with the garment
  // (createGarmentWithPendingPhoto); a refused form keeps it. A draft of a
  // batch (#200) moves the queue on to the batch's next draft (afterDraft).
  // Statements after the session: the insert alone; with a pending photo,
  // the claim's transaction; a refused form, its one statement.
  app.post(
    '/wardrobe',
    { schema: { querystring: OwnerQuery, body: GarmentBody } },
    async (request, reply) => {
      const { access, viewOwner } = await authorize(request, 'manage');
      const { linkPhoto } = request.body;
      const userId = sessionUserId(request);
      const scope = { userId, ownerId: access.ownerId };
      const saved = readIdList(request.body.draftsSaved);
      // An order item or a Muse need is checked before anything is read or
      // stored, and written in the garment's transaction.
      const { destination, boughtFor, withGarment } = await postedDestination(
        db,
        request.body,
        access,
      );
      const status = destination.to;
      const again = {
        mode: { kind: 'new', destination },
        suggestionsFrom: access.ownerId,
        viewOwner,
        link: linkPhoto ? pendingPhotoView(linkPhoto) : undefined,
        boughtFor,
        lookalikesDismissed: readIdList(request.body.lookalikesDismissed),
      } as const;
      const form = readGarmentForm(
        request.body,
        formAudience(again.mode, viewOwner),
      );
      if (!form.ok) {
        return refuseForm(reply, {
          ...again,
          values: form.values,
          errors: form.errors,
          // Its draft's queue, and a draft of another wardrobe's 404.
          pendingPhoto: linkPhoto
            ? {
                fileName: linkPhoto,
                scope,
                sayGone: false,
                carried: { saved, leftOut: [] },
              }
            : undefined,
        });
      }
      // Its page's toast: saved, or for "Bought a different one" the need met.
      const savedFlag = boughtFor ? { decided: 'boughtFor' } : { created: 1 };
      const created = (id: number) =>
        logger.info(
          `Garment ${id} created (${status}) by user ${userId} in wardrobe ${access.ownerId}${
            form.fields.replacesGarmentId
              ? `, asked to replace garment ${form.fields.replacesGarmentId}`
              : ''
          }${
            destination.orderItem
              ? `, from order item ${destination.orderItem}`
              : ''
          }${boughtFor ? `, bought for Muse need ${boughtFor.id}` : ''}`,
        );
      if (!linkPhoto) {
        const id = await createGarment(
          deps,
          access.ownerId,
          form.fields,
          status,
          BY_PERSON,
          withGarment,
        );
        created(id);
        return reply.redirect(garmentUrl(id, viewOwner, '', savedFlag), 302);
      }
      const claimed = await createGarmentWithPendingPhoto(
        deps,
        access.ownerId,
        userId,
        form.fields,
        linkPhoto,
        status,
        BY_PERSON,
        withGarment,
      );
      if (!claimed) {
        // Why the claim found nothing: a draft of another wardrobe is a
        // 404 (#200), anything else no longer available.
        await refuseOtherWardrobesDraft(db, linkPhoto, scope);
        return refuseForm(reply, {
          ...again,
          link: pendingPhotoView(undefined),
          values: formValues(request.body),
          errors: { linkPhoto: [t('add.PHOTO_GONE')] },
        });
      }
      const { id, draft } = claimed;
      created(id);
      return draft
        ? reply.redirect(
            afterDraft(logger, viewOwner, linkPhoto, draft, saved, id),
            303,
          )
        : reply.redirect(garmentUrl(id, viewOwner, '', savedFlag), 302);
    },
  );

  /**
   * A wishlist item's "Goes with my closet" (#18b) for its page, judged
   * over the inputs garmentContext read (the owner's alone; undefined
   * otherwise). Logs the search, which is the page's time, not the reads.
   */
  function judgeWishlistItem(
    garmentId: number,
    ownerId: number,
    inputs: GoesWithInputs | undefined,
  ): GoesWithCloset | undefined {
    if (!inputs) return undefined;
    const started = performance.now();
    const judged = judgeGoesWithCloset(inputs);
    if (judged) {
      logger.debug(
        `Goes with my closet for user ${ownerId}: wishlist item ${garmentId} makes ${judged.outfits}${judged.capped ? '+' : ''} outfit(s), ${judged.nearDuplicates.length} near-duplicate(s), in ${Math.round(performance.now() - started)} ms`,
      );
    }
    return judged;
  }

  // Three statements whatever the garment: the session, the garment (what
  // is read next depends on its status), and garmentContext for the rest
  // (garment-context.ts; garment-page.spec.ts counts them).
  app.get(
    GARMENT_PATH,
    { schema: { params: GarmentParams, querystring: GarmentPageQuery } },
    async (request, reply) => {
      const { access, viewOwner, garment } = await authorize.garment(
        request,
        'view',
      );
      const { id } = request.params;
      const today = todayIn(config.timeZone, new Date());
      const context = await garmentContext(
        db,
        garment,
        { ...access, viewerId: sessionUserId(request) },
        today,
      );
      const { own } = context;
      return renderPage(
        reply,
        <GarmentPage
          ctx={viewContext(reply)}
          model={{
            garment: {
              ...garment,
              photo:
                garment.photo &&
                shownPhoto(garment.photo, options.cutouts.enabled),
            },
            capsules: context.capsules,
            viewOwner,
            wear: own && { summary: own.wear },
            replaces: context.replaces,
            replacedBy: context.replacedBy,
            // "Style this" is anyone's who sees a closet garment: Styling
            // browses a shared wardrobe (#42) and saves only one's own.
            styling: {
              canStyle: garment.status === 'closet',
              avoided: own?.avoided ?? [],
            },
            goesWith: judgeWishlistItem(id, access.ownerId, context.goesWith),
            brandSize: context.brandSize,
            outfits: own?.outfits,
            repairs: own?.repairs,
            canEdit: access.canManage,
            canDelete: access.isOwner,
            justCreated: request.query.created === '1',
            justSavedPhoto: request.query.photoSaved === '1',
            justRotatedPhoto: request.query.photoRotated === '1',
            justBought: request.query.bought === '1',
            justLoggedRepair: request.query.repairSaved === '1',
            justAddedCopy: request.query.copyAdded === '1',
            suggestion: context.suggestion,
            agent: context.agent,
            decided: decisionToastOf(request.query.decided),
          }}
        />,
      );
    },
  );

  // The garment page's condition control (garment-condition.tsx, an
  // AutosaveForm): posted on every change, answered with the form's status
  // line, never the chips (a plain post gets the page again). A garment
  // property: the owner and a MANAGE grantee.
  app.post(
    `${GARMENT_PATH}/condition`,
    {
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: ConditionBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const fields = readCondition(request.body);
      const { viewOwner } = await setGarmentCondition(
        db,
        actorOf(request),
        garmentAddress(request),
        fields,
      );
      logger.info(
        `Garment ${id} condition ${fields.condition}${fields.conditionNote ? ' (with a note)' : ''} set by user ${sessionUserId(request)}`,
      );
      if (!request.headers['hx-request']) {
        return reply.redirect(garmentUrl(id, viewOwner), 303);
      }
      return renderFragment(reply, <AutosaveSaved />);
    },
  );

  app.get(
    `${GARMENT_PATH}/edit`,
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { access, viewOwner, garment } = await authorize.garment(
        request,
        'manage',
      );
      return renderGarmentForm(reply, db, {
        mode: {
          kind: 'edit',
          garmentId: garment.id,
          wishlist: garment.status === 'wishlist',
        },
        suggestionsFrom: access.ownerId,
        viewOwner,
        values: storedFormValues(garment, { owner: access.isOwner }),
        repairs: repairPanel(
          garment,
          access.isOwner,
          todayIn(config.timeZone, new Date()),
        ),
      });
    },
  );

  // Every field is posted: the stored garment becomes what the form says
  // (a cleared field is null). A malformed or refused form writes nothing.
  // A save is the update alone (a garment gone is its 404); only a refused
  // form reads the garment, for the form again (#161).
  app.post(
    GARMENT_PATH,
    {
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: GarmentBody,
      },
    },
    async (request, reply) => {
      // Asked before the write: the form's audience is the wardrobe's (a
      // MANAGE grantee's post leaves the owner-only fields as stored), and
      // a refused form is drawn in it. updateGarment's own check is free.
      const { access, viewOwner } = await authorize(request, 'manage');
      const { id } = request.params;
      const form = readGarmentForm(
        request.body,
        formAudience({ kind: 'edit' }, viewOwner),
      );
      if (!form.ok) {
        const stored = await garmentIn(db, access, id);
        return refuseForm(reply, {
          mode: {
            kind: 'edit',
            garmentId: id,
            wishlist: stored.status === 'wishlist',
          },
          suggestionsFrom: access.ownerId,
          viewOwner,
          values: form.values,
          errors: form.errors,
          repairs: repairPanel(
            stored,
            access.isOwner,
            todayIn(config.timeZone, new Date()),
          ),
        });
      }
      await updateGarment(
        db,
        actorOf(request),
        garmentAddress(request),
        form.fields,
      );
      logger.info(`Garment ${id} updated by user ${sessionUserId(request)}`);
      return reply.redirect(garmentUrl(id, viewOwner), 302);
    },
  );

  // The clone form, prefilled from the source; it posts to the route below.
  // Suggestions come from the requester's own wardrobe, where it will land.
  // A shared source's owner-only fields are not copied (FormAudience): the
  // clone starts at its role's wash limit.
  app.get(
    `${GARMENT_PATH}/clone`,
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const {
        access,
        viewOwner,
        garment: source,
      } = await authorize.garment(request, 'view');
      const values = storedFormValues(source, { owner: access.isOwner });
      return renderGarmentForm(reply, db, {
        mode: {
          kind: 'clone',
          garmentId: source.id,
          wishlist: source.status === 'wishlist',
        },
        suggestionsFrom: sessionUserId(request),
        viewOwner,
        values: {
          ...values,
          name: source.name ? t('CLONE_NAME', { name: source.name }) : '',
        },
      });
    },
  );

  app.post(
    `${GARMENT_PATH}/clone`,
    {
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: GarmentBody,
      },
    },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { viewOwner, garment: source } = await authorize.garment(
        request,
        'view',
      );
      const mode = {
        kind: 'clone',
        garmentId: source.id,
        wishlist: source.status === 'wishlist',
      } as const;
      // The clone is the requester's own garment, whoever owns the source.
      const form = readGarmentForm(request.body, formAudience(mode, viewOwner));
      if (!form.ok) {
        return refuseForm(reply, {
          mode,
          suggestionsFrom: userId,
          viewOwner,
          values: form.values,
          errors: form.errors,
          lookalikesDismissed: readIdList(request.body.lookalikesDismissed),
        });
      }
      const id = await cloneGarment(deps, source, userId, form.fields);
      logger.info(`Garment ${id} cloned from ${source.id} by user ${userId}`);
      return reply.redirect(garmentUrl(id, undefined), 302);
    },
  );

  /** Archive and Restore (htmx hx-post): changeGarmentStatus, owner only. */
  async function changeStatus(
    request: GarmentRequest,
    reply: FastifyReply,
    event: 'archive' | 'restore',
  ): Promise<FastifyReply> {
    const { access, viewOwner, from, to } = await changeGarmentStatus(
      db,
      actorOf(request),
      garmentAddress(request),
      event,
    );
    logger.info(
      `Garment ${request.params.id} ${event}d (${from} -> ${to}) by user ${access.ownerId}`,
    );
    return navigateTo(reply, wardrobeUrl(viewOwner));
  }

  app.post(
    `${GARMENT_PATH}/archive`,
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    (request, reply) => changeStatus(request, reply, 'archive'),
  );

  app.post(
    `${GARMENT_PATH}/restore`,
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    (request, reply) => changeStatus(request, reply, 'restore'),
  );

  /**
   * Share and Stop sharing the public link (#669; htmx hx-post from the ⋯
   * menu and the page's "Shared publicly" panel): owner and MANAGE. Back to
   * the garment page, which shows the link, or no longer does.
   */
  async function changePublicShare(
    request: GarmentRequest,
    reply: FastifyReply,
    shared: boolean,
  ): Promise<FastifyReply> {
    const actor = actorOf(request);
    const { viewOwner } = await setGarmentPublicShare(
      db,
      actor,
      garmentAddress(request),
      shared,
    );
    logger.info(
      `Garment ${request.params.id} ${shared ? 'shared publicly' : 'no longer shared publicly'} by user ${actor.userId}`,
    );
    return navigateTo(reply, garmentUrl(request.params.id, viewOwner));
  }

  app.post(
    `${GARMENT_PATH}/share`,
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    (request, reply) => changePublicShare(request, reply, true),
  );

  app.post(
    `${GARMENT_PATH}/share/stop`,
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    (request, reply) => changePublicShare(request, reply, false),
  );

  // htmx (hx-delete): owner only (deleteOwnGarment). The delete answers the
  // status it had: no read before it (#161).
  app.delete(
    GARMENT_PATH,
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { id } = request.params;
      const { access, status } = await deleteOwnGarment(
        deps,
        actorOf(request),
        garmentAddress(request),
      );
      logger.info(
        `Garment ${id} (${status}) deleted by user ${access.ownerId}`,
      );
      // A wishlist item's delete is "not buying it": back to the wishlist.
      return navigateTo(
        reply,
        status === 'wishlist' ? WISHLIST_PATH : '/wardrobe',
      );
    },
  );

  done();
};
