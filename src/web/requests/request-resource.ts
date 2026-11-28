import { type Static, Type } from '@sinclair/typebox';
import {
  REQUEST_BODY_MAX,
  REQUEST_BODY_SENT_MAX,
  REQUEST_STATUSES,
  REQUEST_SUBJECT_KINDS,
  type RequestSubject,
} from '../../wardrobe/agent-requests';
import { asResource, ListOf, literals } from '../api/resource';
import { RowId } from '../schemas';
import { AgentResource, toAgentResource } from '../write-origin';
import type { AgentRequestRow, SyncedAgentRequestRow } from './queries';

/**
 * The API's agent request resources and inputs (#681 B1; docs/plans/
 * 2026-11-27-mcp-oauth.md section 3.7), mapped from request-actions.ts'
 * reads: camelCase, null fields left out, instants as ISO strings. The
 * records keep their nulls for MCP's tools to project (#1287).
 */

const SUBJECT_DESCRIPTION =
  'What it is about: one of your garments or a garment of a wardrobe shared with you, one of your trips, or one of your wishlist needs';

export const AgentRequestSubject = Type.Object(
  {
    kind: literals(REQUEST_SUBJECT_KINDS),
    id: Type.Integer(),
  },
  { title: 'AgentRequestSubject', description: SUBJECT_DESCRIPTION },
);

const RequestStatusSchema = literals(REQUEST_STATUSES, {
  description:
    '`open` until one of your agent tokens claims it (`claimed`, held 30 minutes, then free for another agent), then `answered`; `withdrawn` once you take it back',
});

export const AgentRequestResource = Type.Object(
  {
    id: Type.Integer(),
    clientId: Type.Optional(
      Type.String({ format: 'uuid', description: 'Your id for its create' }),
    ),
    body: Type.String({ description: 'What you asked, trimmed' }),
    status: RequestStatusSchema,
    subject: Type.Optional(AgentRequestSubject),
    claimedBy: Type.Optional(AgentResource),
    claimedAt: Type.Optional(Type.String({ format: 'date-time' })),
    answer: Type.Optional(
      Type.String({ description: "The agent's reply, as it wrote it" }),
    ),
    answeredBy: Type.Optional(AgentResource),
    answeredAt: Type.Optional(Type.String({ format: 'date-time' })),
    answerSeenAt: Type.Optional(
      Type.String({
        format: 'date-time',
        description: 'When you said Got it',
      }),
    ),
    withdrawnAt: Type.Optional(Type.String({ format: 'date-time' })),
    createdAt: Type.String({ format: 'date-time' }),
  },
  {
    title: 'AgentRequest',
    description:
      'Something you asked your agent: any of your agent tokens finds it over MCP, claims it and answers it. `subject` is absent with none or once you no longer see it (a share ended, the garment deleted); `claimedBy` names the agent working on it only while `claimed`, `answeredBy` the one that answered',
  },
);

const iso = (at: Date | null): string | null => at?.toISOString() ?? null;

/** One request, nulls kept: the API's AgentRequest. */
export function agentRequestRecord(row: AgentRequestRow) {
  return {
    id: row.id,
    clientId: row.clientId,
    body: row.body,
    status: row.status,
    subject: row.subject,
    claimedBy:
      row.status === 'claimed'
        ? (toAgentResource(row.claimedBy) ?? null)
        : null,
    claimedAt: iso(row.claimedAt),
    answer: row.answer,
    answeredBy: toAgentResource(row.answeredBy) ?? null,
    answeredAt: iso(row.answeredAt),
    answerSeenAt: iso(row.answerSeenAt),
    withdrawnAt: iso(row.withdrawnAt),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toAgentRequestResource(
  row: AgentRequestRow,
): Static<typeof AgentRequestResource> {
  return asResource(AgentRequestResource, agentRequestRecord(row));
}

export const AgentRequestList = ListOf(AgentRequestResource, {
  title: 'AgentRequestList',
  description: 'A page of your requests to your agent, newest first',
});

export const NewAgentRequest = Type.Object(
  {
    body: Type.String({
      minLength: 1,
      maxLength: REQUEST_BODY_SENT_MAX,
      pattern: '\\S',
      description: `What you ask, in your words, up to ${REQUEST_BODY_MAX} characters; stored trimmed, its line breaks as LF`,
    }),
    subject: Type.Optional(
      Type.Object(
        { kind: literals(REQUEST_SUBJECT_KINDS), id: RowId },
        {
          description: `${SUBJECT_DESCRIPTION}. One you cannot see is the 404 of its kind`,
        },
      ),
    ),
    clientId: Type.Optional(
      Type.String({
        format: 'uuid',
        description:
          'Your id for this create, for retrying it offline: a retry answers the first request of that id (200)',
      }),
    ),
  },
  { title: 'NewAgentRequest' },
);

export const AgentRequestCreated = Type.Object(
  { id: Type.Integer() },
  { title: 'AgentRequestCreated' },
);

export const AgentRequestOutcome = Type.Object(
  {
    id: Type.Integer(),
    status: RequestStatusSchema,
    changed: Type.Boolean({
      description: 'False when it was there already (withdrawn, or seen)',
    }),
  },
  {
    title: 'AgentRequestOutcome',
    description: 'Where the request is after the call',
  },
);

/**
 * The changes feed's request (#196b): as stored, its subject the one it
 * was asked about (the feed's garments say whether it is still there and
 * seen) and no agent names (a token's rename moves no request's revision:
 * the client asks GET /agent-requests/{id} for them).
 */
export const SyncedAgentRequest = Type.Object(
  {
    id: Type.Integer(),
    body: Type.String(),
    status: RequestStatusSchema,
    subject: Type.Optional(AgentRequestSubject),
    claimedAt: Type.Optional(Type.String({ format: 'date-time' })),
    answer: Type.Optional(Type.String()),
    answeredAt: Type.Optional(Type.String({ format: 'date-time' })),
    answerSeenAt: Type.Optional(Type.String({ format: 'date-time' })),
    withdrawnAt: Type.Optional(Type.String({ format: 'date-time' })),
    createdAt: Type.String({ format: 'date-time' }),
  },
  {
    title: 'SyncedAgentRequest',
    description: 'Something you asked your agent, as stored',
  },
);

function storedSubject(row: SyncedAgentRequestRow): RequestSubject | null {
  if (row.garmentId !== null) return { kind: 'garment', id: row.garmentId };
  if (row.tripId !== null) return { kind: 'trip', id: row.tripId };
  if (row.optionGroupId !== null) {
    return { kind: 'need', id: row.optionGroupId };
  }
  return null;
}

export function toSyncedAgentRequest(
  row: SyncedAgentRequestRow,
): Static<typeof SyncedAgentRequest> {
  return asResource(SyncedAgentRequest, {
    id: row.id,
    body: row.body,
    status: row.status,
    subject: storedSubject(row),
    claimedAt: iso(row.claimedAt),
    answer: row.answer,
    answeredAt: iso(row.answeredAt),
    answerSeenAt: iso(row.answerSeenAt),
    withdrawnAt: iso(row.withdrawnAt),
    createdAt: row.createdAt.toISOString(),
  });
}
