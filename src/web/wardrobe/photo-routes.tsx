import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { sessionUserId } from '../auth/require-session';
import { formFile, formFiles } from '../form-body';
import { imageUrl } from '../files/image-url';
import { draftsHeld, MAX_DRAFTS_PER_USER } from '../files/pending-photos';
import type { WebOptions } from '../plugin';
import { renderFragment } from '../render';
import { actorOf } from '../sharing/access';
import { garmentAddress, garmentGuard } from './garment-access';
import {
  replaceGarmentPhoto,
  retryGarmentCutout,
  saveEditedGarmentCutout,
  turnGarmentPhoto,
} from './garment-actions';
import { withShownPhoto } from './cutout-shown';
import { GarmentPhotoView, photoPlace, pollCount } from './garment-photo';
import { batchEnd } from './draft-redirects';
import { nextDraft } from './draft-queue';
import { refuseOtherWardrobesDraft } from './render-form';
import {
  DRAFT_DISCARD_PATH,
  draftUrl,
  garmentUrl,
  PHOTO_ADD_PATH,
  wardrobeUrl,
  readIdList,
} from './urls';
import {
  discardPendingPhoto,
  stagePhotoUploads,
  type WardrobeDeps,
} from './writes';
import {
  CutoutPollQuery,
  DiscardDraftBody,
  RotateBody,
} from './garment-schemas';
import { GarmentParams, OwnerQuery } from '../schemas';

/**
 * A garment's photo: the add sheet's upload and a draft's Discard, the
 * photo sheet's replace and rotate, the mask editor's save, and the
 * cutout's polling and retry. Every route takes `?ownerId=` for a shared
 * wardrobe (garmentGuard).
 */
