import * as z from 'zod';
import { todayIn } from '../../../calendar-date';
import type { LookPiece } from '../../../wardrobe/recreate';
import {
  GARMENT_COLORS,
  INSPIRATION_PIECE_MAX_COLORS,
  INSPIRATION_PIECE_ROLES,
  PATTERNS,
} from '../../../wardrobe/properties';
import { LIST_LIMIT_MAX } from '../../api/resource';
import { HttpError } from '../../errors';
import { t } from '../../i18n';
import {
  findInspiration,
  INSPIRATION_MAX_PIECES,
  type InspirationDetail,
  listInspirations,
  wishlisted,
} from '../../inspiration/queries';
import { LOOK_PAGE_SIZE } from '../../inspiration/page-size';
import { typesOfRole } from '../../inspiration/piece-input';
import {
  type LookRecreation,
  recreateOwnLook,
} from '../../inspiration/recreation';
import { setLookPieces } from '../../inspiration/look-actions';
import { addLinkedInspiration } from '../../inspiration/writes';
import {
  LinkImportError,
  REFUSALS,
  reasonLedMessage,
} from '../../wardrobe/link-import/import';
import { actorOf, defineTool, type ToolContext } from '../tool';
import { rowId } from './common';

/**
 * Saved looks (#22d; src/web/inspiration/AGENTS.md): the caller's own,
 * like the style profile, so no ownerId and nothing through a share;
 * another user's look is "Inspiration not found" like an unknown id
 * (the queries' NotFound). The reads are the Inspiration tab's and the
 * match view's (recreateOwnLook, so get_inspiration answers what "Recreate
 * this look" shows); the writes are the paste's (addLinkedInspiration) and
 * a piece writer of the look's own lock (setInspirationPieces). Muse reads
 * a link's page itself and tags the look: the vision step no server model does.
 */

const ROLE_TYPES = INSPIRATION_PIECE_ROLES.map(
  (role) => `${role} (${typesOfRole(role).join(', ')})`,
).join('; ');

const pieceInput = z.object({
  role: z.enum(INSPIRATION_PIECE_ROLES),
  type: z
    .string()
    .max(40)
    .optional()
    .describe(
      "One of the role's types (listed in the description); omit for any.",
    ),
  colors: z
    .array(z.enum(GARMENT_COLORS))
    .max(INSPIRATION_PIECE_MAX_COLORS)
    .default([])
    .describe('The main colour first, then an accent; [] for unread.'),
  pattern: z.enum(PATTERNS).optional(),
});

/** The posted piece as the look stores it; a 400 naming the role's types for a type not its own. */
function lookPiece(
  piece: z.output<typeof pieceInput>,
  index: number,
): LookPiece {
  const type = piece.type ?? null;
  if (type !== null && !typesOfRole(piece.role).includes(type)) {
    throw new HttpError(
      400,
      t('refusal.inspiration.pieceType', {
        index,
        type,
        role: piece.role,
        types: typesOfRole(piece.role).join(', '),
      }),
    );
  }
  return {
    role: piece.role,
    type,
    colors: [...new Set(piece.colors)],
    pattern: piece.pattern ?? null,
  };
}

/** A look as the tools answer it: never the photo, only whether it has one. */
function lookOut(look: Omit<InspirationDetail, 'pieces'>) {
  return {
    id: look.id,
    title: look.title,
    note: look.note,
    sourceUrl: look.sourceUrl,
    hasPhoto: look.photo !== null,
  };
}

/**
 * The look with each piece's closest closet garments, as the match view
 * draws them: the chosen one first, a piece on the wishlist with its item
 * and no matches, a missing one with none.
 */
function recreationOut({ look, recreation }: LookRecreation) {
  return {
    ...lookOut(look),
    pieces: look.pieces.map((piece, index) => {
      const { matches, repicked } = recreation.pieces[index];
      const onWishlist = wishlisted(piece);
      return {
        position: piece.position,
        role: piece.role,
        type: piece.type,
        colors: piece.colors,
        pattern: piece.pattern,
        chosenGarmentId: piece.matched?.id ?? null,
        onWishlist: onWishlist
          ? { garmentId: onWishlist.id, name: onWishlist.name }
          : null,
        missing: !onWishlist && matches.length === 0,
        repicked,
        matches: matches.map(({ garment, agrees }) => ({
          garmentId: garment.id,
          name: garment.name,
          category: garment.category,
          type: garment.type,
          colors: garment.colors,
          pattern: garment.pattern,
          available: garment.available,
          agrees,
        })),
      };
    }),
    unfixedPositions: recreation.unfixed.map(
      (index) => look.pieces[index].position,
    ),
  };
}

function lookRecreation(ctx: ToolContext, id: number) {
  return recreateOwnLook(
    ctx.db,
    id,
    ctx.userId,
    todayIn(ctx.timeZone, new Date()),
  );
}

