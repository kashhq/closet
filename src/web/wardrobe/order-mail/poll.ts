import type { Db } from '../../../db/client';
import type { Logger } from '../../../logger';
import { todayIn } from '../../../calendar-date';
import { isDatabaseUnavailable, isPoolExhausted } from '../../../db/errors';
import { driverError } from '../../../driver-error';
import { endWhole, PartialFailure } from '../../../metrics/partial-failure';
import {
  ORDER_MAIL_ATTEMPTS,
  ORDER_MAIL_MAILBOX_STRIKES,
  type OrderEmailFailureScope,
} from '../../../wardrobe/order-items';
import {
  type OutboundFetcher,
  OutboundFetchError,
} from '../../security/outbound-fetch';
import type { ExtractedProduct } from '../link-import/extract';
import { readProductPage } from '../link-import/import';
import {
  type EmailEnvelope,
  type JmapClient,
  JmapError,
  type JmapMailbox,
} from './jmap';
import { emailLinks, isProductLink, normalizedLink } from './links';
import {
  type FoundProduct,
  type MailboxEmail,
  parkGoneEmails,
  pollStart,
  processedEmailIds,
  recordOrderEmail,
  recordOrderEmailFailure,
} from './queries';
import type { OrderMailOwnerWatch } from './owner-watch';
import { judgeSender } from './trust';

/**
 * One poll of the order mail account (#25; plan
 * docs/plans/2026-09-28-order-email-import.md): the inbox's new emails,
 * each judged by its sender (trust.ts), its links judged before any fetch
 * (links.ts: product paths and known trackers only, #698) and each one's
 * page through the link import's reader (readProductPage: the user URL
 * fetcher, SSRF-safe, bounded, every redirect a product link), and the
 * products it names listed for
 * ORDER_MAIL_OWNER's account to review. Run by server.ts's timer through
 * pollOrderMailWhole inside metrics.timeJob('order_mail'), so a failure
 * (JMAP unreachable or refusing, a failing email) counts
 * as the job's.
 *
 * Each email gets its own outcome (#693). A decided one is recorded once
 * its links were read, in one transaction with its items
 * (recordOrderEmail). One whose read fails is a `failed` row, read again
 * by the next poll (the watermark starts at it) and parked after
 * ORDER_MAIL_ATTEMPTS; the poll goes on to the next email. A failure
 * that is not the email's (JMAP unreachable, the database out of reach:
 * failureScope's `outage`) fails the run and touches no row; its own
 * message's fetch answering a 5xx or a wrong shape is a strike on its row,
 * and ORDER_MAIL_MAILBOX_STRIKES in a row spend one attempt. A link that fails to fetch is skipped (the fetcher logs
 * its host and reason).
 */

/** At most this many emails are read a poll; the rest wait for the next. */
export const MAX_EMAILS_PER_POLL = 5;
/** At most this many products are kept from one email. */
export const MAX_ITEMS_PER_EMAIL = 10;
/** An email's links are fetched this many at a time. */
const LINK_CONCURRENCY = 3;
/** An error kind is a SQLSTATE or a name; anything longer is clipped. */
const ERROR_KIND_MAX = 64;

export interface OrderMailDeps {
  db: Db;
  jmap: JmapClient;
  /** The app's fetcher of user-supplied URLs: every link of an email. */
  fetcher: OutboundFetcher;
  /** ORDER_MAIL_SENDERS, lower case. */
  senders: readonly string[];
  /** ORDER_MAIL_OWNER's account, resolved once at boot (createApp, #706). */
  ownerId: number;
  /** Set once that account is deleted: the poll then does nothing (#706). */
  ownerWatch: OrderMailOwnerWatch;
  /** APP_TIMEZONE: which day an email arrived. */
  timeZone: string;
  logger: Logger;
}

export interface PollSummary {
  queried: number;
  read: number;
  listed: number;
  /** The account's emails still failing after the run. */
  failing: number;
  /** Emails whose first attempt this run spent: each is captured once, here. */
  firstFailures: number;
  /** Emails this run parked: out of attempts, or gone from the inbox. */
  parked: number;
}

/**
 * The scheduled run (server.ts): pollOrderMail, then a PartialFailure while
 * any email is failing, so the job is `failure` on every poll until the
 * email is decided or parked (#693). It is captured only by the run that
 * spent an email's first attempt, so one email is one event, not one a
 * poll (`reported`).
 */
export async function pollOrderMailWhole(
  deps: OrderMailDeps,
): Promise<PollSummary> {
  const run = await pollOrderMail(deps);
  return endWhole('order_mail', { failing: run.failing }, run, {
    reported: run.firstFailures === 0,
  });
}

const NOTHING_POLLED: PollSummary = {
  queried: 0,
  read: 0,
  listed: 0,
  failing: 0,
  firstFailures: 0,
  parked: 0,
};

