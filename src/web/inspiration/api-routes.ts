import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { todayIn } from '../../calendar-date';
import { apiResponses } from '../api/contract';
import {
  PhotoBytes,
  PrivatePhotoParams,
  PrivatePhotoQuery,
} from '../api/private-photo-bytes';
import type { ApiOptions } from '../api/plugin';
import { idCursor, readIdCursor } from '../api/resource';
import { formFiles, formParts } from '../form-body';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { servePrivatePhoto } from '../files/private-photo';
import { OutfitPicked, toOutfitPicked } from '../gallery/idea-resource';
import { enforceLimit, LINK_IMPORT_LIMIT } from '../security/rate-limit';
import { actorOf } from '../sharing/access';
import { API_PREFIX } from '../surface';
import {
  LinkImportError,
  REFUSALS,
  reasonLedMessage,
} from '../wardrobe/link-import/import';
import { LINK_INPUT_MAX, linkIn } from '../wardrobe/link-import/link-text';
import {
  Look,
  LookCreated,
  LookImported,
  LookLinkImport,
  LookList,
  LookListQuery,
  LookParams,
  LookPieceInput,
  LookPieceResource,
  LookPiecesInput,
  LookRecreationResource,
  LookTextInput,
  LookUpload,
  PhotoReplaced,
  PieceFound,
  PieceParams,
  PiecesSetResource,
  readLookPiece,
  RecreationChoices,
  toLook,
  toLookListItem,
  toLookPhoto,
  toLookRecreation,
  toWrittenPiece,
} from './look-resource';
import {
  addLookPiece,
  changeLookPiece,
  editLookText,
  findLookPiece,
  removeLookPiece,
  saveLookAsOutfit,
  setLookPieces,
} from './look-actions';
import {
  findInspiration,
  isOwnInspirationPhoto,
  listInspirations,
} from './queries';
import { LOOK_PAGE_SIZE } from './page-size';
import { recreateOwnLook } from './recreation';
import { SHARE_PHOTO_MAX_BYTES } from './share-target';
import {
  addLinkedInspiration,
  addUploadedInspiration,
  attachInspirationPhoto,
  removeInspiration,
} from './writes';

const LOOK_PATH = '/looks/:id';
const PIECE_PATH = `${LOOK_PATH}/pieces/:position`;

const noContent = (description: string) => ({
  204: Type.Null({ description }),
});

/** A look's API URL: where its create answers it is. */
function lookLocation(id: number): string {
  return `${API_PREFIX}/looks/${id}`;
}

/** A blank title or note is none, as the page's autosave saves it. */
function text(value: string | null): string | null {
  return value?.trim() || null;
}

/**
 * Saved looks on /api/v1 (#193d; plan section 6), registered by apiPlugin,
 * each calling what its page twin calls (operations.ts names the twin):
 * the writers of writes.ts and queries.ts, recreateOwnLook for the match
 * view, saveRecreation and addPieceToWishlist for its two writes. The
 * token's user's own, like the style profile (AGENTS.md): there is no
 * `?ownerId=`, and another's look, piece or photo is the 404 of an unknown
 * id, refused before an upload is read. The share target stays the
 * installed web app's (operations.ts): the worker answers it on the phone.
 */