export const photoRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  options,
  done,
) => {
  const { db, logger } = options;
  const authorize = garmentGuard(db);
  const deps: WardrobeDeps = {
    db,
    photos: options.photos,
    logger,
    cutouts: options.cutouts,
  };

  // The add sheet's camera and library (#97): the photo, stored as the
  // requester's pending photo (stagePhotoUploads: the upload path every
  // garment photo takes, then the pending row), and a 303 to the new
  // garment form carrying it, whose save claims it and queues its cutout.
  // A library pick of several (#200) is a batch of drafts instead, and the
  // 303 opens the first. Adding is a write: the wardrobe is checked before
  // the body is read, so a refused upload stores nothing, and so is the
  // room left for drafts: the parser stops at the first photo past it (one
  // photo always fits: it is not a draft). A native post (PostForm, as
  // every upload): a refused photo is the error page.
  app.post(
    PHOTO_ADD_PATH,
    { config: { photoUpload: true }, schema: { querystring: OwnerQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await authorize(request, 'manage');
      const userId = sessionUserId(request);
      const room = MAX_DRAFTS_PER_USER - (await draftsHeld(db, userId));
      const staged = await stagePhotoUploads(
        deps,
        formFiles(request, { limits: { files: Math.max(room, 1) } }),
        userId,
        access.ownerId,
      );
      return reply.redirect(
        staged.kind === 'single'
          ? wardrobeUrl(viewOwner, { photo: staged.fileName }, '/wardrobe/new')
          : draftUrl(viewOwner, staged.first, [], staged.leftOut),
        303,
      );
    },
  );

  // A draft's Discard (#200): the photo goes (discardPendingPhoto: only the
  // requester's own, still pending, in the wardrobe its batch was uploaded
  // for) and the queue moves on to the next draft after it, or ends as a
  // save of the last one would. Nothing to discard (saved or discarded
  // already, a second tap) ends the queue the same way; the requester's
  // draft for another wardrobe is a 404, as on the form and the save.
  app.post(
    DRAFT_DISCARD_PATH,
    { schema: { querystring: OwnerQuery, body: DiscardDraftBody } },
    async (request, reply) => {
      const { access, viewOwner } = await authorize(request, 'manage');
      const scope = { userId: sessionUserId(request), ownerId: access.ownerId };
      const { photo } = request.body;
      const saved = readIdList(request.body.saved);
      // Drafts only: a single pending photo is never this button's. The
      // take answers the drafts still waiting, so the next is read with it.
      const discarded = await discardPendingPhoto(deps, photo, scope, {
        draftsOnly: true,
      });
      const draft = discarded?.draft;
      // Nothing taken: a draft of another wardrobe is a 404, as on the form.
      if (!draft) await refuseOtherWardrobesDraft(db, photo, scope);
      const next = draft && nextDraft(draft.waiting, draft.position);
      return reply.redirect(
        next
          ? draftUrl(viewOwner, next, saved)
          : batchEnd(logger, viewOwner, saved),
        303,
      );
    },
  );

  // The garment page's photo while its cutout is pending polls this on a
  // backoff (cutoutPollDelay) and swaps it in; the answer stops polling
  // once the cutout is ready or failed, or the polls reach their cap while
  // this server's queue waits for its model.
  app.get(
    '/wardrobe/:id/cutout',
    { schema: { params: GarmentParams, querystring: CutoutPollQuery } },
    async (request, reply) => {
      const { access, viewOwner, garment } = await authorize.garment(
        request,
        'view',
      );
      return renderFragment(
        reply,
        <GarmentPhotoView
          garment={withShownPhoto(garment, options.cutouts.enabled)}
          viewOwner={viewOwner}
          canEdit={access.canManage}
          place={photoPlace(request.query.place)}
          poll={pollCount(request.query.poll)}
          modelUnavailable={options.cutouts.state.name === 'waiting-for-model'}
        />,
      );
    },
  );

  // "Try again" on a failed cutout: a native post (PostForm), answered
  // with the garment page, which shows it pending. Idempotent: a cutout
  // that is no longer failed is left alone, a pending one included (its
  // job may be running: src/cutout/state.ts).
  app.post(
    '/wardrobe/:id/cutout/retry',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { id } = request.params;
      const { viewOwner } = await retryGarmentCutout(
        deps,
        actorOf(request),
        garmentAddress(request),
      );
      return reply.redirect(garmentUrl(id, viewOwner), 303);
    },
  );

  // The photo sheet's native multipart post: the photo; its cutout is
  // queued; 303 to the garment. The garment is checked before the body is
  // read, so a refused upload stores nothing, and a refusal is the error
  // page (htmx dropped it). Pages cached before 2026-09-27 still hx-post:
  // they get the HX-Redirect they wait for. Two files: pages cached before
  // server-side removal also send the browser's cutout (nobgPhoto), which
  // storeUploadParts drains and ignores; a third file would be a 413.
  app.post(
    '/wardrobe/:id/photo',
    {
      config: { photoUpload: true },
      schema: { params: GarmentParams, querystring: OwnerQuery },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { viewOwner } = await replaceGarmentPhoto(
        deps,
        actorOf(request),
        garmentAddress(request),
        formFiles(request, { limits: { files: 2 } }),
      );
      const saved = garmentUrl(id, viewOwner, '', { photoSaved: 1 });
      if (request.headers['hx-request']) {
        return reply.header('HX-Redirect', saved).status(200).send();
      }
      return reply.redirect(saved, 303);
    },
  );

  // The photo sheet's ↺ and ↻: a native post (PostForm), 303 back to the
  // garment with ?photoRotated=1, which opens the sheet again so the next
  // quarter turn is one tap. The photo is replaced by a turned copy as an
  // upload replaces it (rotateGarmentPhoto); a photo replaced or a mask
  // saved meanwhile is a 409 (a cutout finishing is not, #248).
  app.post(
    '/wardrobe/:id/photo/rotate',
    {
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: RotateBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { viewOwner } = await turnGarmentPhoto(
        deps,
        actorOf(request),
        garmentAddress(request),
        request.body.direction,
      );
      return reply.redirect(
        garmentUrl(id, viewOwner, '', { photoRotated: 1 }),
        303,
      );
    },
  );

  // The mask editor's save (views/assets/page/mask-editor.ts): the edited cutout
  // replaces the stored one; the answer is the photo's new URLs (signed:
  // imageUrl), which the page points at. `version` stays for a page whose
  // script predates them (it rewrites `v`, which the signature covers, so
  // /file answers that through the row).
  app.post(
    '/wardrobe/:id/nobg',
    {
      config: { photoUpload: true },
      schema: { params: GarmentParams, querystring: OwnerQuery },
    },
    async (request, reply) => {
      const edited = await saveEditedGarmentCutout(
        deps,
        actorOf(request),
        garmentAddress(request),
        () => formFile(request),
      );
      return reply.send({
        version: edited.version,
        originalUrl: imageUrl(edited, 'original'),
        nobgUrl: imageUrl(edited, 'nobg'),
      });
    },
  );

  done();
};
