import { and, desc, eq, inArray, ne, type SQL, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../../../db/client';
import { orderEmail, orderItem, user } from '../../../db/schema';
import { selectScalars } from '../../../db/select-scalars';
import type { IsoDate } from '../../../calendar-date';
import {
  ORDER_MAIL_ATTEMPTS,
  ORDER_MAIL_MAILBOX_STRIKES,
  type OrderEmailFailureScope,
  type OrderEmailOutcome,
  type OrderEmailStatus,
  type OrderItemEvent,
  orderItemTransition,
} from '../../../wardrobe/order-items';

/**
 * The order mail's rows (#25; src/db/schema.ts, order_email and
 * order_item). An email's row is written by the poll only: its outcome
 * (recordOrderEmail), a failed read (recordOrderEmailFailure) or parking
 * one that left the inbox (parkGoneEmails, #693). An item has one writer
 * each: recordOrderEmail, and an item's
 * one move out of pending through decideOrderItem (the review list's
 * dismissal, and the garment save's `added` inside its own transaction).
 * Every read of an item names its owner, so another user's id is a 404.
 */

/**
 * ORDER_MAIL_OWNER's account id, read once at boot (createApp, #706): the
 * routes, the menu and the poll compare ids from then on, so an email
 * change or another account taking the address moves nothing. `ownerEmail`
 * must already be normalized, as findUserByEmail's is; only the id is
 * read, never the password hash that lookup carries.
 */
export async function orderMailOwnerId(
  db: Db,
  ownerEmail: string,
): Promise<number | undefined> {
  const [row] = await db
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) = ${ownerEmail}`)
    .limit(1);
  return row?.id;
}

/** What a poll starts from (pollStart). */
export interface PollStart {
  /** The boot's owner account still exists (it may be deleted since). */
  ownerExists: boolean;
  /**
   * The next query's `after` (inclusive): the oldest failing email's
   * arrival, so it is read again, else the newest settled one's (#693).
   */
  watermark: Date | undefined;
  /** The account's failing emails (`status = 'failed'`), oldest first. */
  failing: { emailId: string; receivedAt: Date }[];
}

/**
 * Whether the owner's account still exists, the account's watermark and
 * its failing emails, in one statement (#173: a poll was a statement for
 * each).
 */
export async function pollStart(
  db: Db,
  ownerId: number,
  accountId: string,
): Promise<PollStart> {
  const { ownerExists, newest, failing } = await selectScalars(db, {
    ownerExists: sql<boolean>`exists(
      select 1 from ${user} where ${user.id} = ${ownerId}
    )`,
    // As JSON: an ISO string, which Date reads (the raw row's timestamptz
    // text is not ISO).
    newest: sql<string | null>`(
      select to_json(coalesce(
        min(${orderEmail.receivedAt}) filter (where ${orderEmail.status} = 'failed'),
        max(${orderEmail.receivedAt})
      )) from ${orderEmail}
      where ${orderEmail.accountId} = ${accountId}
    )`,
    failing: sql<{ emailId: string; receivedAt: string }[]>`(
      select coalesce(json_agg(
        json_build_object('emailId', ${orderEmail.emailId}, 'receivedAt', ${orderEmail.receivedAt})
        order by ${orderEmail.receivedAt}
      ), '[]'::json)
      from ${orderEmail}
      where ${orderEmail.accountId} = ${accountId}
        and ${orderEmail.status} = 'failed'
    )`,
  });
  return {
    ownerExists,
    watermark: newest === null ? undefined : new Date(newest),
    failing: failing.map(({ emailId, receivedAt }) => ({
      emailId,
      receivedAt: new Date(receivedAt),
    })),
  };
}

/**
 * Which of `emailIds` the account's emails are settled: decided or parked.
 * A failing one is read again.
 */
export async function processedEmailIds(
  db: Db,
  accountId: string,
  emailIds: readonly string[],
): Promise<Set<string>> {
  if (emailIds.length === 0) return new Set();
  const rows = await db
    .select({ emailId: orderEmail.emailId })
    .from(orderEmail)
    .where(
      and(
        eq(orderEmail.accountId, accountId),
        inArray(orderEmail.emailId, [...emailIds]),
        ne(orderEmail.status, 'failed'),
      ),
    );
  return new Set(rows.map((row) => row.emailId));
}

/** A product the poll found, as the review list stores it. */
export interface FoundProduct {
  productUrl: string;
  name: string | null;
  brand: string | null;
  price: string | null;
  currency: string | null;
}

/** An email as the poll addresses its row. */
export interface MailboxEmail {
  accountId: string;
  emailId: string;
  receivedAt: Date;
}

export interface ProcessedEmail extends MailboxEmail {
  outcome: OrderEmailOutcome;
}

/**
 * Records one email as processed with the products it listed for
 * `ownerId`, atomically. A product the owner has listed before (pending,
 * added or dismissed) is skipped, so a confirmation and a shipping email
 * name it once; `imported` becomes `no-products` when every product was
 * such a repeat. How many were listed; 0 too when another run settled the
 * email first (an overlapping deploy).
 *
 * Every outcome takes a `failed` row to `decided` through this one guarded
 * upsert (insertEmail): a failing email that succeeds on a retry, however
 * it ends, stops pinning the watermark. A decided or parked row is never
 * touched again.
 *
 * An email without products (untrusted, too large, none found) is one
 * insert. With products, one transaction of four statements (#173; it was
 * five): the email and its items in one statement (the items' insert reads
 * the email's new id from a CTE, and inserts nothing when the email was
 * recorded already), then the email's count and outcome, which only the
 * items' insert can tell.
 */
export async function recordOrderEmail(
  db: Db,
  email: ProcessedEmail,
  ownerId: number,
  orderedOn: IsoDate,
  products: readonly FoundProduct[],
): Promise<number> {
  const insertEmail = (tx: Queryable, outcome: OrderEmailOutcome) =>
    tx
      .insert(orderEmail)
      .values({ ...email, outcome, items: 0 })
      .onConflictDoUpdate({
        target: [orderEmail.accountId, orderEmail.emailId],
        set: {
          outcome,
          items: 0,
          status: 'decided',
          errorKind: null,
          mailboxFailures: 0,
          processedAt: sql`now()`,
        },
        where: eq(orderEmail.status, 'failed'),
      })
      .returning({ id: orderEmail.id });
  if (products.length === 0) {
    // Nothing listed: an `imported` email with no products is `no-products`.
    await insertEmail(
      db,
      email.outcome === 'imported' ? 'no-products' : email.outcome,
    );
    return 0;
  }
  return db.transaction(async (tx) => {
    const found = products.map(
      (product) =>
        sql`(${product.productUrl}::text, ${product.name}::text, ${product.brand}::text, ${product.price}::numeric, ${product.currency}::varchar)`,
    );
    const { rows } = await tx.execute<{
      emailId: number | null;
      listed: number;
    }>(sql`
      with email as (${insertEmail(tx, email.outcome).getSQL()}),
      listed as (
        insert into ${orderItem}
          (owner_id, order_email_id, product_url, name, brand, price, currency, ordered_on)
        select ${ownerId}::int, email.id, found.product_url, found.name,
          found.brand, found.price, found.currency, ${orderedOn}::date
        from email,
          (values ${sql.join(found, sql`, `)})
            as found(product_url, name, brand, price, currency)
        on conflict do nothing
        returning 1
      )
      select (select id from email) as "emailId",
        (select count(*)::int from listed) as listed`);
    const [{ emailId, listed }] = rows;
    if (emailId === null) return 0;
    if (email.outcome === 'imported') {
      await tx
        .update(orderEmail)
        .set({
          items: listed,
          outcome: listed > 0 ? 'imported' : 'no-products',
        })
        .where(eq(orderEmail.id, emailId));
    }
    return listed;
  });
}

/** A failed read's row after it was recorded. */
export interface FailedRead {
  status: Exclude<OrderEmailStatus, 'decided'>;
  attempts: number;
  mailboxFailures: number;
}

/**
 * Records a failed read of `email` (#693, #932): an `email` failure spends
 * one attempt; a `message` one counts a strike, and ORDER_MAIL_MAILBOX_STRIKES
 * in a row spend one too. An `outage` is never recorded (poll.ts). ORDER_MAIL_ATTEMPTS attempts park it. One upsert,
 * guarded like the outcome's: undefined when another run settled the email
 * meanwhile. `errorKind` is a kind, never an error's text.
 *
 * Runs on `db`, never inside the transaction recordOrderEmail rolled back
 * for this email: in there it would be rolled back too, and the count
 * would never move.
 */
export async function recordOrderEmailFailure(
  db: Db,
  email: MailboxEmail,
  scope: Exclude<OrderEmailFailureScope, 'outage'>,
  errorKind: string,
): Promise<FailedRead | undefined> {
  const zero = sql`0`;
  const first = failedRead(scope, { attempts: zero, mailboxFailures: zero });
  const next = failedRead(scope, {
    attempts: sql`${orderEmail.attempts}`,
    mailboxFailures: sql`${orderEmail.mailboxFailures}`,
  });
  const [row] = await db
    .insert(orderEmail)
    .values({ ...email, ...first, errorKind })
    .onConflictDoUpdate({
      target: [orderEmail.accountId, orderEmail.emailId],
      set: { ...next, errorKind, processedAt: sql`now()` },
      where: eq(orderEmail.status, 'failed'),
    })
    .returning({
      status: orderEmail.status,
      attempts: orderEmail.attempts,
      mailboxFailures: orderEmail.mailboxFailures,
    });
  return row as FailedRead | undefined;
}

/**
 * The failure rule over a row's previous counts (zeros for a new row), as
 * SQL, so the insert and the update share it: whether this read spends an
 * attempt, and whether the attempts reached the budget.
 */
function failedRead(
  scope: Exclude<OrderEmailFailureScope, 'outage'>,
  old: { attempts: SQL; mailboxFailures: SQL },
): { attempts: SQL; mailboxFailures: SQL; status: SQL } {
  const spends =
    scope === 'email'
      ? sql`true`
      : sql`${old.mailboxFailures} + 1 >= ${ORDER_MAIL_MAILBOX_STRIKES}::int`;
  const attempts = sql`${old.attempts} + case when ${spends} then 1 else 0 end`;
  return {
    attempts,
    mailboxFailures: sql`case when ${spends} then 0 else ${old.mailboxFailures} + 1 end`,
    status: sql`case when ${attempts} >= ${ORDER_MAIL_ATTEMPTS}::int then 'parked' else 'failed' end`,
  };
}

/**
 * Parks the account's failing `emailIds` that left the inbox (deleted or
 * moved while failing): never read again, or the oldest would hold the
 * watermark for good. How many it parked.
 */
export async function parkGoneEmails(
  db: Db,
  accountId: string,
  emailIds: readonly string[],
): Promise<number> {
  if (emailIds.length === 0) return 0;
  const parked = await db
    .update(orderEmail)
    .set({ status: 'parked', errorKind: 'gone', processedAt: sql`now()` })
    .where(
      and(
        eq(orderEmail.accountId, accountId),
        inArray(orderEmail.emailId, [...emailIds]),
        eq(orderEmail.status, 'failed'),
      ),
    )
    .returning({ id: orderEmail.id });
  return parked.length;
}

export interface ReviewItem {
  id: number;
  productUrl: string;
  name: string | null;
  brand: string | null;
  price: string | null;
  currency: string | null;
  orderedOn: IsoDate;
}

const reviewColumns = {
  id: orderItem.id,
  productUrl: orderItem.productUrl,
  name: orderItem.name,
  brand: orderItem.brand,
  price: orderItem.price,
  currency: orderItem.currency,
  orderedOn: sql<IsoDate>`${orderItem.orderedOn}`,
};

/** The review list: `ownerId`'s pending items, the newest order first. */
export function pendingOrderItems(
  db: Db,
  ownerId: number,
): Promise<ReviewItem[]> {
  return db
    .select(reviewColumns)
    .from(orderItem)
    .where(and(eq(orderItem.ownerId, ownerId), eq(orderItem.state, 'pending')))
    .orderBy(desc(orderItem.orderedOn), desc(orderItem.id));
}

/** One of `ownerId`'s items while it is still pending. */
export async function findPendingOrderItem(
  db: Queryable,
  id: number,
  ownerId: number,
): Promise<ReviewItem | undefined> {
  const [row] = await db
    .select(reviewColumns)
    .from(orderItem)
    .where(
      and(
        eq(orderItem.id, id),
        eq(orderItem.ownerId, ownerId),
        eq(orderItem.state, 'pending'),
      ),
    );
  return row;
}

/**
 * Moves `ownerId`'s item `id` out of pending (orderItemTransition): `add`
 * with the garment saved from it (inside that garment's transaction),
 * `dismiss` on its own. False when it is not theirs or not pending any
 * more (dismissed meanwhile, or a second save of the same form): the one
 * guard against adding an order twice.
 */
export async function decideOrderItem(
  db: Queryable,
  id: number,
  ownerId: number,
  decision: { event: 'add'; garmentId: number } | { event: 'dismiss' },
): Promise<boolean> {
  const event: OrderItemEvent = decision.event;
  const state = orderItemTransition('pending', event);
  if (state === undefined) return false;
  const moved = await db
    .update(orderItem)
    .set({
      state,
      decidedAt: new Date(),
      ...(decision.event === 'add' && { garmentId: decision.garmentId }),
    })
    .where(
      and(
        eq(orderItem.id, id),
        eq(orderItem.ownerId, ownerId),
        eq(orderItem.state, 'pending'),
      ),
    )
    .returning({ id: orderItem.id });
  return moved.length > 0;
}
