import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config';
import { garment, orderEmail, orderItem, user } from '../../src/db/schema';
import { PartialFailure } from '../../src/metrics/partial-failure';
import { t as text } from '../../src/web/i18n';
import { JmapError } from '../../src/web/wardrobe/order-mail/jmap';
import {
  OrderMailOwnerError,
  pollOrderMail,
  pollOrderMailWhole,
} from '../../src/web/wardrobe/order-mail/poll';
import { pollStart } from '../../src/web/wardrobe/order-mail/queries';
import {
  type JmapStub,
  startJmapStub,
  type StubEmail,
} from '../support/jmap-stub';
import {
  ORDER_SENDER as SENDER,
  serveForwardedOrder,
} from '../support/order-mail-shop';
import {
  createTestApp,
  OWNER_EMAIL,
  recordQueries,
  type TestApp,
  unescapeHtml,
} from './harness';
import { html, type LinkSites, startLinkSites } from './link-sites';
import {
  expectAppBar,
  expectFullPage,
  expectNativePostForms,
  expectNoRawI18nKeys,
  expectNoScriptNavigation,
} from './pages';

/**
 * The order email import (#25; plan docs/plans/2026-09-28-order-email-
 * import.md): the poll against a stand-in for Fastmail's JMAP API
 * (test/support/jmap-stub.ts) and a local shop (link-sites.ts) behind the
 * real outbound fetchers, then the "From your orders" review list and its
 * "Add to closet" through the link import's garment form. No spec reaches
 * Fastmail or the internet.
 */

// Fastmail's shape (fmu1- and hex groups): the scrubbing and log checks
// look for exactly this.
const TOKEN = 'fmu1-0a1b2c3d-4e5f60718293a4b5c6d7e8f9a0b1c2d3-0-e4f5a6b7c8d9';

/** A poll's summary when no email failed or was parked. */
const SETTLED = { failing: 0, firstFailures: 0, parked: 0 };

/** The rules every page keeps (pages.spec.ts), for pages only this feature has. */
function expectPageRules(res: LightMyRequestResponse): void {
  expectFullPage(res);
  expectAppBar(res);
  expectNativePostForms(res);
  expectNoRawI18nKeys(res);
  expectNoScriptNavigation(res);
}

