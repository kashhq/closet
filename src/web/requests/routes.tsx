import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import {
  REQUEST_BODY_SENT_MAX,
  REQUEST_SUBJECT_KINDS,
} from '../../wardrobe/agent-requests';
import { selectScalars } from '../../db/select-scalars';
import { literals } from '../api/resource';
import { agentConnectedSql } from '../auth/personal-tokens';
import { answerReplay, isReplay } from '../offline-writes';
import type { WebOptions } from '../plugin';
import { renderPage } from '../render';
import { RowId } from '../schemas';
import { safeReturnTo } from '../security/return-to';
import { actorOf } from '../sharing/access';
import { viewContext } from '../view-context';
import {
  listRequests,
  requireRequest,
  transitionRequest,
} from './request-actions';
import { RequestPage, RequestsPage } from './requests-page';
import { REQUESTS_PATH, requestUrl } from './urls';

/**
 * "Ask your agent"'s page routes (#1286; docs/plans/2026-11-27-mcp-oauth.md
 * sections 3.3 to 3.6), each one request-actions.ts call, the API's twins
 * (api-routes.ts). The asker's alone: no `?ownerId=`, anyone else's id the
 * unknown id's 404.
 *
 * - POST /requests is the ask (a native post from AskAgent, 303 to the
 *   request) and the outbox's `request` kind: a replay answers 204 with
 *   its outcome, idempotent on its `clientId`. Stored data, so a malformed
 *   ask is a 400 (a subject's kind without its id included).
 * - Withdraw and Got it are native posts, never queued (they act on a row
 *   the page may hold stale); Got it returns to `returnTo` (Today's card).
 * - The list's `?before=` is URL state: malformed is the first page.
 */

const RequestParams = Type.Object({ id: RowId });

const AskBody = Type.Object(
  {
    body: Type.String({
      minLength: 1,
      maxLength: REQUEST_BODY_SENT_MAX,
      pattern: '\\S',
    }),
    subjectKind: Type.Optional(literals(REQUEST_SUBJECT_KINDS)),
    subjectId: Type.Optional(RowId),
    // Empty without script: the outbox mints it at the tap.
    clientId: Type.Optional(
      Type.Union([Type.Literal(''), Type.String({ format: 'uuid' })]),
    ),
  },
  { dependencies: { subjectKind: ['subjectId'], subjectId: ['subjectKind'] } },
);

const SeenBody = Type.Union([
  Type.Object({ returnTo: Type.Optional(Type.String({ maxLength: 2048 })) }),
  Type.Null(),
]);

const ListQuery = Type.Object({ before: Type.Optional(Type.String()) });

/** A page of the list: what the API's list shows at once too. */
const REQUESTS_PAGE_SIZE = 20;

function parseBefore(value: string | undefined): number | undefined {
  return value !== undefined && /^[1-9]\d{0,8}$/.test(value)
    ? Number(value)
    : undefined;
}

export const requestRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, config, logger },
  done,
) => {
  const deps = { db, logger };

  /** Whether the asker has an agent to answer: the no-agent line. */
  const agentConnected = async (userId: number) =>
    (await selectScalars(db, { connected: agentConnectedSql(userId) }))
      .connected;

  app.get(
    REQUESTS_PATH,
    { schema: { querystring: ListQuery } },
    async (request, reply) => {
      const actor = actorOf(request);
      const [{ rows, more }, connected] = await Promise.all([
        listRequests(deps, actor, {
          before: parseBefore(request.query.before),
          limit: REQUESTS_PAGE_SIZE,
        }),
        agentConnected(actor.userId),
      ]);
      return renderPage(
        reply,
        <RequestsPage
          ctx={viewContext(reply)}
          rows={rows}
          before={more ? rows.at(-1)?.id : undefined}
          connected={connected}
          timeZone={config.timeZone}
          now={new Date()}
        />,
      );
    },
  );

  app.post(
    REQUESTS_PATH,
    { config: { queueable: 'request' }, schema: { body: AskBody } },
    async (request, reply) => {
      const { body, subjectKind, subjectId, clientId } = request.body;
      const asked = await transitionRequest(deps, actorOf(request), {
        kind: 'ask',
        body,
        subject:
          subjectKind !== undefined && subjectId !== undefined
            ? { kind: subjectKind, id: subjectId }
            : null,
        clientId: clientId || null,
      });
      if (isReplay(request)) return answerReplay(reply, asked.changed);
      return reply.redirect(requestUrl(asked.id), 303);
    },
  );

  app.get(
    `${REQUESTS_PATH}/:id`,
    { schema: { params: RequestParams } },
    async (request, reply) => {
      const actor = actorOf(request);
      const [row, connected] = await Promise.all([
        requireRequest(deps, actor, request.params.id),
        agentConnected(actor.userId),
      ]);
      return renderPage(
        reply,
        <RequestPage
          ctx={viewContext(reply)}
          row={row}
          connected={connected}
          timeZone={config.timeZone}
          now={new Date()}
        />,
      );
    },
  );

  app.post(
    `${REQUESTS_PATH}/:id/withdraw`,
    { schema: { params: RequestParams } },
    async (request, reply) => {
      const { id } = request.params;
      await transitionRequest(deps, actorOf(request), { kind: 'withdraw', id });
      return reply.redirect(requestUrl(id), 303);
    },
  );

  app.post(
    `${REQUESTS_PATH}/:id/seen`,
    { schema: { params: RequestParams, body: SeenBody } },
    async (request, reply) => {
      const { id } = request.params;
      await transitionRequest(deps, actorOf(request), { kind: 'seen', id });
      return reply.redirect(
        safeReturnTo(request.body?.returnTo, requestUrl(id)),
        303,
      );
    },
  );

  done();
};
