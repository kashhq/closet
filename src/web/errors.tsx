import type { FastifyReply, FastifyRequest } from 'fastify';
import { STATUS_CODES } from 'node:http';
import {
  isDatabaseUnavailable,
  isLockTimeout,
  isPoolExhausted,
} from '../db/errors';
import { driverError } from '../driver-error';
import { FRAGMENT_VARY, isFragmentRequest } from '../htmx/fragment-request';
import { hxTrigger } from '../htmx/trigger';
import { OWNER_LOCK_TIMEOUT_MS } from '../db/owner-lock';
import { t, type Translated } from './i18n';
import { ErrorPage } from './error-page';
import { loggableUrl } from './loggable-url';
import {
  type ErrorCode,
  type Problem,
  PROBLEM_CONTENT_TYPE,
  type ProblemAnswer,
} from './problem';
import type { Logger } from '../logger';
import type { ErrorTracker } from '../metrics/error-tracker';
import { renderPage } from './render';
import { safeReturnTo } from './security/return-to';
import { scrubSecrets } from '../secret-text';
import { surfaceOf } from './surface';

const CODE_OF_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: 'validation',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  // A replayed create of a row deleted since (its client id's tombstone, #196a).
  410: 'gone',
  412: 'stale',
  429: 'rate_limited',
  503: 'busy',
};

/** An unlisted 4xx (413, 415) is a request the client must change: validation. */
function codeOfStatus(status: number): ErrorCode {
  return CODE_OF_STATUS[status] ?? (status < 500 ? 'validation' : 'internal');
}

/**
 * What a plain-Fastify handler throws to answer with an error page:
 * `throw new HttpError(409)`. The message is shown on the page, so it is
 * for people (the status text by default), never internals; `logDetail` is
 * what the log line adds (ids, the operation), never shown. Any status,
 * a 5xx included (the owner lock's 503): an HttpError is an answer the code
 * chose, not a crash. `code` defaults from the status. A 404 or 403 is a
 * refusal, thrown as NotFound or Forbidden (src/web/refusals.ts) by the
 * domain function that decides it, or NotServed by the few routes that
 * answer a path as absent (guards.conf [refusals]).
 */
export class HttpError extends Error {
  readonly logDetail?: string;
  readonly code: ErrorCode;
  /** Sent as `Retry-After`: a rate limit's window, the owner lock's wait. */
  readonly retryAfterSeconds?: number;
  /**
   * The error handler writes no warn line for it: the thrower accounts for
   * the refusal itself (the bearer gate's own line or its summary, #940).
   */
  readonly quiet?: true;
  /**
   * Which fields a 400 refuses, each with its message: a problem's `errors`
   * (a JSON body the form's rules refused, #192b); a page shows the message.
   */
  readonly validation?: readonly ValidationFailure[];

  constructor(
    readonly statusCode: number,
    // The status text is the one English the server writes itself; every
    // other message is `t()` copy, which the type enforces (#734, #1094).
    message = (STATUS_CODES[statusCode] ?? 'Error') as Translated,
    options: {
      logDetail?: string;
      code?: ErrorCode;
      retryAfterSeconds?: number;
      quiet?: true;
      validation?: readonly ValidationFailure[];
    } = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.logDetail = options.logDetail;
    this.quiet = options.quiet;
    this.code = options.code ?? codeOfStatus(statusCode);
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.validation = options.validation;
  }
}

/**
 * A lock wait of a transaction holding an owner lock ran past
 * OWNER_LOCK_TIMEOUT_MS (every form of the lock sets it,
 * src/db/owner-lock.ts): a 503 asking to try again, logged with the writer
 * and, when known, the owner. Nothing was written (the transaction rolled
 * back). ownerTransaction throws it naming its writer, which the jobs that
 * defer on it (the re-plan, the quiet round's end) need; describeError
 * answers any other 55P03 (a folded lock's) as one, so every writer's wait
 * is the same 503 whichever way it took the lock.
 */
export class OwnerLockTimeout extends HttpError {
  constructor(
    readonly writer: string,
    readonly ownerId?: number,
  ) {
    super(503, t('WARDROBE_BUSY'), {
      logDetail: `${writer}${ownerId === undefined ? '' : ` for owner ${ownerId}`} waited ${OWNER_LOCK_TIMEOUT_MS} ms for a lock`,
      retryAfterSeconds: OWNER_LOCK_TIMEOUT_MS / 1000,
    });
    this.name = 'OwnerLockTimeout';
  }
}

