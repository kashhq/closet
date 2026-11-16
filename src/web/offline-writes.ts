import type {
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';
import type { IsoDate } from '../calendar-date';
import type { Logger } from '../logger';
import {
  dayRefusal,
  instantOnDay,
  isReplayRequest,
  OUTCOME_HEADER,
  type QueueableKind,
  REPLAY_HEADER,
  type ReplayRefusal,
  type TapInstant,
  tapInstant,
} from '../offline-writes';
import { sessionUserId } from './auth/require-session';
import { HttpError } from './errors';
import { t } from './i18n';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * The installed app may queue this write offline and replay it (#178):
     * the account check below runs on it, and its handler answers a replay
     * `answerReplay`'s 204. The kind is one of src/offline-writes.ts's
     * QUEUEABLE_ROUTES, whose pattern must be this route's
     * (queued-writes.spec.ts).
     */
    queueable?: QueueableKind;
  }
}

/**
 * The replay contract of the queued writes (#178, plan section 4), shared
 * by the five queueable routes (wears, the calendar's worn, trips' packing
 * ticks). Nothing here is stored: the writes are set-state or guarded by a
 * unique index, so replaying one twice is a no-op by meaning, and the key
 * exists for the logs (json-api plan section 2, the same model).
 *
 * - `X-Closet-Queued: <user id>` marks a replay, naming the account that
 *   queued it. A replay for another account than the session's is a 409
 *   `account`, nothing written (the outbox keeps records per account; this
 *   is the guard if that ever fails).
 * - `Idempotency-Key: <record id>`: logged (8 characters), never stored.
 * - A replay is answered 204 with `X-Closet-Outcome: changed | unchanged`,
 *   not the page or fragment a tap gets; a refusal keeps its status (404
 *   gone, 409 refused) and, for a 409 of this contract, names its reason in
 *   the same header.
 */
const QUEUED_HEADER = REPLAY_HEADER.toLowerCase();
const IDEMPOTENCY_HEADER = 'idempotency-key';

function refusalMessage(refusal: ReplayRefusal): string {
  switch (refusal) {
    case 'too-old':
      return t('refusal.replay.tooOld');
    case 'future':
      return t('refusal.replay.future');
    case 'account':
      return t('refusal.replay.account');
  }
}

/** A replay, as the queued-write hook has let it through. */
export function isReplay(request: FastifyRequest): boolean {
  return isReplayRequest(request.headers);
}

/** A replay's answer: whether this request changed anything. */
export function answerReplay(
  reply: FastifyReply,
  changed: boolean,
): FastifyReply {
  return reply
    .status(204)
    .header(OUTCOME_HEADER, changed ? 'changed' : 'unchanged')
    .send();
}

/**
 * The 409 of this contract to throw, with its reason in `X-Closet-Outcome`
 * (the error handler keeps the reply's headers), so the outbox can say why
 * a write was not saved. A tap gets the same 409 page as before.
 */
export function replayRefused(
  reply: FastifyReply,
  reason: ReplayRefusal,
  options: { message?: string; logDetail?: string } = {},
): HttpError {
  reply.header(OUTCOME_HEADER, reason);
  return new HttpError(409, options.message ?? refusalMessage(reason), {
    logDetail: options.logDetail,
  });
}

/**
 * The day a wear or wash is for: the posted one (the tap's, from a replay)
 * within the window, else today. Throws the 409 for a day outside it.
 */
export function requestedDay(
  reply: FastifyReply,
  posted: IsoDate | undefined,
  today: IsoDate,
): IsoDate {
  if (posted === undefined) return today;
  const refusal = dayRefusal(posted, today);
  if (refusal)
    throw replayRefused(reply, refusal, { logDetail: `day ${posted}` });
  return posted;
}

/**
 * The request's tap (#676, tapInstant): its posted `at` (a replay's, an API
 * client's) judged against the server's clock; without one, now for a live
 * request and unknown (null) for a replay.
 */
