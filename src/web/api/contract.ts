import { type TSchema, Type } from '@sinclair/typebox';
import type { RouteOptions } from 'fastify';
import { Problem, PROBLEM_CONTENT_TYPE } from '../problem';
import { isOperationId } from './operations';

declare module 'fastify' {
  // What an /api/v1 route declares for its OpenAPI operation (#190): the
  // keys @fastify/swagger reads, spelled as its own augmentation spells them
  // (it is a devDependency: scripts/api-spec.ts), so the two merge.
  interface FastifySchema {
    operationId?: string;
    tags?: readonly string[];
    summary?: string;
    description?: string;
    security?: ReadonlyArray<{ [securityLabel: string]: readonly string[] }>;
    /**
     * A multipart route's parts, for the spec only (scripts/api-spec.ts
     * makes it the operation's multipart/form-data body). Fastify never
     * reads it: the handler reads the parts (request.files()), and a
     * `body` schema would validate the unparsed body as null.
     */
    multipartBody?: TSchema;
  }
}

/** The OpenAPI security scheme every non-public route names. */
export const DEVICE_TOKEN_SCHEME = 'deviceToken';

/**
 * Every 4xx and 5xx of every route: the problem body, as the content type
 * sendProblem answers with, so Fastify serializes it through the schema.
 * A reference to the one Problem apiPlugin adds (`addSchema`), so the spec
 * names it once, as a component a generated client gets a type for.
 */
const PROBLEM_RESPONSE = {
  description: 'A problem (RFC 9457): switch on `code`',
  content: { [PROBLEM_CONTENT_TYPE]: { schema: Type.Ref(Problem) } },
} as const;

/**
 * A route's `response`: its success schemas (each with a `description`,
 * the spec's), and the problem for every 4xx and 5xx (src/web/problem.ts).
 * Fastify serializes through them, so a column a mapper leaks is dropped,
 * and the spec documents them.
 */
export function apiResponses<Success extends Record<number, TSchema>>(
  success: Success,
): Success & {
  '4xx': typeof PROBLEM_RESPONSE;
  '5xx': typeof PROBLEM_RESPONSE;
} {
  return { ...success, '4xx': PROBLEM_RESPONSE, '5xx': PROBLEM_RESPONSE };
}

/**
 * What every /api/v1 route must declare, checked as it registers (apiPlugin's
 * onRoute), so a route without its contract stops the boot instead of
 * shipping undocumented: an operationId listed in OPERATIONS (operations.ts,
 * the parity manifest), tags, a 2xx schema and the problem for 4xx and 5xx
 * (apiResponses). The drift test (scripts/api-spec.spec.ts)
 * checks the generated spec the same way.
 */
function contractGaps(route: Pick<RouteOptions, 'schema'>): string[] {
  const { schema } = route;
  const gaps: string[] = [];
  if (!schema?.operationId) gaps.push('operationId');
  else if (!isOperationId(schema.operationId)) {
    gaps.push(`operationId in OPERATIONS (${schema.operationId})`);
  }
  if (!schema?.tags?.length) gaps.push('tags');
  return [...gaps, ...responseGaps(schema?.response)];
}

function responseGaps(response: unknown): string[] {
  const responses =
    typeof response === 'object' && response !== null
      ? (response as Record<string, unknown>)
      : {};
  const gaps: string[] = [];
  if (!Object.keys(responses).some((status) => /^2\d\d$/.test(status))) {
    gaps.push('a 2xx response schema');
  }
  if (
    responses['4xx'] !== PROBLEM_RESPONSE ||
    responses['5xx'] !== PROBLEM_RESPONSE
  ) {
    gaps.push('the Problem for 4xx and 5xx (apiResponses)');
  }
  return gaps;
}

export function requireContract(route: RouteOptions): void {
  const gaps = contractGaps(route);
  if (gaps.length > 0) {
    throw new Error(
      `${String(route.method)} ${route.url} declares no ${gaps.join(', ')}`,
    );
  }
}