/**
 * How long a page asks to wait when the database cannot be reached: one
 * connect timeout (SERVER_TIMEOUTS.connectMs), the soonest a retry learns
 * anything new.
 */
const DATABASE_RETRY_SECONDS = 5;

/**
 * The database could not be reached (isDatabaseUnavailable: a connection
 * the pool could not open, the server shutting down, a connection lost
 * under a query): a 503 `busy` asking to try again, never a 500. The
 * installed app answers a navigation with its cached copy instead
 * (src-sw.ts, ServerFirstPages). `logDetail` names the driver's code (an
 * errno, a SQLSTATE) or the error's class, never its message.
 */
class DatabaseUnavailable extends HttpError {
  constructor(cause: unknown) {
    super(503, t('DATABASE_UNAVAILABLE'), {
      logDetail: `database unavailable: ${driverError(cause)?.code ?? (cause instanceof Error ? cause.name : typeof cause)}`,
      retryAfterSeconds: DATABASE_RETRY_SECONDS,
    });
    this.name = 'DatabaseUnavailable';
  }
}

/**
 * Every pooled connection stayed busy past the connect timeout
 * (PoolExhausted, src/db/errors.ts): the database is answering, the pool is
 * full. A 503 `busy` like a held lock, a warn line only: no error-tracker
 * event and no outage (DatabaseOutage), so a burst of load never reads as
 * the database down.
 */
class DatabasePoolBusy extends HttpError {
  constructor() {
    super(503, t('SERVER_BUSY'), {
      logDetail: 'every database connection busy',
      retryAfterSeconds: 1,
    });
    this.name = 'DatabasePoolBusy';
  }
}

/**
 * The error handler's memory of an outage (createErrorHandler): the first
 * request an outage fails goes to the error tracker, the rest only to the
 * log, until the database answers again. createApp wires `recovered` to the
 * pool's `onAnswer` (createDb): a connection opened, or a query answered, so
 * the first success ends it even when the pool opens no connection for it;
 * one while the database is up finds no outage to end. Only an answer to
 * something begun after the outage did ends it: a query sent before and
 * answered late would otherwise end it while the database is still down,
 * and the next failure would be captured as a second outage (#842).
 * `now` is the pool's clock (performance.now(), monotonic). One per app.
 */
export class DatabaseOutage {
  private since: number | undefined;
  private failed = 0;