export function requestTap(
  request: FastifyRequest,
  posted: string | undefined,
  timeZone: string,
): TapInstant | null {
  return tapInstant(
    posted === undefined ? undefined : new Date(posted),
    isReplay(request),
    new Date(),
    timeZone,
  );
}

/**
 * The instant a wear or wash on `day` is stored with (#676): the request's
 * tap when it falls on `day`, else null, the day rule (instantOnDay).
 */
export function postedInstant(
  request: FastifyRequest,
  posted: string | undefined,
  day: IsoDate,
  timeZone: string,
): Date | null {
  return instantOnDay(requestTap(request, posted, timeZone), day);
}

/**
 * The API's day check (wears' api-routes.ts): the same window and words as
 * requestedDay, for a day every API wear and wash sends, but a plain 409
 * without `X-Closet-Outcome`, which is the page outbox's contract.
 */
export function dayOutsideWindow(
  day: IsoDate,
  today: IsoDate,
): HttpError | undefined {
  const refusal = dayRefusal(day, today);
  return (
    refusal &&
    new HttpError(409, refusalMessage(refusal), { logDetail: `day ${day}` })
  );
}

/**
 * The API's 409 for a write whose day only the writer knew was ahead (a
 * calendar entry's own day, PUT /calendar-entries/{id}/worn): the window's
 * words for a day to come.
 */
export function dayAheadRefusal(logDetail: string): HttpError {
  return new HttpError(409, refusalMessage('future'), { logDetail });
}

/**
 * What a queueable write's log line adds: ` (replayed, key 1a2b3c4d)`, or
 * the key alone for a live tap that sent one, or nothing. The key is a
 * client's header, so only its first characters of [A-Za-z0-9-] are
 * written.
 */
export function replayNote(request: FastifyRequest): string {
  const key = request.headers[IDEMPOTENCY_HEADER];
  const shown =
    typeof key === 'string'
      ? key.replace(/[^A-Za-z0-9-]/g, '').slice(0, 8)
      : '';
  const parts = [
    ...(isReplay(request) ? ['replayed'] : []),
    ...(shown ? [`key ${shown}`] : []),
  ];
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/** Queued writes createQueuedWriteHook let through, for createQueuedReplayLog. */
const acceptedReplays = new WeakSet<FastifyRequest>();

/**
 * The account check, a root preHandler (createApp): after the web
 * plugin's session gate, which is preValidation, so a replay without a
 * session is the gate's 401 as before, and after validation, so a
 * malformed one is its 400. Only on a route marked `queueable` that a
 * replay reached; nothing is read. A replay it lets through is marked, and
 * createQueuedReplayLog notes it once the handler has answered.
 */
export function createQueuedWriteHook(logger: Logger) {
  return function checkQueuedAccount(
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ): void {
    const kind = request.routeOptions.config.queueable;
    const account = request.headers[QUEUED_HEADER];
    if (kind === undefined || account === undefined) return done();
    const userId = sessionUserId(request);
    if (account === String(userId)) {
      acceptedReplays.add(request);
      return done();
    }
    const named =
      typeof account === 'string' && /^\d{1,10}$/.test(account)
        ? `account ${account}`
        : 'a malformed account';
    logger.warn(
      `Queued ${kind} for ${named} refused: signed in as user ${userId}${replayNote(request)}`,
    );
    done(replayRefused(reply, 'account'));
  };
}

/**
 * The one note that a queued write was replayed (root onResponse): written
 * only once the handler answered below 400, so a replay the handler then
 * refused (a day ahead's 409, a 404) is not logged as replayed. The
 * action's own line (logOp) knows nothing of requests; request_id joins the
 * two, and no handler adds `replayNote` to its success line.
 */
export function createQueuedReplayLog(logger: Logger) {
  return function noteQueuedReplay(
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ): void {
    if (acceptedReplays.has(request) && reply.statusCode < 400) {
      logger.info(
        `Queued ${request.routeOptions.config.queueable} replayed for user ${sessionUserId(request)}${replayNote(request)}`,
      );
    }
    done();
  };
}
