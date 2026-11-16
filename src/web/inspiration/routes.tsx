import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { type Static, Type } from '@sinclair/typebox';
import type { FastifyReply } from 'fastify';
import { todayIn } from '../../calendar-date';
import { sessionUserId } from '../auth/require-session';
import { actorOf } from '../sharing/access';
import { AutosaveSaved } from '../autosave';
import { HttpError } from '../errors';
import { INSPIRATION_PHOTO_ROOT } from '../files/image-url';
import { sendPrivatePhoto } from '../files/private-photo';
import { t } from '../i18n';
import { alreadySavedParam } from '../gallery/urls';
import { outfitUrl } from '../outfits/urls';
import type { WebOptions } from '../plugin';
import { renderFragment, renderPage } from '../render';
import { RowId } from '../schemas';
import { enforceLimit } from '../security/rate-limit';
import { viewContext } from '../view-context';
import {
  LinkImportError,
  type LinkImportRefusal,
  REFUSALS,
} from '../wardrobe/link-import/import';
import { LINK_INPUT_MAX, linkIn } from '../wardrobe/link-import/link-text';
import { InspirationListPage } from './list-page';
import { NewInspirationPage } from './new-page';
import {
  addLookPiece,
  changeLookPiece,
  editLookText,
  findLookPiece,
  removeLookPiece,
  saveLookAsOutfit,
} from './look-actions';
import { PieceBody, readPiece } from './piece-input';
import {
  findInspiration,
  INSPIRATION_MAX_PIECES,
  INSPIRATION_NOTE_MAX,
  INSPIRATION_TITLE_MAX,
  isOwnInspirationPhoto,
  listInspirations,
  MAX_PIECE_POSITION,
} from './queries';
import { RecreatePage } from './recreate-page';
import type { PostedChoice } from './recreate-writes';
import { recreateOwnLook } from './recreation';
import { ShareConfirmPage } from './share-confirm-page';
import { shareFallback } from './share-fallback';
import {
  INSPIRATION_SHARE_PATH,
  SHARE_CONFIRM_PATH,
  SHARE_PHOTO_MAX_BYTES,
} from './share-target';
import { InspirationPage } from './show-page';
import {
  INSPIRATION_LINK_PATH,
  INSPIRATION_PATH,
  inspirationPiecesUrl,
  inspirationUrl,
  NEW_INSPIRATION_PATH,
  recreatePieceUrl,
} from './urls';
import {
  addLinkedInspiration,
  addUploadedInspiration,
  attachInspirationPhoto,
  type InspirationLinkLimit,
  removeInspiration,
  unreadReasonOf,
} from './writes';

/** One look's routes: its page, its title and note, its photo, its delete. */
const LOOK_ROUTE = `${INSPIRATION_PATH}/:id`;

const LookParams = Type.Object({ id: RowId });
/** A piece's place in its look (inspiration_piece.position, a smallint). */
const PIECE_POSITION = Type.Integer({
  minimum: 0,
  maximum: MAX_PIECE_POSITION,
});
const PieceParams = Type.Object({ id: RowId, position: PIECE_POSITION });
// The match view's save (#22c): each strip's piece and its choice, pairs in
// document order ('' is None; a single strip posts scalars, which ajv's
// `coerceTypes: 'array'` makes arrays). Stored data, so anything else, or
// unequal counts, is a 400.
const ChoicesBody = Type.Object({
  position: Type.Array(PIECE_POSITION, { maxItems: INSPIRATION_MAX_PIECES }),
  garment: Type.Array(Type.Union([Type.Literal(''), RowId]), {
    maxItems: INSPIRATION_MAX_PIECES,
  }),
});
// `?unread=` is URL state (a redirect's one-shot note): anything unknown
// shows no note, never a 400.
const LookQuery = Type.Object({
  unread: Type.Optional(Type.String({ maxLength: 32 })),
});
const LinkBody = Type.Object({
  url: Type.String({ maxLength: LINK_INPUT_MAX }),
});
// The autosave posts the whole form: both fields always (stored data, so
// anything else is a 400). Blank is none.
const TextBody = Type.Object({
  title: Type.String({ maxLength: INSPIRATION_TITLE_MAX }),
  note: Type.String({ maxLength: INSPIRATION_NOTE_MAX }),
});
// Checked by the handler, like /file/**: anything that is not a photo name
// is a 404 like a missing photo.
const FileParams = Type.Object({ fileName: Type.String() });