  constructor(
    private readonly logger: Logger,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Counts a failed request; true for the one that begins an outage. */
  failure(): boolean {
    this.failed += 1;
    if (this.since !== undefined) return false;
    this.since = this.now();
    this.logger.warn(
      'Database unavailable: requests answer busy until it is back',
    );
    return true;
  }

  /** The database answered something begun at `startedAt` (the pool's onAnswer). */
  recovered(startedAt: number): void {
    if (this.since === undefined || startedAt < this.since) return;
    this.logger.info(
      `Database reachable again after ${Math.round((this.now() - this.since) / 1000)} s; ${this.failed} request(s) answered busy`,
    );
    this.since = undefined;
    this.failed = 0;
  }
}

/**
 * Every JSON error answer's body: the status, the message people may read,
 * and the request's id (its X-Request-ID), which a user reports and which
 * finds the request's log lines and Bugsink event (observability.md).
 */
export interface ErrorBody {
  statusCode: number;
  message: string;
  request_id: string;
}

function errorBody(
  request: FastifyRequest,
  statusCode: number,
  message: string,
): ErrorBody {
  return { statusCode, message, request_id: request.id };
}

export interface ErrorAnswer {
  status: number;
  message: string;
  /** The machine word the API's problem body carries (HttpError.code). */
  code: ErrorCode;
  /** For the log line, never the answer (HttpError.logDetail). */
  logDetail?: string;
  retryAfterSeconds?: number;
  /** HttpError.quiet: answered, not logged by the handler. */
  quiet?: true;
  /** A validation's failures, each where and what (Fastify's, or an HttpError's). */
  validation?: readonly ValidationFailure[];
  /** A crash, not a chosen answer: logged with its stack. */
  unexpected: boolean;
  /**
   * The database could not be reached (DatabaseUnavailable): logged with the
   * driver's error and captured once per outage (DatabaseOutage).
   */
  databaseUnavailable?: true;
}

export interface ValidationFailure {
  /** `body/email`: the part of the request, then the JSON pointer in it. */
  path: string;
  message: string;
}

/**
 * Fastify's validation error carries ajv's failures and which part of the
 * request failed; anything else has none. Ajv's messages name the rule
 * ("must be string"), never the value sent.
 */
function validationFailures(
  error: Error & { validation?: unknown; validationContext?: unknown },
): ValidationFailure[] | undefined {
  if (!Array.isArray(error.validation)) return undefined;
  const part =
    typeof error.validationContext === 'string' ? error.validationContext : '';
  return error.validation.map((failure: unknown) => {
    const { instancePath, message, params } = failure as {
      instancePath?: unknown;
      message?: unknown;
      params?: { additionalProperty?: unknown };
    };
    // Ajv puts an undeclared key in `params`, not the path (the API's
    // closed querystring, validator.ts): name it, as every other failure.
    const extra =
      typeof params?.additionalProperty === 'string'
        ? `/${params.additionalProperty}`
        : '';
    return {
      path: `${part}${typeof instancePath === 'string' ? instancePath : ''}${extra}`,
      message: typeof message === 'string' ? message : 'is invalid',
    };
  });
}

/**
 * The message of a 4xx we did not write (body parsing, a plugin's refusal),
 * by status. Never the error's own message: Fastify's and its plugins' are
 * not ours to vouch for, and a body parser's can quote the request (a JSON
 * SyntaxError names the bytes it choked on, a password's included), which
 * would land in the page, the problem's `detail`, MCP's answer and the log.
 */
function requestRefusal(status: number): string {
  if (status === 413) return t('refusal.request.tooLarge');
  if (status === 415) return t('refusal.request.unsupportedType');
  return t('refusal.request.unreadable');
}

/** What the log line names a foreign 4xx by: its code or class, never its message. */
function errorKind(error: Error): string {
  const { code } = error as Error & { code?: unknown };
  return typeof code === 'string' ? code : error.name;
}

/**
 * A client that cut an upload off before its closing boundary. busboy raises
 * a bare Error (no statusCode, so it would be a 500) with this message, and
 * @fastify/multipart 10 passes it on; the 9.x parser ended the form quietly.
 */
function isTruncatedUpload(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === 'Unexpected end of multipart data'
  );
}

/**
 * The HttpError an error is answered as: its own, or the one a driver
 * failure we recognise stands for (a lock wait past the owner lock's
 * timeout, the database out of reach).
 */
function chosenAnswer(error: unknown): HttpError | undefined {
  if (error instanceof HttpError) return error;
  if (isTruncatedUpload(error)) {
    return new HttpError(400, t('refusal.request.unreadable'), {
      logDetail: 'truncated multipart upload',
    });
  }
  if (isLockTimeout(error)) return new OwnerLockTimeout('a write');
  if (isPoolExhausted(error)) return new DatabasePoolBusy();
  if (isDatabaseUnavailable(error)) return new DatabaseUnavailable(error);
  return undefined;
}

/**
 * Status and page message for anything a route or tool throws: an HttpError
 * keeps its status and message (we wrote them); a schema validation failure
 * its 400 and ajv's message, which names the rule and the field, never the
 * value; any other 4xx (a failed body parse, an oversized upload) its status
 * and a fixed message (requestRefusal), its code in the log line; a lock
 * wait past the owner lock's timeout (55P03) OwnerLockTimeout's 503; a
 * full pool DatabasePoolBusy's 503; the database out of reach
 * DatabaseUnavailable's 503; everything else is an
 * unexpected 500 without detail.
 */