export const lookApiRoutes: FastifyPluginCallbackTypebox<ApiOptions> = (
  app,
  { db, photos, logger, fetcher, config, inspirationLinkLimit },
  done,
) => {
  const deps = { db, photos, logger, fetcher };
  const via = ' (API)';

  app.get(
    '/looks',
    {
      schema: {
        operationId: 'listLooks',
        tags: ['inspiration'],
        summary: 'Your saved looks, newest first',
        description:
          'Outfits › Inspiration: each look with its title, link, photo and how many pieces it is tagged with. Read one, with its pieces, with GET /looks/{id}.',
        querystring: LookListQuery,
        response: apiResponses({ 200: LookList }),
      },
    },
    async (request) => {
      const { cursor, limit = LOOK_PAGE_SIZE } = request.query;
      const { looks, next } = await listInspirations(
        db,
        actorOf(request).userId,
        {
          before: cursor === undefined ? undefined : readIdCursor(cursor),
          limit,
        },
      );
      return {
        data: looks.map(toLookListItem),
        pagination: {
          ...(next !== null && { nextCursor: idCursor(next) }),
          limit,
        },
      };
    },
  );

  app.post(
    '/looks',
    {
      config: { photoUpload: true },
      schema: {
        operationId: 'createLook',
        tags: ['inspiration'],
        summary: 'Saves a look from a photo',
        description: `multipart/form-data with one \`photo\` part (a second file, or one past ${SHARE_PHOTO_MAX_BYTES / 1024 / 1024} MB, is a 413; an image it cannot read a 400), and optionally where it was seen (\`url\`) and a \`title\`. A link alone is POST /looks/link-imports. 201 with its \`Location\`; each call saves a new look.`,
        multipartBody: LookUpload,
        response: apiResponses({ 201: LookCreated }),
      },
    },
    async (request, reply) => {
      // addUploadedInspiration logs the look and its photo.
      const created = await addUploadedInspiration(
        deps,
        actorOf(request).userId,
        formParts(request, {
          limits: {
            files: 1,
            fileSize: SHARE_PHOTO_MAX_BYTES,
            fieldSize: LINK_INPUT_MAX,
          },
        }),
        via,
      );
      return reply
        .status(201)
        .header('Location', lookLocation(created.id))
        .send({ id: created.id, photo: toLookPhoto(created.photo) });
    },
  );

  app.post(
    '/looks/link-imports',
    {
      schema: {
        operationId: 'importLookFromLink',
        tags: ['inspiration'],
        summary: 'Saves a look from a link',
        description: `The paste: the page is fetched, its title becomes the look's and its first readable photo is kept (or the image, for an image link). A site that refuses the fetch, or a page with no readable photo, still saves the link, saying why in \`unread\`. A link the server never fetches (a private address, an unusual port) is a 400 whose detail leads with its reason, nothing saved. Rate limited with the page's paste: ${LINK_IMPORT_LIMIT.max} a minute between them, then a 429 with Retry-After. 201 with its \`Location\`.`,
        body: LookLinkImport,
        response: apiResponses({ 201: LookImported }),
      },
    },
    async (request, reply) => {
      const userId = actorOf(request).userId;
      const { url, clientId } = request.body;
      // The cheap check before the budget, so a refused body spends none.
      const link = linkIn(url);
      if (!link) throw refusedLink('no-link');
      await enforceLimit(inspirationLinkLimit, request, {
        logger,
        who: `user ${userId}`,
      });
      const client = clientId ? `, client id ${clientId.slice(0, 8)}` : '';
      try {
        // addLinkedInspiration logs the look and how its photo came.
        const { id, unread } = await addLinkedInspiration(
          deps,
          userId,
          link,
          ` (API${client})`,
        );
        return reply
          .status(201)
          .header('Location', lookLocation(id))
          .send({ id, unread });
      } catch (error) {
        if (!(error instanceof LinkImportError)) throw error;
        logger.warn(
          `Inspiration link by user ${userId} (API) refused (${error.reason})`,
        );
        throw refusedLink(error.reason);
      }
    },
  );

  app.get(
    LOOK_PATH,
    {
      schema: {
        operationId: 'getLook',
        tags: ['inspiration'],
        summary: 'One of your saved looks, with its pieces',
        description:
          "Its title, note, link and photo, and each piece read in it with the garment chosen for it. Another's look is a 404 like an unknown id.",
        params: LookParams,
        response: apiResponses({ 200: Look }),
      },
    },
    async (request) =>
      toLook(
        await findInspiration(db, request.params.id, actorOf(request).userId),
      ),
  );

  app.patch(
    LOOK_PATH,
    {
      schema: {
        operationId: 'updateLook',
        tags: ['inspiration'],
        summary: "Changes a look's title or note",
        description:
          "The look page's autosave: a field sent is saved (null or blank clears it), one left out is kept.",
        params: LookParams,
        body: LookTextInput,
        response: apiResponses(noContent('Saved')),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { title, note } = request.body;
      if (title === undefined && note === undefined) {
        const message = t('refusal.inspiration.titleOrNote');
        throw new HttpError(400, message, {
          validation: [{ path: 'body', message }],
        });
      }
      await editLookText({ db, logger }, actorOf(request), id, {
        ...(title !== undefined && { title: text(title) }),
        ...(note !== undefined && { note: text(note) }),
      });
      return reply.status(204).send(null);
    },
  );

  app.delete(
    LOOK_PATH,
    {
      schema: {
        operationId: 'deleteLook',
        tags: ['inspiration'],
        summary: 'Deletes a saved look',
        description:
          'Its photo and pieces go with it; the outfits and wishlist items made from it stay. A look already gone is a 404, which a retry may read as done.',
        params: LookParams,
        response: apiResponses(noContent('Deleted')),
      },
    },
    async (request, reply) => {
      // removeInspiration logs the look and its photo.
      await removeInspiration(
        deps,
        request.params.id,
        actorOf(request).userId,
        via,
      );
      return reply.status(204).send(null);
    },
  );

  app.put(
    `${LOOK_PATH}/photo`,
    {
      config: { photoUpload: true },
      schema: {
        operationId: 'replaceLookPhoto',
        tags: ['inspiration'],
        summary: "Adds or replaces a look's photo",
        description:
          "multipart/form-data with one `photo` part (a second file is a 413; an image it cannot read a 400): a link saved without one, or another picture, whose photo is then gone. Another's look is a 404 before the photo is read. Each call stores a new photo.",
        params: LookParams,
        multipartBody: Type.Object(
          { photo: LookUpload.properties.photo },
          { title: 'LookPhotoUpload' },
        ),
        response: apiResponses({ 200: PhotoReplaced }),
      },
    },
    async (request) => {
      // attachInspirationPhoto logs the photo added or replaced.
      const attached = await attachInspirationPhoto(
        deps,
        request.params.id,
        actorOf(request).userId,
        // One file: the photo (a second is a 413).
        formFiles(request, { limits: { files: 1 } }),
        via,
      );
      return {
        photo: toLookPhoto(attached.photo),
        replaced: attached.replaced,
      };
    },
  );

  app.post(
    `${LOOK_PATH}/pieces`,
    {
      schema: {
        operationId: 'addLookPiece',
        tags: ['inspiration'],
        summary: 'Adds a piece read in a look',
        description:
          "At the end of the look, at a position never used before in it (the look's counter only grows, so a removed piece's position stays retired). At most 12 pieces: one more is a 400. Each call adds one.",
        params: LookParams,
        body: LookPieceInput,
        response: apiResponses({ 201: LookPieceResource }),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const piece = readLookPiece(request.body, 'body');
      const position = await addLookPiece(
        { db, logger },
        actorOf(request),
        id,
        piece,
      );
      return reply.status(201).send(toWrittenPiece(position, piece));
    },
  );

  app.put(
    `${LOOK_PATH}/pieces`,
    {
      schema: {
        operationId: 'setLookPieces',
        tags: ['inspiration'],
        summary: "Sets a look's whole list of pieces",
        description:
          "MCP's set_inspiration_pieces: a stored piece equal in every part to one sent is kept, with its position and the garment chosen for it; the others are removed and the rest added after the look's last position, in the order sent. Sending the same list again changes nothing.",
        params: LookParams,
        body: LookPiecesInput,
        response: apiResponses({ 200: PiecesSetResource }),
      },
    },
    async (request) => {
      const { id } = request.params;
      const pieces = request.body.pieces.map((piece, index) =>
        readLookPiece(piece, `body/pieces/${index}`),
      );
      return setLookPieces({ db, logger }, actorOf(request), id, pieces);
    },
  );

  app.put(
    PIECE_PATH,
    {
      schema: {
        operationId: 'updateLookPiece',
        tags: ['inspiration'],
        summary: 'Changes what a piece is read as',
        description:
          'The piece replaced whole, at its position (a field left out is none); the garment chosen for it is cleared, chosen for what it was. A piece removed meanwhile is a 404.',
        params: PieceParams,
        body: LookPieceInput,
        response: apiResponses({ 200: LookPieceResource }),
      },
    },
    async (request) => {
      const { id, position } = request.params;
      const piece = readLookPiece(request.body, 'body');
      await changeLookPiece(
        { db, logger },
        actorOf(request),
        id,
        position,
        piece,
      );
      return toWrittenPiece(position, piece);
    },
  );

  app.delete(
    PIECE_PATH,
    {
      schema: {
        operationId: 'deleteLookPiece',
        tags: ['inspiration'],
        summary: 'Removes a piece of a look',
        description:
          'The rest keep their positions, and this one is never given to another piece. A piece already gone is a 404, which a retry may read as done.',
        params: PieceParams,
        response: apiResponses(noContent('Removed')),
      },
    },
    async (request, reply) => {
      const { id, position } = request.params;
      await removeLookPiece({ db, logger }, actorOf(request), id, position);
      return reply.status(204).send(null);
    },
  );

  app.get(
    `${LOOK_PATH}/recreation`,
    {
      schema: {
        operationId: 'getLookRecreation',
        tags: ['inspiration'],
        summary: 'Recreates a look from your closet',
        description:
          '"Recreate this look": each piece with up to three of your closet garments closest to it, the chosen one first. Save the choice with POST /looks/{id}/outfits; put a missing piece on the wishlist with PUT /looks/{id}/pieces/{position}/wishlist-item.',
        params: LookParams,
        response: apiResponses({ 200: LookRecreationResource }),
      },
    },
    async (request) =>
      toLookRecreation(
        await recreateOwnLook(
          db,
          request.params.id,
          actorOf(request).userId,
          todayIn(config.timeZone, new Date()),
        ),
      ),
  );

  app.post(
    `${LOOK_PATH}/outfits`,
    {
      schema: {
        operationId: 'saveLookAsOutfit',
        tags: ['inspiration'],
        summary: 'Saves the garments chosen for a look as an outfit',
        description:
          "The match view's \"Save as outfit\": your closet garments, one per piece, saved as an outfit named after the look, and each recorded as its piece's choice. Garments that are an outfit of yours already answer that one, 200 with `alreadySaved`, so a retry creates nothing; a new one is 201 with its `Location`. A piece the look no longer has, a garment not of its piece's kind or one garment for two pieces is a 409 (the recreation is out of date: read it again); a garment gone from your closet a 409 naming it; nothing chosen, or a piece twice, a 400.",
        params: LookParams,
        body: RecreationChoices,
        response: apiResponses({ 200: OutfitPicked, 201: OutfitPicked }),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const saved = await saveLookAsOutfit(
        { db, logger },
        actorOf(request),
        id,
        request.body.choices.map(({ position, garmentId }) => ({
          position,
          garmentId: garmentId ?? null,
        })),
      );
      const { outfit } = saved;
      if (outfit.alreadySaved) return toOutfitPicked(outfit);
      return reply
        .status(201)
        .header('Location', `${API_PREFIX}/outfits/${outfit.id}`)
        .send(toOutfitPicked(outfit));
    },
  );

  app.put(
    `${PIECE_PATH}/wishlist-item`,
    {
      schema: {
        operationId: 'findLookPiece',
        tags: ['inspiration'],
        summary: 'Puts a piece of a look on your wishlist',
        description:
          '"Find this": a wishlist item of the piece\'s category, type, colours and pattern, noting the look, recorded as its choice. A piece on your wishlist already answers its item, 200 with `created: false`; a new one is 201 with the garment\'s `Location`.',
        params: PieceParams,
        response: apiResponses({ 200: PieceFound, 201: PieceFound }),
      },
    },
    async (request, reply) => {
      const { id, position } = request.params;
      const found = await findLookPiece(
        { db, logger },
        actorOf(request),
        id,
        position,
      );
      if (!found.created) return found;
      return reply
        .status(201)
        .header('Location', `${API_PREFIX}/garments/${found.garmentId}`)
        .send(found);
    },
  );

  // The photo's bytes to its owner's device token: the page's route reads
  // the cookie, which this surface never does, so the API has its twin.
  app.get(
    '/look-photos/:fileName',
    {
      config: { apiPhotoBytes: true },
      schema: {
        operationId: 'getLookPhoto',
        tags: ['inspiration'],
        summary: "A saved look's photo",
        description:
          "The URL a look's `photo` names: only yours, never a share's. Anything else (another's photo, a name that is none) is a 404 like a missing photo.",
        params: PrivatePhotoParams,
        querystring: PrivatePhotoQuery,
        response: apiResponses({ 200: PhotoBytes }),
      },
    },
    async (request, reply) =>
      servePrivatePhoto(
        { photos, logger },
        reply,
        {
          fileName: request.params.fileName,
          variant: request.query.variant ?? 'original',
          ownerId: actorOf(request).userId,
          kind: 'Inspiration',
          isOwn: (name, owner) => isOwnInspirationPhoto(db, name, owner),
        },
        'inspiration',
      ),
  );

  done();
};

/** A link the paste never fetches: the 400 naming the field, its reason leading the detail. */
function refusedLink(reason: keyof typeof REFUSALS): HttpError {
  const message = reasonLedMessage(reason);
  return new HttpError(REFUSALS[reason].status, message, {
    validation: [{ path: 'body/url', message }],
  });
}