describe('order email import', () => {
  let t: TestApp;
  let sites: LinkSites;
  let jmap: JmapStub;
  let forwarded: StubEmail;

  const poll = () => pollOrderMail(t.orderMail!);
  const items = () => t.db.select().from(orderItem).orderBy(orderItem.id);
  const emailRow = async (emailId: string) =>
    (
      await t.db
        .select()
        .from(orderEmail)
        .where(eq(orderEmail.emailId, emailId))
    )[0];

  /** An email like `forwarded` with its own id, arrival and overrides. */
  const variant = (
    id: string,
    receivedAt: string,
    overrides: Partial<StubEmail> = {},
  ): StubEmail => ({ ...forwarded, id, receivedAt, ...overrides });

  beforeAll(async () => {
    sites = await startLinkSites();
    jmap = await startJmapStub(TOKEN);
    forwarded = await serveForwardedOrder(sites);

    t = await createTestApp(
      {
        ORDER_MAIL_JMAP_TOKEN: TOKEN,
        ORDER_MAIL_SENDERS: `${SENDER.toUpperCase()}, other@example.com`,
        ORDER_MAIL_OWNER: OWNER_EMAIL,
      },
      { outboundFetch: sites.outboundFetch, orderMail: jmap.options },
    );
  });

  afterAll(async () => {
    await t.cleanup();
    await jmap.close();
    await sites.close();
  });

  beforeEach(() => {
    jmap.failWith(undefined);
  });

  describe('the poll', () => {
    it('lists the products of a forwarded order email, unwrapping its tracking links', async () => {
      jmap.deliver(forwarded);
      sites.hits.length = 0;

      let summary: Awaited<ReturnType<typeof poll>> | undefined;
      const recorded = await recordQueries(async () => {
        summary = await poll();
      });

      expect(summary).toEqual({
        ...SETTLED,
        queried: 1,
        read: 1,
        listed: 2,
      });
      // #173: the owner and the watermark in one statement, which of the
      // inbox's ids are known, then the email: begin, the email and its
      // items in one statement, its count and outcome, commit.
      expect(recorded.statements).toBe(6);
      const rows = await items();
      expect(
        rows.map(({ productUrl, name, brand, price, currency, state }) => ({
          productUrl,
          name,
          brand,
          price,
          currency,
          state,
        })),
      ).toEqual([
        {
          // A tracker carrying its target in the query, unwrapped without
          // a fetch; its campaign tags stripped, the variant kept.
          productUrl: sites.secureUrl(
            '/products/relaxed-linen-shirt?variant=sage',
          ),
          name: 'Relaxed Linen Shirt',
          brand: 'Northfield',
          price: '49.90',
          currency: 'USD',
          state: 'pending',
        },
        {
          // Gmail's google.com/url?q= wrapper, unwrapped without a fetch.
          productUrl: sites.secureUrl('/products/merino-crew-socks'),
          name: 'Merino Crew Socks (3-pack)',
          brand: null,
          price: '24.00',
          currency: 'USD',
          state: 'pending',
        },
      ]);
      // The day it arrived in the household's zone (13:20 UTC is the
      // morning of the 26th in New York).
      expect(rows.every((row) => row.orderedOn === '2026-09-26')).toBe(true);
      expect(await emailRow(forwarded.id)).toMatchObject({
        outcome: 'imported',
        items: 2,
      });

      // Only product candidates were fetched: never the account, help,
      // unsubscribe or privacy pages, the home page, a social site, the
      // tracking pixel or a product image.
      const paths = sites.hits.map((hit) => hit.split('?')[0]);
      expect(paths).not.toContain('/ls/click');
      expect(paths).toContain('/products/relaxed-linen-shirt');
      expect(paths).toContain('/products/merino-crew-socks');
      for (const never of [
        '/',
        '/account/orders/NF-204817',
        '/help',
        '/unsubscribe',
        '/pages/privacy',
        '/open.gif',
        '/img/linen-shirt.jpg',
      ]) {
        expect(paths).not.toContain(never);
      }
    });

    it('reads nothing twice: a second poll lists nothing and fetches no body', async () => {
      const before = await items();
      const bodies = jmap.calls.filter((c) => c === 'Email/get body').length;
      sites.hits.length = 0;

      let summary: Awaited<ReturnType<typeof poll>> | undefined;
      const recorded = await recordQueries(async () => {
        summary = await poll();
      });

      expect(summary).toEqual({
        ...SETTLED,
        queried: 1,
        read: 0,
        listed: 0,
      });
      // #173: the poll every few minutes is two statements (it was three):
      // the owner with the watermark, then which ids are known.
      expect(recorded.statements).toBe(2);
      expect(recorded.sql.join('\n')).not.toMatch(/"password"/);
      expect(await items()).toEqual(before);
      expect(jmap.calls.filter((c) => c === 'Email/get body')).toHaveLength(
        bodies,
      );
      expect(sites.hits).toEqual([]);
    });

    it('lists a product once, even when a later email (the shipping one) names it again', async () => {
      jmap.deliver(variant('Mshipped01', '2026-09-27T09:00:00Z'));
      await poll();
      expect(await items()).toHaveLength(2);
      expect(await emailRow('Mshipped01')).toMatchObject({
        outcome: 'no-products',
        items: 0,
      });
    });

    it("ignores mail that is not from the owner's addresses, without reading its body", async () => {
      const bodies = jmap.calls.filter((c) => c === 'Email/get body').length;
      jmap.deliver(
        variant('Mstranger1', '2026-09-27T10:00:00Z', {
          from: [{ email: 'deals@northfield.test' }],
        }),
      );
      // The owner's address as From, but sent from elsewhere: DKIM and SPF
      // fail at Fastmail, and a passing header the sender added lower down
      // counts for nothing.
      jmap.deliver(
        variant('Mspoofed01', '2026-09-27T10:05:00Z', {
          authenticationResults: [
            'mx2.messagingengine.com; dkim=none (no signatures found); dmarc=fail policy.published-domain-policy=none header.from=gmail.com; spf=softfail smtp.mailfrom=owner.forwarder@gmail.com',
            'mx.google.com; dkim=pass header.d=gmail.com; spf=pass smtp.mailfrom=owner.forwarder@gmail.com',
          ],
        }),
      );
      // A passing result under another server's name is not Fastmail's.
      jmap.deliver(
        variant('Mforeign01', '2026-09-27T10:10:00Z', {
          authenticationResults: [
            'mx.evil.test; dkim=pass header.d=gmail.com; spf=pass smtp.mailfrom=owner.forwarder@gmail.com',
          ],
        }),
      );
      t.logs.clear();

      await poll();

      for (const id of ['Mstranger1', 'Mspoofed01', 'Mforeign01']) {
        expect(await emailRow(id)).toMatchObject({
          outcome: 'untrusted',
          items: 0,
        });
      }
      expect(jmap.calls.filter((c) => c === 'Email/get body')).toHaveLength(
        bodies,
      );
      expect(await items()).toHaveLength(2);
      const warnings = t.logs.messages('warn', 'OrderMail');
      expect(warnings).toEqual([
        'Order mail Mstranger1 ignored: untrusted (sender-not-allowed, from northfield.test)',
        'Order mail Mspoofed01 ignored: untrusted (authentication-failed, from gmail.com)',
        'Order mail Mforeign01 ignored: untrusted (foreign-authserv, from gmail.com)',
      ]);
    });

    it('records an email without product links as having none', async () => {
      jmap.deliver(
        variant('Mplain0001', '2026-09-27T11:00:00Z', {
          htmlBody: [{ partId: '1', type: 'text/plain' }],
          bodyValues: {
            '1': {
              value:
                'Fwd: Your order has shipped.\n\nQuestions? Reply to this email.\n',
            },
          },
        }),
      );
      // #173: an email without products is one insert, no transaction.
      const recorded = await recordQueries(() => poll());
      expect(recorded.statements).toBe(3);
      expect(await emailRow('Mplain0001')).toMatchObject({
        outcome: 'no-products',
        items: 0,
      });
      expect(await items()).toHaveLength(2);
    });

    it('fails the run when JMAP refuses, recording nothing, and never logs the token', async () => {
      jmap.deliver(variant('Mlater0001', '2026-09-27T12:00:00Z'));
      jmap.failWith(401);
      await expect(poll()).rejects.toThrow(JmapError);
      await expect(poll()).rejects.toThrow(
        'JMAP session refused (http-status 401)',
      );
      expect(await emailRow('Mlater0001')).toBeUndefined();

      jmap.failWith(undefined);
      await poll();
      expect(await emailRow('Mlater0001')).toMatchObject({
        outcome: 'no-products',
      });
      expect(t.logs.text()).not.toContain(TOKEN);
      expect(JSON.stringify(t.logs.records)).not.toContain(TOKEN);
    });
  });

  describe('the review list', () => {
    const pending = async () =>
      (await items()).filter((row) => row.state === 'pending');
    const pendingNamed = async (name: string) =>
      (await pending()).find((row) => row.name === name)!;

    it('lists the pending items, linked from the Wardrobe menu, for the order account owner', async () => {
      const page = await t.inject({ method: 'GET', url: '/wardrobe/orders' });
      expect(page.statusCode).toBe(200);
      expectPageRules(page);
      const body = unescapeHtml(page.body);
      expect(body).toContain('Relaxed Linen Shirt');
      expect(body).toContain('Merino Crew Socks (3-pack)');
      expect(body).toContain('$49.90');
      expect(body).toContain(
        `href="${sites.secureUrl('/products/relaxed-linen-shirt?variant=sage')}"`,
      );
      // No markup from the email ever reaches the page.
      expect(body).not.toContain('Forwarded message');

      const wardrobe = await t.inject({ method: 'GET', url: '/wardrobe' });
      expect(wardrobe.body).toContain('href="/wardrobe/orders"');
    });

    it('is nobody else’s: another user gets a 404, no menu entry, and cannot claim an item', async () => {
      const cookie = await t.register('housemate@example.com');
      const page = await t.inject({
        method: 'GET',
        url: '/wardrobe/orders',
        headers: { cookie },
      });
      expect(page.statusCode).toBe(404);
      const wardrobe = await t.inject({
        method: 'GET',
        url: '/wardrobe',
        headers: { cookie },
      });
      expect(wardrobe.body).not.toContain('href="/wardrobe/orders"');

      const [item] = await pending();
      const dismiss = await t.inject({
        method: 'POST',
        url: `/wardrobe/orders/${item.id}/dismiss`,
        headers: { cookie },
      });
      expect(dismiss.statusCode).toBe(404);
      const save = await t.inject({
        method: 'POST',
        url: '/wardrobe',
        payload: {
          category: 'tops',
          name: 'Mine now',
          orderItem: String(item.id),
        },
        headers: { cookie },
      });
      expect(save.statusCode).toBe(404);
      expect((await pending()).map((row) => row.id)).toContain(item.id);
    });

    it('adds an item to the closet through the prefilled garment form, once', async () => {
      const shirt = await pendingNamed('Relaxed Linen Shirt');
      const form = await t.inject({
        method: 'POST',
        url: `/wardrobe/orders/${shirt.id}/add`,
      });
      expect(form.statusCode).toBe(200);
      expectPageRules(form);
      const body = unescapeHtml(form.body);
      expect(body).toContain(`name="orderItem" value="${shirt.id}"`);
      expect(body).toContain('value="Relaxed Linen Shirt"');
      expect(body).toContain('value="2026-09-26"');
      expect(body).toContain(text('orders.FROM_ORDER'));
      const linkPhoto = /name="linkPhoto" value="([^"]+)"/.exec(body)?.[1];
      expect(linkPhoto).toBeDefined();

      const fields = {
        category: 'tops',
        name: 'Relaxed Linen Shirt',
        product: '1',
        sourceUrl: shirt.productUrl,
        price: '49.90',
        dateAquired: '2026-09-26',
        orderItem: String(shirt.id),
      };
      const saved = await t.inject({
        method: 'POST',
        url: '/wardrobe',
        payload: { ...fields, linkPhoto: linkPhoto! },
      });
      expect(saved.statusCode).toBe(302);
      const garmentId = Number(
        /^\/wardrobe\/(\d+)\?created=1$/.exec(saved.headers.location!)?.[1],
      );
      const [row] = await items().then((rows) =>
        rows.filter((r) => r.id === shirt.id),
      );
      expect(row).toMatchObject({ state: 'added', garmentId });
      expect(row.decidedAt).not.toBeNull();
      const [created] = await t.db
        .select()
        .from(garment)
        .where(eq(garment.id, garmentId));
      expect(created).toMatchObject({
        status: 'closet',
        acquiredOn: '2026-09-26',
        price: '49.90',
      });

      // The same form again (a double tap, no photo left): refused, and
      // no second garment.
      const count = await t.db.$count(garment);
      const again = await t.inject({
        method: 'POST',
        url: '/wardrobe',
        payload: fields,
      });
      expect(again.statusCode).toBe(404);
      expect(await t.db.$count(garment)).toBe(count);

      // Off the list; its "Add" again goes back to the list.
      const list = await t.inject({ method: 'GET', url: '/wardrobe/orders' });
      expect(list.body).not.toContain('Relaxed Linen Shirt');
      const reopen = await t.inject({
        method: 'POST',
        url: `/wardrobe/orders/${shirt.id}/add`,
      });
      expect(reopen.statusCode).toBe(303);
      expect(reopen.headers.location).toBe('/wardrobe/orders');
    });

    it("opens the form with the order's details when the product page cannot be read now", async () => {
      const socks = await pendingNamed('Merino Crew Socks (3-pack)');
      sites.serve('/products/merino-crew-socks', {
        status: 503,
        type: 'text/html',
        body: 'down',
      });
      const form = await t.inject({
        method: 'POST',
        url: `/wardrobe/orders/${socks.id}/add`,
      });
      expect(form.statusCode).toBe(200);
      const body = unescapeHtml(form.body);
      expect(body).toContain('value="Merino Crew Socks (3-pack)"');
      expect(body).toContain('value="24.00"');
      expect(body).toContain(text('orders.PAGE_UNAVAILABLE'));
      expect(body).toContain(`name="orderItem" value="${socks.id}"`);
    });

    it('dismisses an item', async () => {
      const socks = await pendingNamed('Merino Crew Socks (3-pack)');
      const res = await t.inject({
        method: 'POST',
        url: `/wardrobe/orders/${socks.id}/dismiss`,
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/wardrobe/orders');
      expect(await pending()).toEqual([]);
      const [row] = (await items()).filter((r) => r.id === socks.id);
      expect(row).toMatchObject({ state: 'dismissed', garmentId: null });
      const list = await t.inject({ method: 'GET', url: '/wardrobe/orders' });
      expect(list.body).toContain(text('orders.EMPTY'));
    });
  });

  // #706: ORDER_MAIL_OWNER is an account id from the boot on.
  // The inbox is never queried (no JMAP method called), so nothing is
  // delivered: an email here would move the watermark the later tests use.
  it("fails the run before the inbox is queried or a row written when the boot's owner account is gone", async () => {
    const rows = (await t.db.select().from(orderEmail)).length;
    const calls = jmap.calls.length;
    // An id no account has: the owner's account deleted since the boot.
    await expect(
      pollOrderMail({ ...t.orderMail!, ownerId: 2_000_000_000 }),
    ).rejects.toThrow(OrderMailOwnerError);
    expect(jmap.calls.slice(calls)).toEqual([]);
    expect(await t.db.select().from(orderEmail)).toHaveLength(rows);
  });

  it('refuses the boot, naming the key, when ORDER_MAIL_OWNER names no account', async () => {
    const boot = createTestApp(
      {
        ORDER_MAIL_JMAP_TOKEN: TOKEN,
        ORDER_MAIL_SENDERS: SENDER,
        ORDER_MAIL_OWNER: 'nobody@example.com',
      },
      { outboundFetch: sites.outboundFetch, orderMail: jmap.options },
    );
    await expect(boot).rejects.toThrow(ConfigError);
    await expect(boot).rejects.toThrow(
      /ORDER_MAIL_OWNER: names no closet account/,
    );
    await expect(boot).rejects.not.toThrow(/nobody@example\.com/);
  });

  it("stays the boot's account when its email changes and another account takes the old one", async () => {
    const other = await createTestApp(
      {
        ORDER_MAIL_JMAP_TOKEN: TOKEN,
        ORDER_MAIL_SENDERS: SENDER,
        ORDER_MAIL_OWNER: OWNER_EMAIL,
      },
      { outboundFetch: sites.outboundFetch, orderMail: jmap.options },
    );
    try {
      await other.db
        .update(user)
        .set({ email: 'renamed@example.com' })
        .where(eq(user.id, other.owner.id));
      const newcomer = await other.register(OWNER_EMAIL);
      // The poll lists for the id, never for whoever holds the address.
      expect(other.orderMail!.ownerId).toBe(other.owner.id);

      const list = await other.inject({
        method: 'GET',
        url: '/wardrobe/orders',
      });
      expect(list.statusCode).toBe(200);
      const menu = await other.inject({ method: 'GET', url: '/wardrobe' });
      expect(menu.body).toContain('href="/wardrobe/orders"');

      const refused = await other.inject({
        method: 'GET',
        url: '/wardrobe/orders',
        headers: { cookie: newcomer },
      });
      expect(refused.statusCode).toBe(404);
      const theirs = await other.inject({
        method: 'GET',
        url: '/wardrobe',
        headers: { cookie: newcomer },
      });
      expect(theirs.body).not.toContain('href="/wardrobe/orders"');
    } finally {
      await other.cleanup();
    }
  });

  // #693: one email that fails no longer stalls the rest. Each test leaves
  // its emails settled, so the next starts from a clean watermark.
  describe('each email its own outcome', () => {
    const whole = () => pollOrderMailWhole(t.orderMail!);
    const listedNames = async () =>
      (await items()).map((row) => row.name).filter((name) => name !== null);

    /** A trusted email naming one product page of its own on the shop. */
    const productEmail = (id: string, receivedAt: string, name: string) => {
      const path = `/products/${id.toLowerCase()}`;
      sites.serve(
        path,
        html(`<!doctype html><html><head><title>${name}</title>
<meta property="og:type" content="product">
<meta property="og:title" content="${name}">
<meta property="product:price:amount" content="30.00">
</head><body></body></html>`),
      );
      return variant(id, receivedAt, {
        htmlBody: [{ partId: '1', type: 'text/html' }],
        bodyValues: {
          '1': {
            value: `<p>Your order</p><a href="${sites.secureUrl(path)}">${name}</a>`,
          },
        },
      });
    };

    it('reads past a poison email: the good one is listed, the poison failed with attempt 1', async () => {
      jmap.deliver(
        productEmail('Mpoison001', '2026-09-28T08:00:00Z', 'Poison Tee'),
      );
      jmap.deliver(
        productEmail('Mgood00001', '2026-09-28T08:05:00Z', 'Good Tee'),
      );
      jmap.failBodyOf('Mpoison001', 404);

      const failure = await whole().catch((error: unknown) => error);

      // The job fails, and this run reports it: the poison's first attempt.
      expect(failure).toBeInstanceOf(PartialFailure);
      expect(failure).toMatchObject({
        counts: { failing: 1 },
        reported: false,
      });
      expect(await listedNames()).toContain('Good Tee');
      expect(await emailRow('Mgood00001')).toMatchObject({
        status: 'decided',
        outcome: 'imported',
        items: 1,
      });
      expect(await emailRow('Mpoison001')).toMatchObject({
        status: 'failed',
        outcome: null,
        attempts: 1,
        mailboxFailures: 0,
        errorKind: 'JmapError',
      });
      expect(
        t.logs
          .messages('error', 'OrderMail')
          .some((line) =>
            line.startsWith(
              'Order mail Mpoison001 failed (JmapError): attempt 1 of 3',
            ),
          ),
      ).toBe(true);
    });

    it('retries it each poll, failing uncaptured, then parks it and never reads it again', async () => {
      const second = await whole().catch((error: unknown) => error);
      expect(second).toMatchObject({ counts: { failing: 1 }, reported: true });
      expect(await emailRow('Mpoison001')).toMatchObject({
        status: 'failed',
        attempts: 2,
      });

      // The third attempt parks it: the job succeeds again.
      const parked = await whole();
      expect(parked).toMatchObject({ failing: 0, firstFailures: 0, parked: 1 });
      expect(await emailRow('Mpoison001')).toMatchObject({
        status: 'parked',
        attempts: 3,
        outcome: null,
        errorKind: 'JmapError',
      });

      // The watermark passes it: a later email is read, the poison never.
      const reads = jmap.calls.length;
      jmap.deliver(
        productEmail('Mafter0001', '2026-09-28T09:00:00Z', 'After Tee'),
      );
      await whole();
      const since = jmap.calls.slice(reads);
      expect(since.filter((c) => c === 'Email/get body')).toHaveLength(1);
      expect(await listedNames()).toContain('After Tee');
      const { accountId } = await emailRow('Mpoison001');
      const start = await pollStart(t.db, t.owner.id, accountId);
      expect(start.watermark).toEqual(new Date('2026-09-28T09:00:00Z'));
      expect(start.failing).toEqual([]);
      jmap.failBodyOf('Mpoison001', undefined);
    });

    it('decides an email that fails and then succeeds on its retry', async () => {
      jmap.deliver(
        productEmail('Mflaky0001', '2026-09-28T10:00:00Z', 'Flaky Tee'),
      );
      jmap.failBodyOf('Mflaky0001', 404);
      await expect(whole()).rejects.toBeInstanceOf(PartialFailure);
      expect(await emailRow('Mflaky0001')).toMatchObject({
        status: 'failed',
        attempts: 1,
        errorKind: 'JmapError',
      });

      jmap.failBodyOf('Mflaky0001', undefined);
      await expect(whole()).resolves.toMatchObject({ failing: 0, listed: 1 });
      expect(await emailRow('Mflaky0001')).toMatchObject({
        status: 'decided',
        outcome: 'imported',
        attempts: 1,
        errorKind: null,
      });
      expect(await listedNames()).toContain('Flaky Tee');
    });

    it('lists the good one of two emails that arrived together, and reads the failing one again', async () => {
      jmap.deliver(
        productEmail('Mtwin00001', '2026-09-28T11:00:00Z', 'Twin One'),
      );
      jmap.deliver(
        productEmail('Mtwin00002', '2026-09-28T11:00:00Z', 'Twin Two'),
      );
      jmap.failBodyOf('Mtwin00001', 404);
      await expect(whole()).rejects.toBeInstanceOf(PartialFailure);
      expect(await listedNames()).toContain('Twin Two');
      expect(await emailRow('Mtwin00001')).toMatchObject({ status: 'failed' });

      // The watermark is the failing one's arrival, which the good one
      // shares: it is queried again and dropped as decided.
      jmap.failBodyOf('Mtwin00001', undefined);
      const run = await whole();
      expect(run).toMatchObject({ read: 1, listed: 1, failing: 0 });
      expect(await listedNames()).toContain('Twin One');
      expect(await emailRow('Mtwin00002')).toMatchObject({ items: 1 });
    });

    it('spends no attempt on its own body fetch failing until it repeats on the same email', async () => {
      jmap.deliver(
        productEmail('Mstuck0001', '2026-09-28T12:00:00Z', 'Stuck Tee'),
      );
      jmap.failBodyOf('Mstuck0001', 503);
      for (const strikes of [1, 2]) {
        await expect(whole()).rejects.toThrow(
          'JMAP body refused (http-status 503)',
        );
        expect(await emailRow('Mstuck0001')).toMatchObject({
          status: 'failed',
          attempts: 0,
          mailboxFailures: strikes,
        });
      }

      // The third in a row is the email's: one attempt, and the run goes on.
      const third = await whole().catch((error: unknown) => error);
      expect(third).toMatchObject({ counts: { failing: 1 }, reported: false });
      expect(await emailRow('Mstuck0001')).toMatchObject({
        attempts: 1,
        mailboxFailures: 0,
      });

      jmap.failBodyOf('Mstuck0001', undefined);
      await whole();
      expect(await emailRow('Mstuck0001')).toMatchObject({ status: 'decided' });
    });

    it('parks a failing email that left the inbox, so it stops holding the watermark', async () => {
      jmap.deliver(
        productEmail('Mgone00001', '2026-09-28T13:00:00Z', 'Gone Tee'),
      );
      jmap.failBodyOf('Mgone00001', 404);
      await expect(whole()).rejects.toBeInstanceOf(PartialFailure);

      jmap.remove('Mgone00001');
      await expect(whole()).resolves.toMatchObject({ failing: 0, parked: 1 });
      expect(await emailRow('Mgone00001')).toMatchObject({
        status: 'parked',
        attempts: 1,
        errorKind: 'gone',
      });
      jmap.failBodyOf('Mgone00001', undefined);
    });

    it("counts a JMAP method error as the outage's, never the email's", async () => {
      jmap.deliver(
        productEmail('Mmethod001', '2026-09-28T14:00:00Z', 'Method Tee'),
      );
      jmap.failBodyOf('Mmethod001', 'method');
      await expect(whole()).rejects.toThrow(
        'JMAP body failed: serverUnavailable',
      );
      expect(await emailRow('Mmethod001')).toBeUndefined();
      jmap.failBodyOf('Mmethod001', undefined);
      await whole();
      expect(await emailRow('Mmethod001')).toMatchObject({
        status: 'decided',
      });
    });

    it('reports a first failure in the event of a run a later mailbox failure stopped', async () => {
      jmap.deliver(
        productEmail('Mfirst0001', '2026-09-28T15:00:00Z', 'First Tee'),
      );
      jmap.deliver(
        productEmail('Mstop00001', '2026-09-28T15:05:00Z', 'Stop Tee'),
      );
      jmap.failBodyOf('Mfirst0001', 404);
      jmap.failBodyOf('Mstop00001', 503);

      const stopped = await whole().catch((error: unknown) => error);
      expect(stopped).toBeInstanceOf(PartialFailure);
      expect(stopped).toMatchObject({
        reported: false,
        counts: { failing: 1, 'stopped by a mailbox failure': 1 },
      });
      expect((stopped as Error).cause).toBeInstanceOf(JmapError);
      expect(await emailRow('Mfirst0001')).toMatchObject({ attempts: 1 });

      jmap.failBodyOf('Mfirst0001', undefined);
      jmap.failBodyOf('Mstop00001', undefined);
      await expect(whole()).resolves.toMatchObject({ failing: 0 });
    });

    it('never strikes or spends an attempt on a session-level 503 or 429, however many polls', async () => {
      jmap.deliver(
        productEmail('Moldest001', '2026-09-28T16:00:00Z', 'Oldest Tee'),
      );
      for (const status of [503, 429]) {
        jmap.failWith(status);
        for (let poll = 0; poll < 10; poll += 1) {
          await expect(whole()).rejects.toThrow(JmapError);
        }
      }
      jmap.failWith(undefined);
      // A 429 on that email's own body is the outage's too.
      jmap.failBodyOf('Moldest001', 429);
      for (let poll = 0; poll < 10; poll += 1) {
        await expect(whole()).rejects.toThrow(JmapError);
      }
      expect(await emailRow('Moldest001')).toBeUndefined();

      jmap.failBodyOf('Moldest001', undefined);
      await whole();
      expect(await emailRow('Moldest001')).toMatchObject({
        status: 'decided',
        attempts: 0,
        mailboxFailures: 0,
      });
    });

    it('counts a wrong-shaped body answer for its id as a strike, three in a row as one attempt', async () => {
      jmap.deliver(
        productEmail('Mshape0001', '2026-09-28T17:00:00Z', 'Shape Tee'),
      );
      jmap.failBodyOf('Mshape0001', 'shape');
      for (const strikes of [1, 2]) {
        await expect(whole()).rejects.toThrow(JmapError);
        expect(await emailRow('Mshape0001')).toMatchObject({
          attempts: 0,
          mailboxFailures: strikes,
        });
      }
      await expect(whole()).rejects.toBeInstanceOf(PartialFailure);
      expect(await emailRow('Mshape0001')).toMatchObject({
        attempts: 1,
        mailboxFailures: 0,
      });
      jmap.failBodyOf('Mshape0001', undefined);
      await whole();
      expect(await emailRow('Mshape0001')).toMatchObject({ status: 'decided' });
    });
  });

  // #698, #946: a fetch is a click the retailer acts on, so only product
  // links are requested, and a redirect only to a product link.
  describe('which links are fetched', () => {
    const htmlEmail = (id: string, receivedAt: string, value: string) =>
      variant(id, receivedAt, {
        htmlBody: [{ partId: '1', type: 'text/html' }],
        bodyValues: { '1': { value } },
      });
    const shop = (path: string) => sites.secureUrl(path);
    const PRODUCT_DATA = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Product',
      name: 'Bait Tee',
    })}</script>`;

    it('never requests an opaque tracker, whatever its text, nor an action link', async () => {
      // Each would answer with a product page if it were ever fetched.
      for (const path of [
        '/ls/click?upn=approve',
        '/ls/click?upn=not-you',
        '/products/123/cancel-order',
      ]) {
        sites.serve(path, html(PRODUCT_DATA));
      }
      jmap.deliver(
        htmlEmail(
          'Mactions01',
          '2026-09-29T08:00:00Z',
          `<a href="${shop('/ls/click?upn=approve')}">Approve</a>
           <a href="${shop('/ls/click?upn=not-you')}">Not you?</a>
           <a href="${shop('/products/123/cancel-order')}">Relaxed Tee</a>
           <a href="${shop(`/ls/click?url=${encodeURIComponent(shop('/account/cancel?order=NF-2'))}`)}">Your order</a>
           <a href="${shop('/confirm?token=abc')}">Confirm your email</a>`,
        ),
      );
      sites.hits.length = 0;
      t.logs.clear();

      await poll();

      expect(sites.hits).toEqual([]);
      expect(await emailRow('Mactions01')).toMatchObject({
        outcome: 'no-products',
        items: 0,
      });
      expect(t.logs.messages('info', 'OrderMail')).toContainEqual(
        expect.stringMatching(
          /^Order mail Mactions01: 0 links read, 5 skipped, 0 products found/,
        ),
      );
    });

    it('abandons a product link at a redirect that leaves product pages', async () => {
      sites.serve('/products/bounces', {
        status: 302,
        type: 'text/plain',
        body: '',
        headers: { location: shop('/account/cancel?order=NF-1') },
      });
      sites.serve('/account/cancel?order=NF-1', html(PRODUCT_DATA));
      jmap.deliver(
        htmlEmail(
          'Mbounce001',
          '2026-09-29T09:00:00Z',
          `<a href="${shop('/products/bounces')}">Tee</a>`,
        ),
      );
      sites.hits.length = 0;
      t.logs.clear();

      await poll();

      expect(sites.hits).toEqual(['/products/bounces']);
      expect(await emailRow('Mbounce001')).toMatchObject({
        outcome: 'no-products',
      });
      expect(t.logs.messages('warn', 'OutboundFetch')).toEqual([
        expect.stringMatching(
          /^Outbound fetch refused \(redirect-not-followed\): .* answered 302/,
        ),
      ]);
    });

    it('follows neither a product link answering 302 without a Location nor one whose page refreshes to /cancel (#950)', async () => {
      sites.serve('/p/no-location', {
        status: 302,
        type: 'text/plain',
        body: '',
      });
      sites.serve(
        '/p/meta-refresh',
        html('<meta http-equiv="refresh" content="0;url=/cancel">'),
      );
      sites.serve('/cancel', html(PRODUCT_DATA));
      jmap.deliver(
        htmlEmail(
          'Mproduct01',
          '2026-09-29T09:30:00Z',
          `<a href="${shop('/p/no-location')}">Tee</a>
           <a href="${shop('/p/meta-refresh')}">Tee</a>`,
        ),
      );
      sites.hits.length = 0;

      await poll();

      expect([...sites.hits].sort()).toEqual([
        '/p/meta-refresh',
        '/p/no-location',
      ]);
      expect(await emailRow('Mproduct01')).toMatchObject({
        outcome: 'no-products',
        items: 0,
      });
    });
  });
});

describe('order email import, off', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it('has no poll, no review list and no menu entry without a token', async () => {
    expect(t.orderMail).toBeUndefined();
    // A 404 like a route that is not there, never /wardrobe/:id's 400.
    const page = await t.inject({ method: 'GET', url: '/wardrobe/orders' });
    expect(page.statusCode).toBe(404);
    expect(page.body).not.toContain(text('orders.INTRO'));
    for (const action of ['add', 'dismiss']) {
      const post = await t.inject({
        method: 'POST',
        url: `/wardrobe/orders/1/${action}`,
      });
      expect(post.statusCode).toBe(404);
    }
    const wardrobe = await t.inject({ method: 'GET', url: '/wardrobe' });
    expect(wardrobe.body).not.toContain('href="/wardrobe/orders"');
  });
});