export async function pollOrderMail(deps: OrderMailDeps): Promise<PollSummary> {
  const { db, logger } = deps;
  if (deps.ownerWatch.missing) return NOTHING_POLLED;
  const started = performance.now();
  const mailbox = await deps.jmap.open();
  // The owner check and the watermark in one statement, so the JMAP session
  // comes first (#173: the watermark needs its account id). A deleted owner
  // ends the run before anything is read or written, and every later one
  // before the session: one error, the degraded readiness check (#706).
  const { ownerId } = deps;
  const start = await pollStart(db, ownerId, mailbox.accountId);
  const { watermark } = start;
  if (!start.ownerExists) {
    deps.ownerWatch.markMissing('poll');
    return NOTHING_POLLED;
  }
  const ids = await mailbox.inboxIds(watermark);
  const failing = new Set(start.failing.map(({ emailId }) => emailId));
  // A failing email at the watermark is the query's first (its `after` is
  // inclusive): absent, it left the inbox, and would pin the watermark for
  // good. A newer one absent may only be past the query's limit.
  const inbox = new Set(ids);
  const gone = start.failing
    .filter(
      ({ emailId, receivedAt }) =>
        receivedAt.getTime() === watermark?.getTime() && !inbox.has(emailId),
    )
    .map(({ emailId }) => emailId);
  let parked = await parkGoneEmails(db, mailbox.accountId, gone);
  for (const id of gone) {
    failing.delete(id);
    logger.warn(`Order mail ${id} parked: no longer in the inbox`);
  }
  const processed = await processedEmailIds(db, mailbox.accountId, ids);
  const fresh = ids
    .filter((id) => !processed.has(id))
    .slice(0, MAX_EMAILS_PER_POLL);
  let listed = 0;
  let firstFailures = 0;
  for (const envelope of await mailbox.envelopes(fresh)) {
    try {
      listed += await readEmail(deps, mailbox, envelope, ownerId);
      failing.delete(envelope.id);
    } catch (error) {
      const failure = await recordFailure(deps, mailbox, envelope, error).catch(
        (stopped: unknown) => {
          // The run ends here; an email this run failed first is reported in
          // the same event, or no later run would (theirs is not the first).
          if (firstFailures === 0) throw stopped;
          throw new PartialFailure(
            'order_mail',
            { failing: failing.size, 'stopped by a mailbox failure': 1 },
            { cause: stopped },
          );
        },
      );
      if (failure.first) firstFailures += 1;
      if (failure.status === 'parked') {
        parked += 1;
        failing.delete(envelope.id);
      } else if (failure.status === 'failed') {
        failing.add(envelope.id);
      }
    }
  }
  logger.info(
    `Order mail poll: ${ids.length} queried, ${fresh.length} new read, ${listed} products listed for user ${ownerId}, ${failing.size} failing, ${parked} parked in ${Math.round(performance.now() - started)} ms`,
  );
  return {
    queried: ids.length,
    read: fresh.length,
    listed,
    failing: failing.size,
    firstFailures,
    parked,
  };
}

/**
 * Records `error`, a failed read of `envelope`, on its row and says what it
 * came to; rethrows a mailbox failure that spent no attempt, which ends the
 * run (a strike is on the row first). `first`: this read took the
 * email's attempts from 0 to 1.
 */
async function recordFailure(
  deps: OrderMailDeps,
  mailbox: JmapMailbox,
  envelope: EmailEnvelope,
  error: unknown,
): Promise<{ status: 'failed' | 'parked' | 'settled'; first: boolean }> {
  const { logger } = deps;
  const scope = failureScope(error);
  if (scope === 'outage') throw error;
  const kind = errorKind(error);
  const email: MailboxEmail = {
    accountId: mailbox.accountId,
    emailId: envelope.id,
    receivedAt: envelope.receivedAt,
  };
  const read = await recordOrderEmailFailure(deps.db, email, scope, kind);
  // A strike resets to 0 when it spends an attempt; an email failure
  // always spends one.
  const spent = read !== undefined && read.mailboxFailures === 0;
  if (scope === 'message' && !spent) {
    if (read) {
      logger.warn(
        `Order mail ${envelope.id}: mailbox failure ${read.mailboxFailures} of ${ORDER_MAIL_MAILBOX_STRIKES} while reading it (${kind})`,
      );
    }
    throw error;
  }
  if (read === undefined) {
    logger.info(
      `Order mail ${envelope.id} failed (${kind}) after another run settled it`,
    );
    return { status: 'settled', first: false };
  }
  if (read.status === 'parked') {
    logger.error(
      { err: error },
      `Order mail ${envelope.id} parked after ${read.attempts} failed attempts (${kind})`,
    );
  } else {
    logger.error(
      { err: error },
      `Order mail ${envelope.id} failed (${kind}): attempt ${read.attempts} of ${ORDER_MAIL_ATTEMPTS}, read again next poll`,
    );
  }
  return { status: read.status, first: read.attempts === 1 };
}

/**
 * Statements the database refused for its own state, not the email's
 * values: a statement or lock timeout, a serialization failure, a deadlock.
 */
const TRANSIENT_SQLSTATES = new Set(['57014', '55P03', '40001', '40P01']);

