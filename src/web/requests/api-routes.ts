import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { apiResponses } from '../api/contract';
import type { ApiOptions } from '../api/plugin';
import { idCursor, ListCursor, ListLimit, readIdCursor } from '../api/resource';
import { RowId } from '../schemas';
import { actorOf } from '../sharing/access';
import { API_PREFIX } from '../surface';
import {
  listRequests,
  requireRequest,
  transitionRequest,
} from './request-actions';
import {
  AgentRequestOutcome,
  AgentRequestCreated,
  AgentRequestList,
  AgentRequestResource,
  NewAgentRequest,
  toAgentRequestResource,
} from './request-resource';

/** A page of the requests list: what the Requests page (#1286) shows at once. */
const REQUEST_PAGE_SIZE = 20;

const RequestParams = Type.Object({ id: RowId });

const RequestListQuery = Type.Object({
  cursor: Type.Optional(ListCursor),
  limit: ListLimit(REQUEST_PAGE_SIZE),
});

const REQUESTS_PATH = '/agent-requests';
const REQUEST_PATH = `${REQUESTS_PATH}/:id`;

const TAGS = ['agent requests'];

/**
 * "Ask your agent" on /api/v1 (#681 B1; plan section 3.7), each route one
 * request-actions.ts call: the asker's side. The agent's claim and answer
 * are MCP's alone (#1287). A request is the token's user's own: no
 * `?ownerId=`, and anyone else's id is the 404 of an unknown one. The
 * logs name the request, never its body or answer.
 */
export const requestApiRoutes: FastifyPluginCallbackTypebox<ApiOptions> = (
  app,
  { db, logger },
  done,
) => {
  app.get(
    REQUESTS_PATH,
    {
      schema: {
        operationId: 'listAgentRequests',
        tags: TAGS,
        summary: 'Your requests to your agent, newest first',
        description:
          'Every request you asked, whatever its status: open, claimed by one of your agent tokens, answered or withdrawn.',
        querystring: RequestListQuery,
        response: apiResponses({ 200: AgentRequestList }),
      },
    },
    async (request) => {
      const { cursor, limit = REQUEST_PAGE_SIZE } = request.query;
      const { rows, more } = await listRequests({ db }, actorOf(request), {
        before: cursor === undefined ? undefined : readIdCursor(cursor),
        limit,
      });
      const last = rows.at(-1);
      return {
        data: rows.map(toAgentRequestResource),
        pagination: {
          ...(more && last && { nextCursor: idCursor(last.id) }),
          limit,
        },
      };
    },
  );

  app.post(
    REQUESTS_PATH,
    {
      schema: {
        operationId: 'createAgentRequest',
        tags: TAGS,
        summary: 'Asks your agent for something',
        description:
          'Waits `open` until one of your agent tokens connects over MCP, claims it and answers it; it is asked whether or not an agent is connected now. A `subject` you cannot see is the 404 of its kind. 201 with its `Location`. With a `clientId`, a retry answers the first request of that id (200, its `Location`) and creates nothing.',
        body: NewAgentRequest,
        response: apiResponses({
          200: AgentRequestCreated,
          201: AgentRequestCreated,
        }),
      },
    },
    async (request, reply) => {
      const { body, subject, clientId } = request.body;
      const asked = await transitionRequest({ db, logger }, actorOf(request), {
        kind: 'ask',
        body: body.trim(),
        subject: subject ?? null,
        clientId: clientId ?? null,
      });
      return reply
        .status(asked.changed ? 201 : 200)
        .header('Location', `${API_PREFIX}${REQUESTS_PATH}/${asked.id}`)
        .send({ id: asked.id });
    },
  );

  app.get(
    REQUEST_PATH,
    {
      schema: {
        operationId: 'getAgentRequest',
        tags: TAGS,
        summary: 'One of your requests to your agent',
        params: RequestParams,
        response: apiResponses({ 200: AgentRequestResource }),
      },
    },
    async (request) =>
      toAgentRequestResource(
        await requireRequest({ db }, actorOf(request), request.params.id),
      ),
  );

  app.post(
    `${REQUEST_PATH}/withdraw`,
    {
      schema: {
        operationId: 'withdrawAgentRequest',
        tags: TAGS,
        summary: 'Takes a request back',
        description:
          'An open or claimed request is `withdrawn`, and an agent answering it after is refused. Set-state: one withdrawn already answers `changed: false`; an answered one is a 409.',
        params: RequestParams,
        response: apiResponses({ 200: AgentRequestOutcome }),
      },
    },
    async (request) =>
      transitionRequest({ db, logger }, actorOf(request), {
        kind: 'withdraw',
        id: request.params.id,
      }),
  );

  app.post(
    `${REQUEST_PATH}/seen`,
    {
      schema: {
        operationId: 'markAgentRequestSeen',
        tags: TAGS,
        summary: 'Says you read the answer ("Got it")',
        description:
          'Stamps `answerSeenAt` on an answered request. Set-state: one seen already answers `changed: false`; one not answered yet is a 409.',
        params: RequestParams,
        response: apiResponses({ 200: AgentRequestOutcome }),
      },
    },
    async (request) =>
      transitionRequest({ db, logger }, actorOf(request), {
        kind: 'seen',
        id: request.params.id,
      }),
  );

  done();
};
