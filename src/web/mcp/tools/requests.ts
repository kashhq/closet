import * as z from 'zod';
import { todayIn } from '../../../calendar-date';
import { REQUEST_ANSWER_MAX } from '../../../wardrobe/agent-requests';
import { project } from '../../api/resource';
import { needsOf, type AgentRequestRow } from '../../requests/queries';
import {
  listClaimableRequests,
  transitionRequest,
} from '../../requests/request-actions';
import { listTrips } from '../../trips/queries';
import { TripListItem, tripListRecord } from '../../trips/trip-resource';
import {
  GarmentListItem,
  garmentListRecord,
} from '../../wardrobe/garment-resource';
import { findGarment } from '../../wardrobe/queries';
import { actorOf, defineTool, type ToolContext } from '../tool';
import { rowId } from './common';
import { GARMENT_SUMMARY_FOR_MCP } from './garments';
import { needOut } from './suggestions';
import { TRIP_LIST_ITEM_FOR_MCP } from './trips';

/**
 * "Ask your agent" (#681 B3; src/web/requests/AGENTS.md, docs/plans/
 * 2026-11-27-mcp-oauth.md section 3.5): the asker's own requests, found,
 * claimed and answered by their token through transitionRequest, the one
 * writer the pages' and the API's moves share. No SQL of a tool's own.
 */

/** list_agent_requests' cap: the oldest twenty; the rest wait for the next call. */
const LIST_LIMIT = 20;

/** A garment subject as search_garments' hit; the request's own join proved the asker sees it, so it is read as a VIEW. */
async function garmentSubject(ctx: ToolContext, row: AgentRequestRow) {
  const garment = await findGarment(ctx.db, row.subject!.id, {
    ownerId: row.subjectOwnerId!,
    role: 'VIEW',
  });
  return (
    garment &&
    project(
      garmentListRecord(garment, ctx.cutouts.enabled),
      GarmentListItem,
      GARMENT_SUMMARY_FOR_MCP,
      {},
    )
  );
}

/**
 * Each request's subject as its resource's own mapper answers it: a garment
 * as search_garments' hit, a trip as list_trips' row, a need as
 * list_suggestions' need. A request with none, or whose subject the asker
 * no longer sees (readRequests judged that), has no entry.
 */
async function subjectsForAgent(
  ctx: ToolContext,
  rows: readonly AgentRequestRow[],
): Promise<Map<number, object>> {
  const today = todayIn(ctx.timeZone, new Date());
  const idsOf = (kind: 'trip' | 'need') =>
    rows.flatMap((row) => (row.subject?.kind === kind ? [row.subject.id] : []));
  const needIds = idsOf('need');
  const [trips, needs] = await Promise.all([
    idsOf('trip').length > 0 ? listTrips(ctx.db, ctx.userId, today) : [],
    needIds.length > 0 ? needsOf(ctx.db, ctx.userId, needIds) : [],
  ]);
  const subjects = new Map<number, object>();
  for (const row of rows) {
    const { subject } = row;
    if (!subject) continue;
    switch (subject.kind) {
      case 'garment': {
        const garment = await garmentSubject(ctx, row);
        if (garment) subjects.set(row.id, garment);
        break;
      }
      case 'trip': {
        const trip = trips.find((candidate) => candidate.id === subject.id);
        if (trip) {
          const record = tripListRecord(trip, today);
          subjects.set(
            row.id,
            project(record, TripListItem, TRIP_LIST_ITEM_FOR_MCP, {
              outfits: record.outfitCount,
              extras: record.extraCount,
            }),
          );
        }
        break;
      }
      case 'need': {
        const need = needs.find((candidate) => candidate.id === subject.id);
        if (need) subjects.set(row.id, needOut(need));
        break;
      }
    }
  }
  return subjects;
}

const deps = (ctx: ToolContext) => ({ db: ctx.db, logger: ctx.webLogger });

export const requestTools = [
  defineTool({
    name: 'list_agent_requests',
    title: 'List requests to my agent',
    description: `What the owner asked of you in the app ("Ask your agent"): the open requests, the ones this token holds, and those whose 30-minute claim ran out, oldest first, at most ${LIST_LIMIT}. Each has id, body (what they asked), createdAt, status (open or claimed), claimedByYou, and subject: the garment (as search_garments answers one), trip (as list_trips) or need (as list_suggestions) it is about, null when none. Call this first in every conversation. Claiming and answering need a token that can make changes; with a read-only token you can read the requests but not claim them, so ask the owner to connect a token that can make changes.`,
    input: z.object({}),
    writes: false,
    async run(_args, ctx) {
      const rows = await listClaimableRequests(
        deps(ctx),
        actorOf(ctx),
        ctx.tokenId,
        LIST_LIMIT,
      );
      const subjects = await subjectsForAgent(ctx, rows);
      return {
        requests: rows.map((row) => ({
          id: row.id,
          body: row.body,
          createdAt: row.createdAt.toISOString(),
          status: row.status,
          subject:
            row.subject && subjects.has(row.id)
              ? { kind: row.subject.kind, ...subjects.get(row.id) }
              : null,
          claimedByYou:
            row.status === 'claimed' && row.claimedByTokenId === ctx.tokenId,
        })),
      };
    },
  }),

  defineTool({
    name: 'claim_agent_request',
    title: 'Claim a request',
    description:
      'WRITES: claims one of list_agent_requests before you work on it, so no other agent does: held for 30 minutes, then free again (claiming again renews it). Answers the request id, its status and whether this call changed it. Refused with the reason when another agent holds it, when it is answered, or when the owner withdrew it.',
    input: z.object({
      id: rowId().describe('The request, from list_agent_requests.'),
    }),
    writes: true,
    idempotent: true,
    run: ({ id }, ctx) =>
      transitionRequest(deps(ctx), actorOf(ctx), {
        kind: 'claim',
        id,
        tokenId: ctx.tokenId,
      }),
  }),

  defineTool({
    name: 'answer_agent_request',
    title: 'Answer a request',
    description: `WRITES: answers a request once the work is done, in one or two sentences saying what you did (up to ${REQUEST_ANSWER_MAX} characters); the owner is told and reads it with your name. Works on a request you hold or an open one. Refused with the reason when it is already answered, another agent took it, or the owner withdrew it. A suggestion round is separate: finish_round still ends it.`,
    input: z.object({
      id: rowId().describe('The request, from list_agent_requests.'),
      answer: z
        .string()
        .trim()
        .min(1)
        .max(REQUEST_ANSWER_MAX)
        .describe('What you did, in one or two sentences.'),
    }),
    writes: true,
    run: ({ id, answer }, ctx) =>
      transitionRequest(deps(ctx), actorOf(ctx), {
        kind: 'answer',
        id,
        tokenId: ctx.tokenId,
        answer,
      }),
  }),
];