/**
 * Whose failure a read was; the one place the strike rule lives (see
 * OrderEmailFailureScope). A JMAP failure says (JmapError.scope). The
 * database out of reach, its pool full or a transient refusal are the
 * outage's, never an email's, or an incident would park the inbox.
 * Anything else came of the email's content (a value a column refuses, a
 * bug of ours on its data).
 */
export function failureScope(error: unknown): OrderEmailFailureScope {
  if (error instanceof JmapError) return error.scope;
  const code = driverError(error)?.code;
  const transient =
    isDatabaseUnavailable(error) ||
    isPoolExhausted(error) ||
    (code !== undefined && TRANSIENT_SQLSTATES.has(code));
  return transient ? 'outage' : 'email';
}

/**
 * What `order_email.error_kind` keeps of a failure: the driver's code (a
 * SQLSTATE such as 22003, numeric overflow) or the error's name, never its
 * message, which can quote the page's or the email's text.
 */
function errorKind(error: unknown): string {
  const code = driverError(error)?.code;
  const kind = code ?? (error instanceof Error ? error.name : 'unknown');
  return kind.slice(0, ERROR_KIND_MAX);
}

/** Reads and records one email; how many products it listed. */
async function readEmail(
  deps: OrderMailDeps,
  mailbox: JmapMailbox,
  envelope: EmailEnvelope,
  ownerId: number,
): Promise<number> {
  const { db, logger } = deps;
  const record = (
    outcome: 'imported' | 'no-products' | 'untrusted' | 'too-large',
    products: readonly FoundProduct[] = [],
  ) =>
    recordOrderEmail(
      db,
      {
        accountId: mailbox.accountId,
        emailId: envelope.id,
        receivedAt: envelope.receivedAt,
        outcome,
      },
      ownerId,
      todayIn(deps.timeZone, envelope.receivedAt),
      products,
    );

  const verdict = judgeSender(envelope, deps.senders);
  if (!verdict.trusted) {
    logger.warn(
      `Order mail ${envelope.id} ignored: untrusted (${verdict.reason}, from ${verdict.domain ?? 'no domain'})`,
    );
    await record('untrusted');
    return 0;
  }
  const body = await mailbox.body(envelope.id);
  if (body.kind === 'gone') {
    logger.info(`Order mail ${envelope.id} was removed before it was read`);
    // A failing email that left the inbox is parked, or it pins the
    // watermark; a new one has no row to park.
    await parkGoneEmails(db, mailbox.accountId, [envelope.id]);
    return 0;
  }
  if (body.kind === 'too-large') {
    logger.warn(`Order mail ${envelope.id} ignored: too large to read`);
    await record('too-large');
    return 0;
  }
  const { links, skipped } = emailLinks(body.parts);
  const products = await readProducts(deps.fetcher, links);
  const listed = await record(
    products.length > 0 ? 'imported' : 'no-products',
    products,
  );
  logger.info(
    `Order mail ${envelope.id}: ${links.length} links read, ${skipped} skipped, ${products.length} products found, ${listed} listed for user ${ownerId}`,
  );
  return listed;
}

/**
 * The products behind `links`, LINK_CONCURRENCY fetches at a time, each
 * page once (two links that land on one page count once), in the links'
 * order, at most MAX_ITEMS_PER_EMAIL. A link refused or failing is skipped.
 */
async function readProducts(
  fetcher: OutboundFetcher,
  links: readonly string[],
): Promise<FoundProduct[]> {
  const found: (FoundProduct | undefined)[] = [];
  let next = 0;
  const worker = async () => {
    while (next < links.length) {
      const index = next++;
      found[index] = await readProduct(fetcher, links[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(LINK_CONCURRENCY, links.length) }, worker),
  );
  const seen = new Set<string>();
  return found
    .filter((product): product is FoundProduct => {
      if (!product || seen.has(product.productUrl)) return false;
      seen.add(product.productUrl);
      return true;
    })
    .slice(0, MAX_ITEMS_PER_EMAIL);
}

async function readProduct(
  fetcher: OutboundFetcher,
  link: string,
): Promise<FoundProduct | undefined> {
  try {
    // Every redirect must be a product link before it is requested (#698).
    const { product, url } = await readProductPage(
      fetcher,
      link,
      isProductLink,
    );
    if (!isProductLink(url) || !isProduct(product)) return undefined;
    return {
      productUrl: normalizedLink(url),
      name: product.name,
      brand: product.brand,
      price: product.price?.amount ?? null,
      currency: product.price?.currency ?? null,
    };
  } catch (error) {
    // The fetcher logged the refusal with its hosts. Anything else fails
    // the email (pollOrderMail records it), never the run.
    if (error instanceof OutboundFetchError) return undefined;
    throw error;
  }
}

/**
 * A product page: schema.org Product data, or a stated price. An email's
 * other links (a store's category pages, its blog) have neither, and its
 * page title alone would list them.
 */
function isProduct(product: ExtractedProduct): boolean {
  return product.source === 'json-ld' || product.price !== null;
}
