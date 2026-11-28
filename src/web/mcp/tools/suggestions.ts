import { t } from '../../i18n';
import * as z from 'zod';
import { selectScalars } from '../../../db/select-scalars';
import type { OutfitCount } from '../../../wardrobe/goes-with';
import {
  MAX_OPTIONS_PER_GROUP,
  NEED_NAME_MAX,
  NEED_NOTE_MAX,
  PICK_NOTE_MAX,
} from '../../../wardrobe/suggestions';
import { HttpError } from '../../errors';
import { proposeOutfitTo } from '../../outfits/outfit-actions';
import { agentOutfitsSql } from '../../outfits/proposals';
import { OUTFIT_GARMENTS_MAX, OUTFIT_NAME_MAX } from '../../outfits/queries';
import { CATEGORY_MAX, NAME_MAX } from '../../wardrobe/garment-input';
import { findGarment } from '../../wardrobe/queries';
import {
  checkSuggestionRoom,
  createNeed,
  finishAgentRound,
  logSuggestedPick,
  markSuggestedPick,
} from '../../wishlist/suggestion-actions';
import { readSuggestionFeedback } from '../../wishlist/feedback';
import { notifyRounds, QUIET_PERIOD_MS } from '../../wishlist/round-end';
import { ROUND_SUMMARY_MAX } from '../../wishlist/rounds';
import {
  type AgentPick,
  type Need,
  readInbox,
  type SetAsideRow,
} from '../../wishlist/inbox';
import { actorOf, defineTool, type ToolContext } from '../tool';
import { priceInput, rowId } from './common';
import { addGarmentFromLink } from './link-import';

/** What the write actions take (#712): the tool's database and the Web logger its op line goes to. */
const deps = (ctx: ToolContext) => ({ db: ctx.db, logger: ctx.webLogger });

/**
 * The agent's tools (#337; docs/plans/2026-10-05-muse-suggestions.md section
 * 5): the agent writes its suggestions as the app's own rows, through the
 * app's own writers, and reads back what the owner decided. The caller's
 * own wardrobe, no ownerId. A need is createOptionGroup's, a pick the
 * link import's garment marked by markSuggestedProduct in its transaction, an
 * outfit proposeOutfitTo's (src/web/outfits/outfit-actions.ts); list_suggestions reads the inbox and the
 * Outfits tab as their pages do, get_suggestion_feedback the decisions
 * since the agent's last call (src/web/wishlist/feedback.ts).
 *
 * The rules (doc section 5): nothing here buys, marks owned, archives or
 * deletes (a pick lands on the wishlist, an outfit is a proposal never
 * planned), and nothing set aside is proposed again: a need by its name,
 * a product by its link (productUrlKey), an outfit by its garments.
 */

/** "Unlocks N" as the inbox says it: a number, or "50+" past the cap. */
function unlocksOut(count: OutfitCount | undefined): number | string | null {
  if (!count) return null;
  return count.capped ? `${count.outfits}+` : count.outfits;
}

function pickOut(pick: AgentPick, unlocks?: ReadonlyMap<number, OutfitCount>) {
  return {
    id: pick.id,
    name: pick.name,
    brand: pick.brand,
    category: pick.category,
    price: pick.price,
    sourceUrl: pick.sourceUrl,
    rank: pick.rank,
    note: pick.note,
    ...(unlocks && { unlocks: unlocksOut(unlocks.get(pick.id)) }),
  };
}

export function needOut(need: Pick<Need, 'id' | 'name' | 'budget' | 'note'>) {
  return {
    id: need.id,
    name: need.name,
    budget: need.budget,
    note: need.note,
  };
}

/**
 * What the owner set aside of the agent's: needs, and options of needs
 * (their own wishlist items set aside are theirs, not the agent's to hear
 * of). Each with the reason and the owner's note.
 */
function setAsideOut(rows: readonly SetAsideRow[]) {
  return {
    needs: rows.flatMap((row) =>
      row.kind === 'need'
        ? [
            {
              ...needOut(row.need),
              reason: row.need.dismissedReason,
              ownerNote: row.need.ownerNote,
            },
          ]
        : [],
    ),
    options: rows.flatMap((row) =>
      row.kind === 'pick' && row.need && 'dismissedNote' in row.pick
        ? [
            {
              id: row.pick.id,
              name: row.pick.name,
              sourceUrl: row.pick.sourceUrl,
              needId: row.need.id,
              reason: row.pick.dismissedReason,
              note: row.pick.dismissedNote,
            },
          ]
        : [],
    ),
  };
}

