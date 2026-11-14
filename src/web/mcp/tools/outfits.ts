import * as z from 'zod';
import { LIST_LIMIT_MAX, type Projection, project } from '../../api/resource';
import { DEFAULT_OCCASION } from '../../../wardrobe/occasions';
import { planOutfit } from '../../calendar/entry-actions';
import { replaceEntryOutfit } from '../../calendar/replace';
import { newOutfitSlots } from '../../outfits/gone-garments';
import { requireOutfit } from '../../outfits/outfit-actions';
import {
  type CreateResult,
  createOutfit,
  listOutfitsPage,
  OUTFIT_GARMENTS_MAX,
  OUTFIT_NAME_MAX,
  OUTFIT_NOTES_MAX,
  type ToolOutfit,
} from '../../outfits/queries';
import { OUTFIT_PAGE_SIZE } from '../../outfits/page-size';
import {
  OutfitGarmentResource,
  OutfitListItem,
  outfitListRecord,
  type OutfitGarmentRecord,
  type OutfitListRecord,
} from '../../outfits/outfit-resource';
import { actorOf, defineTool, originOf } from '../tool';
import { isoDate, occasionInput, rowId } from './common';

/**
 * The outfit resources as an agent reads them (#711): the API's records
 * (outfit-resource.ts), nulls kept; no photo URLs (an agent cannot fetch a
 * signed /file URL), and `agent` the agent's bare name, as every tool's.
 * Also a trip outfit's and a calendar entry's garments.
 */
export const OUTFIT_GARMENT_FOR_MCP = {
  id: 'keep',
  name: 'keep',
  category: 'keep',
  role: 'keep',
  status: 'keep',
  thumbUrl: 'omit',
  // Read only by the outfit page and the calendar; null elsewhere, which
  // an agent would read as "in the closet".
  away: 'omit',
} as const satisfies Projection<OutfitGarmentRecord>;

export const OUTFIT_FOR_MCP = {
  id: 'keep',
  name: 'keep',
  notes: 'keep',
  // Who made it (#659): person, agent, or a one-off (idea, planner).
  origin: 'keep',
  garments: 'own',
  // Incomplete (#335): the pieces to buy first, by id and name.
  toBuy: 'own',
  // One of Muse's proposals (#335): its note and the owner's reaction.
  proposal: 'keep',
  agent: 'own',
} as const satisfies Projection<OutfitListRecord>;

export function outfitGarmentForAgent(garment: OutfitGarmentRecord) {
  return project(garment, OutfitGarmentResource, OUTFIT_GARMENT_FOR_MCP, {});
}

function outfitForAgent(outfit: ToolOutfit) {
  const record = outfitListRecord(outfit);
  return project(record, OutfitListItem, OUTFIT_FOR_MCP, {
    garments: record.garments.map(outfitGarmentForAgent),
    toBuy: record.garments
      .filter((garment) => record.toBuy.includes(garment.id))
      .map(({ id, name }) => ({ id, name })),
    agent: record.agent?.name ?? null,
  });
}

/** create_outfit's log line: the outfit made, or the one its garments already were. */
function createdMessage(
  userId: number,
  saved: CreateResult,
  plan: { day: string; occasion: string } | undefined,
): string {
  const what = saved.alreadySaved
    ? `Outfit ${saved.id} of the same garments reused`
    : `Outfit ${saved.id} created (${saved.slots} slots)`;
  const planned = plan
    ? `, ${saved.schedule} ${plan.day} (${plan.occasion})`
    : '';
  const adopted = saved.adopted ? '; taken over from the week planner' : '';
  return `${what} by user ${userId} (MCP)${planned}${adopted}`;
}

/**
 * Outfits and the calendar are private (src/web/outfits): these tools read
 * and write the caller's own, whatever wardrobes are shared with them, and
 * take no ownerId.
 */