/**
 * Saved looks (#22; docs/plans/2026-11-13-inspiration-library.md), the
 * Outfits page's Inspiration tab: the list, adding one from a photo or a
 * pasted link, a look's page with its title and note, its photo, its
 * pieces and Delete, "Recreate this look" (#22b), and the photos
 * themselves. The signed-in owner's own, like the
 * style profile: `sessionUserId` alone, no `?ownerId=`; another user's look
 * or photo is a 404 like an unknown id (the writers' NotFound), whatever
 * wardrobe is shared. Every write is a native post (PostForm), answered
 * with a 303 to the look's page, the list after a delete; the autosave is
 * answered with its status line.
 */
export const inspirationRoutes: FastifyPluginCallbackTypebox<
  WebOptions & InspirationLinkLimit
> = (
  app,
  { db, photos, logger, fetcher, config, inspirationLinkLimit },
  done,
) => {
  const deps = { db, photos, logger, fetcher };

  function refuseLink(
    reply: FastifyReply,
    reason: LinkImportRefusal,
    link: string,
  ): Promise<FastifyReply> {
    const { message, status } = REFUSALS[reason];
    return renderPage(
      reply,
      <NewInspirationPage
        ctx={viewContext(reply)}
        model={{ link, error: t(message) }}
      />,
      { status },
    );
  }

  app.get(INSPIRATION_PATH, async (request, reply) => {
    const looks = await listInspirations(db, sessionUserId(request));
    return renderPage(
      reply,
      <InspirationListPage ctx={viewContext(reply)} looks={looks} />,
    );
  });

  app.get(NEW_INSPIRATION_PATH, async (_request, reply) =>
    renderPage(
      reply,
      <NewInspirationPage ctx={viewContext(reply)} model={{ link: '' }} />,
    ),
  );

  // The camera or library button of the add page, and the share
  // confirmation's Save: a native multipart post. One file, the photo (a
  // second is a 413), and none past the share's cap (a 413 too): the add
  // page's photo is prepared on the phone first, a shared one as it came.
  // The confirmation also posts the share's `url` and `title`
  // (addUploadedInspiration checks them).
  app.post(
    INSPIRATION_PATH,
    { config: { photoUpload: true } },
    async (request, reply) => {
      const { id } = await addUploadedInspiration(
        deps,
        sessionUserId(request),
        request.parts({
          limits: {
            files: 1,
            fileSize: SHARE_PHOTO_MAX_BYTES,
            fieldSize: LINK_INPUT_MAX,
          },
        }),
      );
      return reply.redirect(inspirationUrl(id), 303);
    },
  );

  // The share target when no service worker answered it (share-fallback.ts):
  // writes nothing, so it is the same-origin hook's one `stateless`
  // exemption (Android's post has no Origin). A link or text goes to the
  // link page, a photo to "open the app and share again".
  app.post(
    INSPIRATION_SHARE_PATH,
    { config: { stateless: true } },
    async (request, reply) => {
      const { outcome, path } = await shareFallback(request);
      logger.info(
        `Share target reached the server without the service worker, for user ${sessionUserId(request)}: ${outcome}`,
      );
      return reply.redirect(path, 303);
    },
  );

  // Where the service worker sends a shared photo (share-target.ts): the
  // photo is on the device (the URL's fragment names it), so the page holds
  // nothing of it and the server keeps no state; its module shows it and
  // its Save is the post above, genuinely same-origin.
  app.get(SHARE_CONFIRM_PATH, async (_request, reply) =>
    renderPage(reply, <ShareConfirmPage ctx={viewContext(reply)} />),
  );

  // A pasted link: fetched here (importLink), then the look's page. A link
  // the server will not fetch is the add page again with the reason; past
  // the rate limit, the 429 error page (a native post shows it).
  app.post(
    INSPIRATION_LINK_PATH,
    { schema: { body: LinkBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      // The paste's budget, shared with POST /api/v1/looks/link-imports.
      await enforceLimit(inspirationLinkLimit, request, {
        logger,
        who: `user ${userId}`,
      });
      const typed = request.body.url;
      const link = linkIn(typed);
      if (!link) return refuseLink(reply, 'no-link', typed);
      try {
        const { id, unread } = await addLinkedInspiration(deps, userId, link);
        return reply.redirect(inspirationUrl(id, unread), 303);
      } catch (error) {
        if (!(error instanceof LinkImportError)) throw error;
        logger.warn(
          `Inspiration link by user ${userId} refused (${error.reason})`,
        );
        return refuseLink(reply, error.reason, typed);
      }
    },
  );

  app.get(
    LOOK_ROUTE,
    { schema: { params: LookParams, querystring: LookQuery } },
    async (request, reply) => {
      const look = await findInspiration(
        db,
        request.params.id,
        sessionUserId(request),
      );
      return renderPage(
        reply,
        <InspirationPage
          ctx={viewContext(reply)}
          look={look}
          unread={unreadReasonOf(request.query.unread)}
        />,
      );
    },
  );

  // The page's title and note (an AutosaveForm): answered with the form's
  // status line, never the fields; a plain post gets the page again.
  app.post(
    LOOK_ROUTE,
    { schema: { params: LookParams, body: TextBody } },
    async (request, reply) => {
      const { id } = request.params;
      const title = request.body.title.trim();
      const note = request.body.note.trim();
      await editLookText({ db, logger }, actorOf(request), id, {
        title: title || null,
        note: note || null,
      });
      if (!request.headers['hx-request']) {
        return reply.redirect(inspirationUrl(id), 303);
      }
      return renderFragment(reply, <AutosaveSaved />);
    },
  );

  app.post(
    `${LOOK_ROUTE}/photo`,
    { config: { photoUpload: true }, schema: { params: LookParams } },
    async (request, reply) => {
      const { id } = request.params;
      await attachInspirationPhoto(
        deps,
        id,
        sessionUserId(request),
        request.files({ limits: { files: 1 } }),
      );
      return reply.redirect(inspirationUrl(id), 303);
    },
  );

  app.post(
    `${LOOK_ROUTE}/delete`,
    { schema: { params: LookParams } },
    async (request, reply) => {
      await removeInspiration(deps, request.params.id, sessionUserId(request));
      return reply.redirect(INSPIRATION_PATH, 303);
    },
  );

  // A look's pieces (#22b): a new one is a native post (the add form or a
  // hint from the title), answered with the look's pieces; a stored one is
  // an AutosaveForm, answered with its status line (a plain post: the page).
  app.post(
    `${LOOK_ROUTE}/pieces`,
    { schema: { params: LookParams, body: PieceBody } },
    async (request, reply) => {
      const { id } = request.params;
      const piece = readPiece(request.body);
      await addLookPiece({ db, logger }, actorOf(request), id, piece);
      return reply.redirect(inspirationPiecesUrl(id), 303);
    },
  );

  app.post(
    `${LOOK_ROUTE}/pieces/:position`,
    { schema: { params: PieceParams, body: PieceBody } },
    async (request, reply) => {
      const { id, position } = request.params;
      const piece = readPiece(request.body);
      await changeLookPiece(
        { db, logger },
        actorOf(request),
        id,
        position,
        piece,
      );
      if (!request.headers['hx-request']) {
        return reply.redirect(inspirationPiecesUrl(id), 303);
      }
      return renderFragment(reply, <AutosaveSaved />);
    },
  );

  app.post(
    `${LOOK_ROUTE}/pieces/:position/delete`,
    { schema: { params: PieceParams } },
    async (request, reply) => {
      const { id, position } = request.params;
      await removeLookPiece({ db, logger }, actorOf(request), id, position);
      return reply.redirect(inspirationPiecesUrl(id), 303);
    },
  );

  // "Recreate this look": one statement, then the pure matching.
  app.get(
    `${LOOK_ROUTE}/recreate`,
    { schema: { params: LookParams } },
    async (request, reply) => {
      const { look, recreation } = await recreateOwnLook(
        db,
        request.params.id,
        sessionUserId(request),
        todayIn(config.timeZone, new Date()),
      );
      return renderPage(
        reply,
        <RecreatePage
          ctx={viewContext(reply)}
          look={look}
          recreation={recreation}
        />,
      );
    },
  );

  // "Save as outfit" (#22c): the chosen garments as an outfit, each choice
  // recorded on its piece; the outfit's page next (with "Already saved"
  // when these garments were one already, so a double tap makes one).
  app.post(
    `${LOOK_ROUTE}/recreate/outfit`,
    { schema: { params: LookParams, body: ChoicesBody } },
    async (request, reply) => {
      const { id } = request.params;
      const { outfit } = await saveLookAsOutfit(
        { db, logger },
        actorOf(request),
        id,
        postedChoices(request.body),
      );
      const flag = alreadySavedParam(outfit);
      return reply.redirect(
        `${outfitUrl(outfit.id)}${flag && `?${flag}`}`,
        303,
      );
    },
  );

  // "Find this" (#22c): a wishlist item for a missing piece, at once (plan
  // section 7: one tap, reversible); the match view again, at the piece,
  // which now says it is on the wishlist.
  app.post(
    `${LOOK_ROUTE}/pieces/:position/find`,
    { schema: { params: PieceParams } },
    async (request, reply) => {
      const { id, position } = request.params;
      await findLookPiece({ db, logger }, actorOf(request), id, position);
      return reply.redirect(recreatePieceUrl(id, position), 303);
    },
  );

  // The images: the owner's session only (sendPrivatePhoto), never by name
  // alone, never under the public /file/**.
  const sendLookPhoto = (
    reply: FastifyReply,
    fileName: string,
    variant: 'original' | 'thumb',
    ownerId: number,
  ) =>
    sendPrivatePhoto({ photos, logger }, reply, {
      fileName,
      variant,
      ownerId,
      kind: 'Inspiration',
      isOwn: (name, owner) => isOwnInspirationPhoto(db, name, owner),
    });

  app.get(
    `${INSPIRATION_PHOTO_ROOT}/:fileName`,
    { schema: { params: FileParams } },
    async (request, reply) =>
      sendLookPhoto(
        reply,
        request.params.fileName,
        'original',
        sessionUserId(request),
      ),
  );
  app.get(
    `${INSPIRATION_PHOTO_ROOT}/thumb/:fileName`,
    { schema: { params: FileParams } },
    async (request, reply) =>
      sendLookPhoto(
        reply,
        request.params.fileName,
        'thumb',
        sessionUserId(request),
      ),
  );

  done();
};

/** The save's choices: the posted pairs, a 400 when they do not pair up (saveRecreation refuses a piece twice). */
function postedChoices(body: Static<typeof ChoicesBody>): PostedChoice[] {
  if (body.position.length !== body.garment.length) {
    throw new HttpError(400, t('refusal.inspiration.choiceRows'));
  }
  return body.position.map((position, index) => {
    const garment = body.garment[index];
    return { position, garmentId: garment === '' ? null : garment };
  });
}