export const inspirationTools = [
  defineTool({
    name: 'list_inspiration',
    title: 'List my saved looks',
    description: `Your saved looks (Outfits › Inspiration), newest first: outfits you saw and kept as a photo, a link or both, each with its title, its link, whether it has a photo and how many pieces it is tagged with. ${LOOK_PAGE_SIZE} a page unless \`limit\` asks: pass the answer's \`next\` (null on the last page) back as \`before\` for the next. A look with no pieces is untagged: read its link's page and tag it with set_inspiration_pieces. Your own only.`,
    input: z.object({
      before: rowId()
        .optional()
        .describe("The previous page's `next`, passed back as it came."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(LIST_LIMIT_MAX)
        .optional()
        .describe(
          `How many a page holds: ${LOOK_PAGE_SIZE} unless asked, at most ${LIST_LIMIT_MAX}.`,
        ),
    }),
    writes: false,
    async run({ before, limit = LOOK_PAGE_SIZE }, ctx) {
      const { looks, next } = await listInspirations(ctx.db, ctx.userId, {
        before,
        limit,
      });
      return {
        looks: looks.map((look) => ({
          id: look.id,
          title: look.title,
          sourceUrl: look.sourceUrl,
          hasPhoto: look.photo !== null,
          pieceCount: look.pieceCount,
        })),
        next,
      };
    },
  }),

  defineTool({
    name: 'get_inspiration',
    title: 'Get a saved look and its matches',
    description:
      'A saved look of yours (list_inspiration) as "Recreate this look" shows it: its title, note and link, and each piece you read in it (role, type, colours, pattern) with up to three of your closet garments closest to it, the chosen one first (the garment saved for the piece when it still matches), each saying how it agrees (type, colour exact or close, pattern) and whether it is available today. The matches go together: `repicked` is a piece whose closest garment clashed with the rest, `unfixedPositions` pieces whose clash nothing within reach mended. A `missing` piece has no garment close enough: suggest one with suggest_garment. A piece already on the wishlist names its item and has no matches. The photo is never sent. Your own looks only.',
    input: z.object({ id: rowId() }),
    writes: false,
    async run(args, ctx) {
      return recreationOut(await lookRecreation(ctx, args.id));
    },
  }),

  defineTool({
    name: 'add_inspiration',
    title: 'Save a look from a link',
    description:
      "WRITES: saves a look from a link (a lookbook page, a post, an image link) to your Inspiration, as the app's paste does: the page is fetched, its title becomes the look's and its first readable photo is kept. A site that refuses the fetch, or a page with no readable photo, still saves the link: `unread` names why (`blocked-by-site`: the site refuses automated fetches, most social sites do; the owner can add a screenshot in the app). A link the server never fetches (a private address, an unusual port) is refused with its reason first. Then tag it with set_inspiration_pieces. Rate limited with add_garment_from_link: 10 a minute.",
    input: z.object({ url: z.url({ protocol: /^https?$/ }).max(2048) }),
    writes: true,
    idempotent: false,
    openWorld: true,
    async run(args, ctx) {
      if (!(await ctx.allowLinkImport())) {
        throw new HttpError(429, t('refusal.rateLimit.linkImport'));
      }
      let saved: Awaited<ReturnType<typeof addLinkedInspiration>>;
      try {
        saved = await addLinkedInspiration(
          {
            db: ctx.db,
            photos: ctx.photos,
            logger: ctx.webLogger,
            fetcher: ctx.fetcher,
          },
          ctx.userId,
          args.url,
          ' (MCP)',
        );
      } catch (error) {
        if (!(error instanceof LinkImportError)) throw error;
        // Only a link never fetched gets here (a 400 of REFUSALS): the
        // reason leads, as add_garment_from_link's.
        throw new HttpError(
          REFUSALS[error.reason].status,
          reasonLedMessage(error.reason),
        );
      }
      const look = await findInspiration(ctx.db, saved.id, ctx.userId);
      return { ...lookOut(look), unread: saved.unread ?? null };
    },
  }),

  defineTool({
    name: 'set_inspiration_pieces',
    title: "Tag a saved look's pieces",
    description: `WRITES: sets what a saved look of yours is made of, the whole list (at most ${INSPIRATION_MAX_PIECES}; [] clears it): each piece a role, optionally a type of that role, up to two colours (main first) and a pattern. Roles and their types: ${ROLE_TYPES}. A piece the look already has, the same in every part, is kept with what was chosen for it; the others are removed and the new ones added after them. Answers the look as get_inspiration does, matched against your closet. Calling it again with the same pieces changes nothing.`,
    input: z.object({
      id: rowId(),
      pieces: z.array(pieceInput).max(INSPIRATION_MAX_PIECES),
    }),
    writes: true,
    idempotent: true,
    async run(args, ctx) {
      const pieces = args.pieces.map(lookPiece);
      await setLookPieces(
        { db: ctx.db, logger: ctx.webLogger },
        actorOf(ctx),
        args.id,
        pieces,
      );
      return recreationOut(await lookRecreation(ctx, args.id));
    },
  }),
];