export const outfitTools = [
  defineTool({
    name: 'list_outfits',
    title: 'List my outfits',
    description: `Your own saved outfits, newest first (not the outfits your agent proposed that you have not saved), each with its garments in the order it was built, ${OUTFIT_PAGE_SIZE} a page unless \`limit\` asks: pass the answer's \`next\` (null on the last page) back as \`before\` for the next. toBuy lists the garments it holds that are not bought yet (wishlist items): an outfit with any is incomplete, and cannot be planned, added to a trip or worn until they are bought.`,
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
          `How many a page holds: ${OUTFIT_PAGE_SIZE} unless asked, at most ${LIST_LIMIT_MAX}.`,
        ),
    }),
    writes: false,
    async run({ before, limit = OUTFIT_PAGE_SIZE }, ctx) {
      // GET /api/v1/outfits' reader and page size (#660), so the two page alike.
      const { outfits, next } = await listOutfitsPage(ctx.db, ctx.userId, {
        before,
        limit,
        proposed: false,
      });
      return { outfits: outfits.map(outfitForAgent), next };
    },
  }),

  defineTool({
    name: 'get_outfit',
    title: 'Get an outfit',
    description:
      'One of your outfits: its name, notes and garments, proposal (when your agent proposed it: its note, your reaction, your note and reason) and toBuy: its garments not bought yet (an incomplete outfit cannot be planned, added to a trip or worn).',
    input: z.object({ id: rowId().describe('The outfit id.') }),
    writes: false,
    async run({ id }, ctx) {
      return outfitForAgent(await requireOutfit(ctx.db, actorOf(ctx), id));
    },
  }),

  defineTool({
    name: 'create_outfit',
    title: 'Create an outfit',
    description:
      'WRITES: saves a new outfit of your own garments, in the order given (outer layer, top, bottom, shoes, accessories reads best), optionally planned on a day as schedule_outfit would. Garments must be in your own wardrobe (clone a shared one first in the app): nothing is saved if any is not. Wishlist items may be in it: the outfit is then incomplete, and cannot be planned (a scheduleDate is refused, nothing saved) until they are bought. If you already have an outfit of exactly these garments it is the answer (alreadySaved: true, its own name and notes kept, nothing created), planned when a date is given, so a retry creates nothing.',
    input: z.object({
      garmentIds: z
        .array(rowId())
        .min(1)
        .max(OUTFIT_GARMENTS_MAX)
        .describe('Your garments, in the order the outfit lists them.'),
      name: z.string().trim().max(OUTFIT_NAME_MAX).optional(),
      notes: z.string().max(OUTFIT_NOTES_MAX).optional(),
      scheduleDate: isoDate()
        .optional()
        .describe('Also plan it on this day (YYYY-MM-DD).'),
      occasion: occasionInput,
    }),
    writes: true,
    // createOutfit reuses an outfit of the same garments: a retry creates nothing.
    idempotent: true,
    async run({ garmentIds, name, notes, scheduleDate, occasion }, ctx) {
      // A new outfit holds wishlist items too (#335: incomplete);
      // createOutfit checks again as it writes, and refuses planning one.
      const slots = await newOutfitSlots(
        ctx.db,
        ctx.userId,
        garmentIds,
        'wardrobe',
      );
      const plan = scheduleDate
        ? { day: scheduleDate, occasion: occasion ?? DEFAULT_OCCASION }
        : undefined;
      const saved = await createOutfit(ctx.db, ctx.userId, {
        name: name || null,
        notes: notes?.trim() ? notes : null,
        slots,
        plan,
        origin: 'agent',
        madeBy: originOf(ctx),
      });
      ctx.webLogger.info(createdMessage(ctx.userId, saved, plan));
      return {
        id: saved.id,
        name: saved.name,
        alreadySaved: saved.alreadySaved,
        scheduled: plan ?? null,
      };
    },
  }),

  defineTool({
    name: 'schedule_outfit',
    title: 'Plan an outfit on a day',
    description:
      "WRITES: plans one of your outfits on a calendar day, for an occasion (the part of the day). A day can hold several outfits (office, then dinner); the same outfit is on a day once, so planning it again changes nothing and it keeps the occasion it has (returned); a new entry is your agent's (plannedBy agent), and one Plan my week made becomes it. With replaceEntryId (an entry id from get_calendar or get_today, on that date): changes that entry's outfit instead of adding one, keeping its day and occasion (occasion, if given, must be the entry's); it becomes your agent's choice (plannedBy agent, with your token's name), an outfit Plan my week created for it and nothing else uses is removed, and a selfie of it stays on the day as a look. Refused, with nothing changed, when the entry is marked worn (it is the record of that day: add another outfit instead), the outfit is already on that day, or it is incomplete (toBuy in list_outfits: buy those first). To put an idea from suggest_outfits there, save it first with pick_outfit (no date). Safe to retry.",
    input: z.object({
      outfitId: rowId(),
      date: isoDate().describe('The day, YYYY-MM-DD.'),
      occasion: occasionInput,
      replaceEntryId: rowId()
        .optional()
        .describe(
          'A calendar entry of yours on that date whose outfit this one replaces.',
        ),
    }),
    writes: true,
    idempotent: true,
    async run({ outfitId, date, occasion, replaceEntryId }, ctx) {
      if (replaceEntryId !== undefined) {
        const target = { entryId: replaceEntryId, day: date, occasion };
        const replaced = await replaceEntryOutfit(
          { db: ctx.db, logger: ctx.webLogger },
          actorOf(ctx),
          target,
          { outfitId },
          originOf(ctx),
        );
        return {
          outcome: replaced.outcome,
          date,
          occasion: replaced.occasion,
          entryId: replaced.entryId,
          previousOutfitId: replaced.previousOutfitId,
          selfieKeptAsLook: replaced.selfieDetached !== undefined,
          plannerOutfitRemoved: replaced.outfitsRemoved > 0,
        };
      }
      const scheduled = await planOutfit(
        { db: ctx.db, logger: ctx.webLogger },
        actorOf(ctx),
        { outfitId, day: date, occasion: occasion ?? DEFAULT_OCCASION },
        originOf(ctx),
      );
      // Already there: the occasion it kept.
      const { outcome, occasion: kept } = scheduled;
      return { outcome, date, occasion: kept };
    },
  }),
];