export function describeError(error: unknown): ErrorAnswer {
  const chosen = chosenAnswer(error);
  if (chosen) {
    return {
      status: chosen.statusCode,
      message: chosen.message,
      code: chosen.code,
      logDetail: chosen.logDetail,
      retryAfterSeconds: chosen.retryAfterSeconds,
      quiet: chosen.quiet,
      validation: chosen.validation,
      unexpected: false,
      ...(chosen instanceof DatabaseUnavailable && {
        databaseUnavailable: true,
      }),
    };
  }
  if (error instanceof Error) {
    const { statusCode } = error as Error & { statusCode?: unknown };
    if (
      typeof statusCode === 'number' &&
      statusCode >= 400 &&
      statusCode < 500
    ) {
      const validation = validationFailures(error);
      return {
        status: statusCode,
        message: validation ? error.message : requestRefusal(statusCode),
        code: codeOfStatus(statusCode),
        logDetail: validation ? undefined : errorKind(error),
        validation,
        unexpected: false,
      };
    }
  }
  return {
    status: 500,
    message: t('refusal.INTERNAL'),
    code: 'internal',
    unexpected: true,
  };
}

/**
 * The problem body of an error answer. `about:blank` (RFC 9457 4.2.1): the
 * status says what kind of problem it is, so `title` is the status text.
 * A 500 carries no detail: what failed is in the log, under `requestId`.
 */
function problemOf(
  request: Pick<FastifyRequest, 'id'>,
  answer: ProblemAnswer,
): Problem {
  return {
    type: 'about:blank',
    title: STATUS_CODES[answer.status] ?? 'Error',
    status: answer.status,
    ...(answer.status < 500 ? { detail: answer.message } : {}),
    code: answer.code,
    requestId: request.id,
    ...(answer.validation ? { errors: [...answer.validation] } : {}),
  };
}

/**
 * Answers `reply` with the problem; a rate limit or a busy wardrobe says
 * when to retry. A 401's WWW-Authenticate is the error handler's (its
 * bearer branch, for /mcp and /api alike), never set here.
 */
export function sendProblem(
  request: Pick<FastifyRequest, 'id'>,
  reply: FastifyReply,
  answer: ProblemAnswer,
): FastifyReply {
  if (answer.retryAfterSeconds !== undefined) {
    reply.header('Retry-After', String(Math.ceil(answer.retryAfterSeconds)));
  }
  return reply
    .status(answer.status)
    .type(PROBLEM_CONTENT_TYPE)
    .send(problemOf(request, answer));
}

/**
 * The htmx event a fragment request's failure raises on the element that
 * asked (HX-Trigger), which public/js/request-failures.js toasts. That
 * plain script spells the name itself, so the two change together.
 */
export const REQUEST_FAILED_EVENT = 'closet:request-failed';

/** The event's detail: what the toast says, and the id a report quotes. */
interface RequestFailure {
  message: string;
  requestId: string;
}

/** The `HX-Trigger` header naming a failure (ASCII-escaped: hxTrigger). */
function failureTrigger(failure: RequestFailure): string {
  return hxTrigger(REQUEST_FAILED_EVENT, failure);
}

/**
 * What a toast says of a failure: our message (an HttpError's, the 500's
 * fixed one), never the error's own text. A schema validation's message is
 * ajv's ("body/condition must be equal to one of the allowed values"),
 * kept on the error page beside its path but not a sentence for a toast.
 */
function failureMessage(error: unknown, answer: ErrorAnswer): string {
  return answer.validation && !(error instanceof HttpError)
    ? t('refusal.request.invalid')
    : answer.message;
}

/**
 * Where "Try again" goes: the request's own URL, only when it is a GET
 * (a reload repeats it; a failed write is not repeated by following a
 * link) that carries no secret: not a `secretPath` route, nothing
 * scrubSecrets would filter from its query. `safeReturnTo` keeps the href a
 * path of this site whatever the client sent as its target.
 */
function retryHref(request: FastifyRequest): string | undefined {
  if (request.method !== 'GET') return undefined;
  if (request.routeOptions.config?.secretPath === true) return undefined;
  if (scrubSecrets(request.url) !== request.url) return undefined;
  return safeReturnTo(request.url, '') || undefined;
}

