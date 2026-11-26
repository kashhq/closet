import { Type, type Static } from '@sinclair/typebox';

/**
 * The API's error answer (#190): RFC 9457 `application/problem+json`
 * (docs/plans/2026-11-12-json-api.md section 2). A client switches on
 * `code`; `detail` is the message a page shows for the same refusal;
 * `requestId` finds the request's log lines and its error event. Every
 * /api/v1 route declares this for its 4xx and 5xx (src/web/api/contract.ts),
 * so Fastify serializes through it and the spec documents it; errors.tsx
 * builds and sends it (problemOf, sendProblem).
 */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * The stable machine word of a refusal, which a JSON client switches on
 * (plan section 2): HttpError.code, defaulted from the status (errors.tsx).
 */
const ERROR_CODES = [
  'validation',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'gone',
  // A changes cursor past what the feed still holds (sync_floor, #196b):
  // sync in full.
  'cursor_expired',
  'stale',
  'rate_limited',
  'busy',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** What an answer needs to become a problem (errors.tsx's ErrorAnswer is one). */
export interface ProblemAnswer {
  status: number;
  message: string;
  code: ErrorCode;
  validation?: readonly { path: string; message: string }[];
  retryAfterSeconds?: number;
}

export const Problem = Type.Object(
  {
    type: Type.Literal('about:blank'),
    title: Type.String(),
    status: Type.Integer({ minimum: 400, maximum: 599 }),
    detail: Type.Optional(Type.String()),
    code: Type.Union(ERROR_CODES.map((code) => Type.Literal(code))),
    requestId: Type.String(),
    errors: Type.Optional(
      Type.Array(Type.Object({ path: Type.String(), message: Type.String() })),
    ),
  },
  { $id: 'Problem', title: 'Problem' },
);
export type Problem = Static<typeof Problem>;
