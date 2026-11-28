import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply } from 'fastify';
import { sessionUserId } from '../auth/require-session';
import { todayIn } from '../../calendar-date';
import { sendPrivatePhoto } from '../files/private-photo';
import { formFiles } from '../form-body';
import type { WebOptions } from '../plugin';
import { RowId } from '../schemas';
import { safeReturnTo } from '../security/return-to';
import { actorOf } from '../sharing/access';
import { isOwnSelfie } from './queries';
import { attachSelfie, removeSelfie } from './writes';

/**
 * Outfit selfies (#19): taking one for a calendar entry (which marks it
 * worn), removing one, and the images themselves. Everything is the
 * signed-in owner's own, like the calendar: another user's entry, selfie or
 * photo name is a 404, whatever wardrobe is shared.
 *
 * Validation: `returnTo` is where a plain post goes back to (the calendar
 * week, Today, the outfit page), through safeReturnTo; anything else falls
 * back to the entry's week. The upload reads it from the query string
 * because Photos drains every multipart part but the photo unread.
 */
const EntryParams = Type.Object({ id: RowId });
const SelfieParams = Type.Object({ id: RowId });
const ReturnTo = Type.String({ maxLength: 2048 });
const ReturnQuery = Type.Object({ returnTo: Type.Optional(ReturnTo) });
// null: a post without a body (Fastify validates a missing body as null).
const ReturnBody = Type.Union([
  Type.Object({ returnTo: Type.Optional(ReturnTo) }),
  Type.Null(),
]);
// Checked by the handler, like /file/**: anything that is not a photo name
// is a 404 like a missing photo.
const FileParams = Type.Object({ fileName: Type.String() });

export const selfieRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, photos, config, logger },
  done,
) => {
  const deps = { db, photos, logger };

  // The camera or library button on a calendar row, a Today card or the
  // selfie dialog: a native multipart post, 303 back where it came from.
  app.post(
    '/calendar/:id/selfie',
    {
      config: { photoUpload: true },
      schema: { params: EntryParams, querystring: ReturnQuery },
    },
    async (request, reply) => {
      const { day } = await attachSelfie(deps, actorOf(request), {
        entryId: request.params.id,
        // One file: the photo (a second is a 413).
        parts: formFiles(request, { limits: { files: 1 } }),
        today: todayIn(config.timeZone, new Date()),
      });
      return reply.redirect(
        safeReturnTo(request.query.returnTo, `/calendar?week=${day}`),
        303,
      );
    },
  );

  app.post(
    '/selfies/:id/delete',
    { schema: { params: SelfieParams, body: ReturnBody } },
    async (request, reply) => {
      await removeSelfie(deps, actorOf(request), request.params.id);
      return reply.redirect(
        safeReturnTo(request.body?.returnTo, '/calendar'),
        303,
      );
    },
  );

  // The images: the owner's session only (sendPrivatePhoto), never by
  // name alone.
  const sendSelfie = (
    reply: FastifyReply,
    fileName: string,
    variant: 'original' | 'thumb',
    ownerId: number,
  ) =>
    sendPrivatePhoto({ photos, logger }, reply, {
      fileName,
      variant,
      ownerId,
      kind: 'Selfie',
      isOwn: (name, owner) => isOwnSelfie(db, name, owner),
    });

  app.get(
    '/selfies/:fileName',
    { schema: { params: FileParams } },
    async (request, reply) =>
      sendSelfie(
        reply,
        request.params.fileName,
        'original',
        sessionUserId(request),
      ),
  );
  app.get(
    '/selfies/thumb/:fileName',
    { schema: { params: FileParams } },
    async (request, reply) =>
      sendSelfie(
        reply,
        request.params.fileName,
        'thumb',
        sessionUserId(request),
      ),
  );

  done();
};