/**
 * The app's error handler (set at the root by createApp(), so every route,
 * the not-found handler, the rate limiter's 429 and the owner lock's 503
 * share it): the one owner of how a failure reaches the person, by the
 * kind of request (#642). On the API surface a problem body
 * (src/web/problem.ts). To an htmx fragment request (isFragmentRequest:
 * not boosted, not a history restore) no body, and the failure as an
 * `HX-Trigger` event (failureTrigger) that public/js/request-failures.js
 * toasts: htmx swaps no 4xx or 5xx into a fragment's target, and a page
 * there would be wrong anyway. Elsewhere (a navigation, a boosted tap,
 * which that module swaps in whole) the error page, in the layout, with
 * the status of the failure. The login redirect and 401 never reach it,
 * requireSession answers those itself.
 *
 * Only an unexpected error (the 500) goes to the error tracker (#117).
 * An HttpError is an answer the code chose, whatever its status: a 4xx
 * refusal, and the owner lock's 503 (OwnerLockTimeout), which asks the
 * person to try again while another write holds their wardrobe. That 503
 * is contention working as designed; what stalled the other writer (a
 * statement or idle-in-transaction timeout) fails its own request with an
 * unexpected error, which is captured there. The 503s themselves stay in
 * the warn line and the request metric's 5xx.
 *
 * The database out of reach (DatabaseUnavailable) is between the two: a
 * warn line with the driver's error, and one event per outage, not one per
 * request (`outage`, #643): a NAS reboot was a Bugsink event for every tap.
 */
export function createErrorHandler(
  logger: Logger,
  errors: ErrorTracker,
  outage: DatabaseOutage,
) {
  function capture(error: unknown, request: FastifyRequest): void {
    errors.captureException(error, {
      source: 'route',
      tags: {
        route: request.routeOptions.url ?? 'unmatched',
        method: request.method,
      },
      userId: request.auth?.user.id ?? request.accessToken?.user.id,
    });
  }

  /** The 500 with its stack, to the tracker too; a chosen answer a warn line. */
  function report(
    error: unknown,
    request: FastifyRequest,
    answer: ErrorAnswer,
    url: string,
  ): void {
    const { status, message, logDetail, unexpected } = answer;
    if (unexpected) {
      logger.error({ err: error }, `${request.method} ${url} -> ${status}`);
      capture(error, request);
      return;
    }
    if (answer.quiet) return;
    const line = `${request.method} ${url} -> ${status}: ${message}${logDetail ? ` (${logDetail})` : ''}`;
    if (answer.databaseUnavailable) {
      logger.warn({ err: error }, line);
      if (outage.failure()) capture(error, request);
      return;
    }
    logger.warn(line);
  }

  return async function handleError(
    error: unknown,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> {
    const answer = describeError(error);
    const { status, message } = answer;
    const url = loggableUrl(request);
    report(error, request, answer, url);

    if (reply.sent) {
      logger.warn(`${url}: response already sent, no error page`);
      return;
    }
    // A rate limit, a busy wardrobe, the database out of reach: said to the
    // page, the toast and the problem alike.
    if (answer.retryAfterSeconds !== undefined) {
      reply.header('Retry-After', String(Math.ceil(answer.retryAfterSeconds)));
    }
    const surface = surfaceOf(request);
    // A bearer surface's 401 names the scheme to retry with (RFC 6750: sign
    // in again, or a new agent token), the one place it is set: the bearer
    // gate's refusals and the API sign-in's wrong password alike.
    if (status === 401 && surface !== 'page') {
      reply.header('WWW-Authenticate', 'Bearer realm="closet"');
    }
    // The API answers problem+json whatever failed, an unmatched path
    // included (surfaceOf), and never has a page context.
    if (surface === 'api') {
      return sendProblem(request, reply, answer);
    }
    // Decided by the request's htmx headers: a cache keeps the two apart.
    reply.header('Vary', FRAGMENT_VARY);
    if (isFragmentRequest(request.headers)) {
      return reply
        .status(status)
        .header(
          'HX-Trigger',
          failureTrigger({
            message: failureMessage(error, answer),
            requestId: request.id,
          }),
        )
        .send();
    }
    // No page context: a static path (the root hook skips those; their
    // routes, /file/**, /health/* and /manifest.json, answer data), or a
    // failure before the root preValidation hook ran, such as an unparsable
    // body. Data, then.
    if (!reply.locals) {
      return reply.status(status).send(errorBody(request, status, message));
    }
    return renderPage(
      reply,
      <ErrorPage
        ctx={reply.locals}
        status={status}
        message={message}
        path={request.url}
        retryHref={retryHref(request)}
        requestId={request.id}
      />,
      { status },
    );
  };
}