export const suggestionTools = [
  defineTool({
    name: 'list_suggestions',
    title: 'List your suggestions',
    description:
      'What you have suggested to the owner and where each stands, as their Wishlist inbox and Outfits tab show it: `needs` open with their options (each with the outfits it unlocks with the owner\'s closet, `unlocks`, a number or "50+"; the owner sees options sorted by it), `readyToBuy` (needs the owner chose an option for, not bought yet), `stillLooking` (open needs with no open option: give them options), `setAside` (needs and options the owner turned down, with the reason and their note: never propose them again), and your outfits (`outfits`: proposed, loved, or declined with a reason; pieces set aside make an outfit need a replacement). Needs settled by a purchase have left the inbox: get_suggestion_feedback tells of them.',
    input: z.object({}),
    writes: false,
    async run(_args, ctx) {
      const [inbox, read] = await Promise.all([
        readInbox(ctx.db, {
          ownerId: ctx.userId,
          viewerId: ctx.userId,
          role: 'OWN',
        }),
        selectScalars(ctx.db, { outfits: agentOutfitsSql(ctx.userId) }),
      ]);
      return {
        needs: inbox.groups.map(({ need, options, unlocks }) => ({
          ...needOut(need),
          options: options.map((pick) => pickOut(pick, unlocks)),
        })),
        readyToBuy: inbox.readyToBuy.map(({ need, pick }) => ({
          need: needOut(need),
          chosen: pickOut(pick),
        })),
        stillLooking: inbox.stillLooking.map(needOut),
        setAside: setAsideOut(inbox.setAside),
        outfits: read.outfits.map((outfit) => ({
          id: outfit.id,
          name: outfit.name,
          note: outfit.note,
          reaction: outfit.reaction,
          reason: outfit.dismissedReason,
          ownerNote: outfit.ownerNote,
          pieces: outfit.pieces.map((piece) => ({
            id: piece.id,
            name: piece.name,
            status: piece.status,
            setAside: piece.setAside,
          })),
        })),
      };
    },
  }),

  defineTool({
    name: 'get_suggestion_feedback',
    title: 'Get the owner’s feedback on your suggestions',
    description:
      'What the owner decided about your suggestions since your last round ended (before your first: everything): `needs` decided (chosen an option, bought, or set aside with a reason and their note), `picksSetAside` (options turned down: the reason, too_pricey, colour, style, already_have, fit_size or not_now, and their note; chose_another when they chose a sibling; returned after buying), `purchases` (with the price paid; `different: true` when they bought something else for the need), `outfits` (your outfits they loved, declined with a reason, or undid), and `wears`: every bought suggestion with how often it has been worn, on every call. Read it first in every conversation and act on every reason. It changes nothing: what it tells stays new until you end your round with finish_round and this answer’s `until` (a few seconds behind the read, so nothing committed meanwhile is missed), so an answer lost on the way is told again. An item may be told twice; its id says which. `all: true` answers everything.',
    input: z.object({
      all: z
        .boolean()
        .optional()
        .describe('Everything, not only what is new since your last round.'),
    }),
    // A pure read: the cursor moves only when the round ends (#337 part
    // A2's finish_round takes `until`), so a lost answer is told again.
    writes: false,
    async run({ all }, ctx) {
      const feedback = await readSuggestionFeedback(ctx.db, {
        ownerId: ctx.userId,
        tokenId: ctx.tokenId,
        all: all ?? false,
      });
      ctx.webLogger.debug(
        `Suggestion feedback read by user ${ctx.userId} (MCP, token ${ctx.tokenId}${all ? ', all' : ''}): ${feedback.needs.length} needs, ${feedback.picksSetAside.length} set aside, ${feedback.purchases.length} purchases, ${feedback.outfits.length} outfits`,
      );
      return feedback;
    },
  }),

  defineTool({
    name: 'create_option_group',
    title: 'Create a need',
    description: `WRITES: one need the owner's wardrobe has ("A navy blazer"), to hold 2 to ${MAX_OPTIONS_PER_GROUP} options you then add with suggest_garment. It shows on the owner's Wishlist inbox, open until they choose, buy, or set it aside. A need of the same name already open is refused with its id (add options to it), as is one the owner chose an option for (decided); one they set aside is refused with their reason: never propose it again. Answers the need's id.`,
    input: z.object({
      name: z
        .string()
        .trim()
        .min(1)
        .max(NEED_NAME_MAX)
        .describe('What it is, in plain words: "White leather sneakers".'),
      budget: z
        .number()
        .nonnegative()
        .max(99_999_999)
        .optional()
        .describe('The most one should cost, in US dollars.'),
      note: z
        .string()
        .trim()
        .min(1)
        .max(NEED_NOTE_MAX)
        .optional()
        .describe(
          'Why the wardrobe needs it, naming the closet pieces it pairs with: shown behind a tap.',
        ),
    }),
    writes: true,
    idempotent: false,
    async run({ name, budget, note }, ctx) {
      const id = await createNeed(deps(ctx), actorOf(ctx), {
        name,
        budget: budget === undefined ? null : budget.toFixed(2),
        note: note ?? null,
        tokenId: ctx.tokenId,
      });
      return { id };
    },
  }),

  defineTool({
    name: 'suggest_garment',
    title: 'Suggest a product for a need',
    description: `WRITES: fetches a product page, as add_garment_from_link does, and adds it to the owner's wishlist as one of your options for a need (create_option_group), with your note and rank, shown on its card. Always on the wishlist: buying is the owner's. Refused before the fetch: a need not open (decided) or holding ${MAX_OPTIONS_PER_GROUP} open options, and a product you suggested before (the same link, tracking parameters aside), above all one the owner set aside. Give price (the listed one) and size (get_sizes has the owner's size per brand) when you know them better than the page. Rate limited with the link imports, 10 a minute. A shop that refuses automated fetches answers \`blocked-by-site\`: suggest the product from another retailer.`,
    input: z.object({
      url: z.url({ protocol: /^https?$/ }).max(2048),
      groupId: rowId().describe('The need, from create_option_group.'),
      note: z
        .string()
        .trim()
        .min(1)
        .max(PICK_NOTE_MAX)
        .optional()
        .describe(
          `Why this option, in at most ${PICK_NOTE_MAX} characters: material, fit and sizing, price against the budget, what it pairs with.`,
        ),
      rank: z
        .number()
        .int()
        .min(1)
        .max(MAX_OPTIONS_PER_GROUP)
        .optional()
        .describe(
          'Your place for it among the need’s options: 1 is your pick.',
        ),
      price: priceInput()
        .optional()
        .describe(
          'The listed price in US dollars, when the page gets it wrong.',
        ),
      size: z
        .string()
        .trim()
        .min(1)
        .max(40)
        .optional()
        .describe('The size to buy.'),
      name: z.string().max(NAME_MAX).optional(),
      category: z.string().max(CATEGORY_MAX).optional(),
      type: z.string().max(40).optional(),
    }),
    writes: true,
    idempotent: false,
    openWorld: true,
    async run(args, ctx) {
      // The need's room before the rate limit and the fetch, so a refused
      // call spends neither.
      const actor = actorOf(ctx);
      await checkSuggestionRoom(ctx.db, actor, args.groupId, args.url);
      if (!(await ctx.allowLinkImport())) {
        throw new HttpError(429, t('refusal.rateLimit.linkImport'));
      }
      const provenance = {
        tokenId: ctx.tokenId,
        groupId: args.groupId,
        note: args.note ?? null,
        rank: args.rank ?? null,
      };
      const saved = await addGarmentFromLink(
        ctx,
        { ownerId: ctx.userId, isOwner: true },
        {
          url: args.url,
          destination: 'wishlist',
          name: args.name,
          category: args.category,
          type: args.type,
          size: args.size,
          price: args.price?.toFixed(2),
        },
        {
          // In the garment's transaction, judged again under the owner
          // lock: a need decided or filled during the fetch, or the same
          // link marked by a call alongside, rolls the garment back.
          withGarment: (tx, garmentId) =>
            markSuggestedPick(tx, actor, garmentId, provenance, args.url),
        },
      );
      logSuggestedPick({ logger: ctx.webLogger }, actor, saved.id, provenance);
      const suggested = (await findGarment(ctx.db, saved.id, {
        ownerId: ctx.userId,
        role: 'OWN',
      }))!;
      return {
        id: suggested.id,
        groupId: args.groupId,
        name: suggested.name,
        brand: suggested.brand,
        category: suggested.category,
        type: suggested.type,
        price: suggested.price,
        size: suggested.size,
        notices: saved.notices,
        confidence: saved.confidence,
      };
    },
  }),

  defineTool({
    name: 'suggest_outfit',
    title: 'Suggest an outfit',
    description: `WRITES: proposes an outfit to the owner, shown first on their Outfits tab with your note: closet garments and your open options (or the owner's own wishlist items), in the order worn (outer layer, top, bottom, shoes, accessories reads best). An outfit of only closet garments is welcome too. The owner loves it, saves it, or declines it with a reason; it is never planned or worn until every piece is bought. The same garments as an outfit you proposed already answer it (alreadyProposed, nothing written); as an outfit of the owner's own, or one they declined, are refused. An option set aside cannot be in one.`,
    input: z.object({
      garmentIds: z
        .array(rowId())
        .min(2)
        .max(OUTFIT_GARMENTS_MAX)
        .describe('The garments, in the order the outfit lists them.'),
      note: z
        .string()
        .trim()
        .min(1)
        .max(PICK_NOTE_MAX)
        .optional()
        .describe('One line: why it works and when to wear it.'),
      name: z.string().trim().min(1).max(OUTFIT_NAME_MAX).optional(),
    }),
    writes: true,
    // A retry answers the outfit it proposed (alreadyProposed).
    idempotent: true,
    async run({ garmentIds, note, name }, ctx) {
      const proposed = await proposeOutfitTo(
        deps(ctx),
        actorOf(ctx),
        { garmentIds, name: name ?? null },
        { tokenId: ctx.tokenId, note: note ?? null },
      );
      if ('alreadyProposed' in proposed) {
        return { id: proposed.id, alreadyProposed: proposed.alreadyProposed };
      }
      return { id: proposed.id };
    },
  }),
  defineTool({
    name: 'finish_round',
    title: 'Finish a round of suggestions',
    description: `WRITES: ends your round of suggestions, once, at the end of a conversation. The owner gets one card on Today ("<your name>: 3 outfits, 7 pieces to consider", what you proposed and suggested since your last round and they have not decided yet) and one notification on the devices where they turned rounds on. Give feedbackUntil, the \`until\` of this conversation's get_suggestion_feedback: what it told you is then not told again (what it did not, a decision made since, still is). With nothing new since your last round there is no card or notification (round: null), and feedbackUntil still ends what you read. summary is one line on the card, at most ${ROUND_SUMMARY_MAX} characters. A round you leave open is closed for you ${QUIET_PERIOD_MS / 60_000} minutes after your last suggestion or outfit, with no summary and your feedback told again.`,
    input: z.object({
      summary: z
        .string()
        .trim()
        .min(1)
        .max(ROUND_SUMMARY_MAX)
        .optional()
        .describe(
          'One line on what this round brings: "Autumn layers for the office".',
        ),
      feedbackUntil: z.iso
        .datetime({ offset: true })
        .optional()
        .describe(
          'The `until` of your get_suggestion_feedback in this conversation.',
        ),
    }),
    writes: true,
    idempotent: false,
    async run({ summary, feedbackUntil }, ctx) {
      const finished = await finishAgentRound(deps(ctx), actorOf(ctx), {
        tokenId: ctx.tokenId,
        summary: summary ?? null,
        feedbackUntil: feedbackUntil ?? null,
      });
      if (!finished.ok) {
        return { round: null, feedbackRead: feedbackUntil !== undefined };
      }
      const [notified] = await notifyRounds(ctx.push, ctx.webLogger, [
        { ...finished, ownerId: ctx.userId },
      ]);
      return {
        round: {
          id: finished.id,
          outfits: finished.outfits,
          pieces: finished.pieces,
        },
        notified,
        feedbackRead: feedbackUntil !== undefined,
      };
    },
  }),
];
