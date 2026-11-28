import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull, or } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../src/calendar-date';
import {
  agentRequest,
  garment,
  outfit,
  outfitCalendar,
  personalAccessToken,
  tripOutfit,
  user,
  wardrobeShare,
  weekTemplate,
} from '../../src/db/schema';
import { WEEKDAYS } from '../../src/wardrobe/week';
import { MCP_WRITES, type Stamped } from '../../src/web/api/operations';
import { deleteAccount } from '../../src/web/auth/account';
import { createCapsule } from '../../src/web/capsules/queries';
import { createTrip } from '../../src/web/trips/queries';
import { deviceToken } from './api';
import { createGarment } from './garments';
import {
  asFixture,
  createTestApp,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import {
  html,
  jpeg,
  type LinkSites,
  productShot,
  startLinkSites,
} from './link-sites';
import { createAccessToken, tool } from './mcp';

/**
 * What the agent did is visible (#682): every MCP tool MCP_WRITES says
 * stamps a row writes the calling token on it, and the same write over the
 * API with a device token (the person) leaves it unstamped. Table-driven
 * over operations.ts: a tool classified `stamps` without a scenario here
 * fails, as does a scenario whose rows carry no token. The `none` tools'
 * scenarios assert they stamp nothing.
 */

/** The stamped rows a scenario wrote, by kind, for the assertions. */
type Written = Partial<Record<Stamped, number[]>>;

describe('agent writes carry their token (#682)', () => {
  let t: TestApp;
  let sites: LinkSites;
  let token: string;
  let tokenId: number;
  const g: Record<string, number> = {};
  let tripId: number;

  const day = (n: number) => addDays(t.today(), n);

  /**
   * A top and a bottom no other scenario has: the week planner's picks are
   * seeded from the date, so under a shifted clock it may already have saved
   * the pair of any shared garments, and create_outfit and suggest_outfit
   * reuse an outfit of the same garments (the planner's, unstamped) instead
   * of making the agent's.
   */
  const freshPair = async (label: string) => [
    await createGarment(t, { name: `Tee ${label}`, category: 'tops' }),
    await createGarment(t, { name: `Jeans ${label}`, category: 'bottoms' }),
  ];

  /** The token every row of `written` names, per kind (null: unstamped). */
  async function stampsOf(written: Written) {
    const out: Partial<Record<Stamped, (number | null)[]>> = {};
    for (const [kind, ids] of Object.entries(written) as [
      Stamped,
      number[],
    ][]) {
      out[kind] = await stampColumn(kind, ids);
    }
    return out;
  }

  async function stampColumn(kind: Stamped, ids: number[]) {
    const rows = await {
      outfit: () =>
        t.db
          .select({ id: outfit.addedByTokenId })
          .from(outfit)
          .where(or(...ids.map((id) => eq(outfit.id, id)))),
      calendarEntry: () =>
        t.db
          .select({ id: outfitCalendar.plannedByTokenId })
          .from(outfitCalendar)
          .where(or(...ids.map((id) => eq(outfitCalendar.id, id)))),
      tripOutfit: () =>
        t.db
          .select({ id: tripOutfit.plannedByTokenId })
          .from(tripOutfit)
          .where(or(...ids.map((id) => eq(tripOutfit.id, id)))),
      garment: () =>
        t.db
          .select({ id: garment.addedByTokenId })
          .from(garment)
          .where(or(...ids.map((id) => eq(garment.id, id)))),
      requestClaim: () =>
        t.db
          .select({ id: agentRequest.claimedByTokenId })
          .from(agentRequest)
          .where(or(...ids.map((id) => eq(agentRequest.id, id)))),
      requestAnswer: () =>
        t.db
          .select({ id: agentRequest.answeredByTokenId })
          .from(agentRequest)
          .where(or(...ids.map((id) => eq(agentRequest.id, id)))),
    }[kind]();
    expect(rows).toHaveLength(ids.length);
    return rows.map((row) => row.id);
  }

  const entryOf = async (outfitId: number) => {
    const [row] = await t.db
      .select({ id: outfitCalendar.id, plannedBy: outfitCalendar.plannedBy })
      .from(outfitCalendar)
      .where(eq(outfitCalendar.outfitId, outfitId));
    return row;
  };

  const tripOutfitOf = async (outfitId: number) => {
    const [row] = await t.db
      .select({ id: tripOutfit.id })
      .from(tripOutfit)
      .where(
        and(eq(tripOutfit.tripId, tripId), eq(tripOutfit.outfitId, outfitId)),
      );
    return row.id;
  };

  /** Each stamping tool's write, as the agent makes it; the rows it stamped. */
  /** A request the owner asks, over the API as the phone does. */
  const askAgent = async () => {
    const res = await t.api(device, {
      method: 'POST',
      url: '/api/v1/agent-requests',
      payload: { body: 'What goes with my navy blazer?' },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: number }>().id;
  };

  const STAMPING: Record<string, () => Promise<Written>> = {
    async claim_agent_request() {
      const id = await askAgent();
      await tool(t, token, 'claim_agent_request', { id });
      return { requestClaim: [id] };
    },
    async answer_agent_request() {
      const id = await askAgent();
      await tool(t, token, 'claim_agent_request', { id });
      await tool(t, token, 'answer_agent_request', { id, answer: 'Done' });
      return { requestAnswer: [id] };
    },
    async create_outfit() {
      const made = await tool<{ id: number }>(t, token, 'create_outfit', {
        garmentIds: [g.top1, g.bottom1],
        scheduleDate: day(1),
      });
      const entry = await entryOf(made.id);
      expect(entry.plannedBy).toBe('agent');
      return { outfit: [made.id], calendarEntry: [entry.id] };
    },
    async schedule_outfit() {
      const own = await ownOutfit([g.top2, g.bottom2]);
      await tool(t, token, 'schedule_outfit', { outfitId: own, date: day(2) });
      const planned = await entryOf(own);
      // And the replace: the person's entry becomes the agent's choice.
      const mine = await ownOutfit([g.top3, g.bottom3]);
      const personal = await planAsPerson(mine, day(3));
      const replaced = await tool<{ entryId: number }>(
        t,
        token,
        'schedule_outfit',
        { outfitId: own, date: day(3), replaceEntryId: personal },
      );
      expect(replaced.entryId).toBe(personal);
      return { calendarEntry: [planned.id, personal] };
    },
    async pick_outfit() {
      const saved = await tool<{ id: number }>(t, token, 'pick_outfit', {
        garmentIds: [g.top4, g.bottom4],
      });
      const dated = await tool<{ id: number }>(t, token, 'pick_outfit', {
        garmentIds: [g.top5, g.bottom5],
        date: day(4),
      });
      const entry = await entryOf(dated.id);
      return { outfit: [saved.id, dated.id], calendarEntry: [entry.id] };
    },
    async plan_trip_outfit() {
      const own = await ownOutfit([g.top6, g.bottom6]);
      await tool(t, token, 'plan_trip_outfit', { tripId, outfitId: own });
      const idea = await tool<{ outfitId: number }>(
        t,
        token,
        'plan_trip_outfit',
        { tripId, garmentIds: [g.top7, g.bottom7] },
      );
      return {
        tripOutfit: [
          await tripOutfitOf(own),
          await tripOutfitOf(idea.outfitId),
        ],
        outfit: [idea.outfitId],
      };
    },
    async add_garment_from_link() {
      const added = await tool<{ garment: { id: number } }>(
        t,
        token,
        'add_garment_from_link',
        { url: sites.url('/products/tee') },
      );
      return { garment: [added.garment.id] };
    },
  };

  /** Each `none` tool's write, which must stamp nothing. */
  const UNSTAMPED: Record<string, () => Promise<void>> = {
    async update_garment() {
      await tool(t, token, 'update_garment', { id: g.top1, brand: 'Edited' });
    },
    async add_garment_copy() {
      await tool(t, token, 'add_garment_copy', { id: g.top2 });
    },
    async mark_worn() {
      await tool(t, token, 'mark_worn', { garmentId: g.top3 });
    },
    async mark_washed() {
      await tool(t, token, 'mark_washed', { garmentIds: [g.top3] });
    },
    async plan_week() {
      // The planner's choice, the agent only pressed the button: `auto`.
      // Evenings every day: slots no other scenario fills.
      await asFixture(t.db, (tx) =>
        tx.insert(weekTemplate).values(
          WEEKDAYS.map((weekday) => ({
            userId: t.owner.id,
            weekday,
            occasion: 'evening' as const,
          })),
        ),
      );
      const before = await t.db.$count(outfitCalendar);
      await tool(t, token, 'plan_week', {});
      expect(await t.db.$count(outfitCalendar)).toBeGreaterThan(before);
    },
    async add_inspiration() {
      await tool(t, token, 'add_inspiration', { url: sites.url('/lookbook') });
    },
    async set_inspiration_pieces() {
      const look = await tool<{ id: number }>(t, token, 'add_inspiration', {
        url: sites.url('/lookbook'),
      });
      await tool(t, token, 'set_inspiration_pieces', {
        id: look.id,
        pieces: [{ role: 'top', colors: ['white'] }],
      });
    },
    async set_capsule_membership() {
      const id = await asFixture(t.db, (tx) =>
        createCapsule(tx, t.owner.id, { name: 'Office', notes: null }),
      );
      await tool(t, token, 'set_capsule_membership', {
        id,
        add: [g.top1, g.bottom1],
      });
    },
  };

  /** A saved outfit of the owner's, through the API as the person. */
  async function ownOutfit(garmentIds: number[]): Promise<number> {
    const res = await t.api(device, {
      method: 'POST',
      url: '/api/v1/outfits',
      payload: {
        slots: garmentIds.map((garmentId) => ({ category: 'tops', garmentId })),
      },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    return res.json<{ id: number }>().id;
  }

  async function planAsPerson(outfitId: number, on: string): Promise<number> {
    const res = await t.api(device, {
      method: 'POST',
      url: '/api/v1/calendar-entries',
      payload: { outfitId, day: on },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: number }>().id;
  }

  let device: string;

  beforeAll(async () => {
    sites = await startLinkSites();
    sites.serve('/img/tee.jpg', jpeg(await productShot('#223355')));
    sites.serve('/look.jpg', jpeg(await productShot('#eeeeee')));
    sites.serve(
      '/lookbook',
      html(
        `<html><head><title>White tee</title><meta property="og:image" content="${sites.url('/look.jpg')}"></head><body></body></html>`,
      ),
    );
    sites.serve(
      '/products/tee',
      html(`<!doctype html><html><head><title>Pocket Tee</title>
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'Product',
        name: 'Heavyweight Pocket Tee',
        image: [sites.url('/img/tee.jpg')],
        offers: { price: '48.00', priceCurrency: 'USD' },
      })}</script></head><body></body></html>`),
    );
    t = await createTestApp({}, { outboundFetch: sites.outboundFetch });
    for (let i = 1; i <= 7; i += 1) {
      g[`top${i}`] = await createGarment(t, {
        name: `Tee ${i}`,
        category: 'tops',
      });
      g[`bottom${i}`] = await createGarment(t, {
        name: `Jeans ${i}`,
        category: 'bottoms',
      });
    }
    token = await createAccessToken(t, { name: 'Laptop Claude' });
    const [row] = await t.db
      .select({ id: personalAccessToken.id })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.name, 'Laptop Claude'));
    tokenId = row.id;
    device = (await deviceToken(t)).token;
    tripId = await asFixture(t.db, (tx) =>
      createTrip(tx, t.owner.id, {
        name: 'Austin',
        destination: null,
        startsOn: day(10),
        endsOn: day(12),
        notes: null,
      }),
    );
  });

  afterAll(async () => {
    await t?.cleanup();
    await sites?.close();
  });

  it('classifies every writing tool, and has a scenario for each', () => {
    const classified = (kind: 'stamps' | 'none') =>
      Object.entries(MCP_WRITES)
        .filter(([, write]) => kind in write.attribution)
        .map(([name]) => name)
        .sort();
    expect(Object.keys(STAMPING).sort()).toEqual(classified('stamps'));
    expect(Object.keys(UNSTAMPED).sort()).toEqual(classified('none'));
  });

  it.each(Object.keys(STAMPING))(
    '%s stamps its rows with the token',
    async (name) => {
      const written = await STAMPING[name]();
      const declared = MCP_WRITES[name].attribution;
      if (!('stamps' in declared)) throw new Error(`${name} stamps nothing`);
      expect(Object.keys(written).sort()).toEqual([...declared.stamps].sort());
      for (const tokens of Object.values(await stampsOf(written))) {
        expect(tokens).toEqual(tokens.map(() => tokenId));
      }
    },
  );

  it.each(Object.keys(UNSTAMPED))('%s stamps nothing', async (name) => {
    expect(
      'none' in MCP_WRITES[name].attribution,
      `${name} is classified none`,
    ).toBe(true);
    const before = await stampedCount();
    await UNSTAMPED[name]();
    expect(await stampedCount()).toBe(before);
  });

  async function stampedCount(): Promise<number> {
    const counts = await Promise.all([
      t.db.$count(outfit, isNotNull(outfit.addedByTokenId)),
      t.db.$count(outfitCalendar, isNotNull(outfitCalendar.plannedByTokenId)),
      t.db.$count(tripOutfit, isNotNull(tripOutfit.plannedByTokenId)),
      t.db.$count(garment, isNotNull(garment.addedByTokenId)),
      t.db.$count(agentRequest, isNotNull(agentRequest.claimedByTokenId)),
      t.db.$count(agentRequest, isNotNull(agentRequest.answeredByTokenId)),
    ]);
    return counts.reduce((a, b) => a + b, 0);
  }

  it("the person's twin over the API stamps nothing, and takes an agent entry over", async () => {
    const own = await ownOutfit([g.top1, g.bottom2]);
    await tool(t, token, 'schedule_outfit', { outfitId: own, date: day(5) });
    const agents = await entryOf(own);
    expect((await entryOf(own)).plannedBy).toBe('agent');
    // The person planning the same outfit that day makes it theirs.
    const res = await t.api(device, {
      method: 'POST',
      url: '/api/v1/calendar-entries',
      payload: { outfitId: own, day: day(5) },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await stampColumn('calendarEntry', [agents.id])).toEqual([null]);
    expect((await entryOf(own)).plannedBy).toBe('user');
  });

  it('names the token in the API and the feed, and keeps it readable once revoked', async () => {
    const own = await ownOutfit([g.top2, g.bottom3]);
    await tool(t, token, 'schedule_outfit', { outfitId: own, date: day(6) });
    const read = async () => {
      const res = await t.api(device, {
        method: 'GET',
        url: `/api/v1/calendar-entries?from=${day(6)}&to=${day(6)}`,
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{
        data: { plannedBy: string; agent?: { name: string } }[];
      }>().data;
    };
    expect(await read()).toContainEqual(
      expect.objectContaining({
        plannedBy: 'agent',
        agent: { name: 'Laptop Claude' },
      }),
    );
    // Revoked tokens stay as rows: the name is still the token's.
    await t.db
      .update(personalAccessToken)
      .set({ revokedAt: new Date() })
      .where(eq(personalAccessToken.id, tokenId));
    expect(await read()).toContainEqual(
      expect.objectContaining({ agent: { name: 'Laptop Claude' } }),
    );
    // Back in service for the scenarios after this one.
    await t.db
      .update(personalAccessToken)
      .set({ revokedAt: null })
      .where(eq(personalAccessToken.id, tokenId));
    // A hand-made entry carries no agent.
    const mine = await ownOutfit([g.top4, g.bottom5]);
    const entryId = await planAsPerson(mine, day(6));
    const hand = (await read()).find(
      (e) => 'id' in e && (e as { id: number }).id === entryId,
    );
    expect(hand).toMatchObject({ plannedBy: 'user' });
    expect(hand).not.toHaveProperty('agent');
  });
  it('keeps what the agent made out of the agent’s inbox and proposals: only the explicit markers make one', async () => {
    // An agent-made outfit and an agent's link import carry the token, not
    // the proposal's or the suggestion's mark (proposed_at, suggested_at).
    const made = await tool<{ id: number }>(t, token, 'create_outfit', {
      garmentIds: await freshPair('made'),
    });
    const imported = await tool<{ garment: { id: number } }>(
      t,
      token,
      'add_garment_from_link',
      { url: sites.url('/products/tee') },
    );
    const proposed = await tool<{ id: number }>(t, token, 'suggest_outfit', {
      garmentIds: await freshPair('proposed'),
      note: 'Weekend',
    });
    expect(await stampColumn('outfit', [made.id, proposed.id])).toEqual([
      tokenId,
      tokenId,
    ]);

    const outfits = async (query: string) => {
      const res = await t.api(device, {
        method: 'GET',
        url: `/api/v1/outfits?${query}`,
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ data: { id: number }[] }>().data.map(({ id }) => id);
    };
    const waiting = await outfits('proposed=true');
    expect(waiting).toContain(proposed.id);
    expect(waiting).not.toContain(made.id);
    expect(await outfits('limit=100')).toContain(made.id);

    const inbox = await t.api(device, {
      method: 'GET',
      url: '/api/v1/wishlist',
    });
    expect(inbox.statusCode, inbox.body).toBe(200);
    const { items, needs, readyToBuy } = inbox.json<{
      items: { id: number; fromAgent: boolean }[];
      needs: unknown[];
      readyToBuy: unknown[];
    }>();
    expect(items).toContainEqual(
      expect.objectContaining({ id: imported.garment.id, fromAgent: false }),
    );
    expect(needs).toEqual([]);
    expect(readyToBuy).toEqual([]);
    // Its page is the plain wishlist item's: no "Why the agent suggests this".
    const page = await t.inject({
      method: 'GET',
      url: `/wardrobe/${imported.garment.id}`,
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain('data-suggestion-state');
  });

  it('names the agent in the outfit resources and get_trip', async () => {
    const made = await tool<{ id: number }>(t, token, 'create_outfit', {
      garmentIds: await freshPair('trip'),
    });
    await tool(t, token, 'plan_trip_outfit', { tripId, outfitId: made.id });
    const mine = await ownOutfit([g.top6, g.bottom5]);

    const detail = await t.api(device, {
      method: 'GET',
      url: `/api/v1/outfits/${made.id}`,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({ agent: { name: 'Laptop Claude' } });
    const list = await t.api(device, {
      method: 'GET',
      url: '/api/v1/outfits?limit=100',
    });
    const listed = list.json<{ data: { id: number; agent?: unknown }[] }>()
      .data;
    expect(listed.find(({ id }) => id === made.id)).toMatchObject({
      agent: { name: 'Laptop Claude' },
    });
    expect(listed.find(({ id }) => id === mine)).not.toHaveProperty('agent');

    const trip = await tool<{
      days: { outfits: { outfitId: number; agent?: string }[] }[];
      anyDay: { outfitId: number; agent?: string }[];
    }>(t, token, 'get_trip', { tripId });
    const onTrip = [
      ...trip.anyDay,
      ...trip.days.flatMap((day) => day.outfits),
    ].filter(({ outfitId }) => outfitId === made.id);
    expect(onTrip).toEqual([
      expect.objectContaining({ agent: 'Laptop Claude' }),
    ]);
  });

  describe("a grantee's agent on a shared wardrobe", () => {
    let managerId: number;
    let managerDevice: string;
    let viewerDevice: string;
    let viewerToken: string;
    let viewerCookie: string;
    let garmentId: number;

    async function share(email: string, permission: 'MANAGE' | 'VIEW') {
      const cookie = await t.register(email);
      const granteeId = await userIdOf(t, email);
      await t.db.insert(wardrobeShare).values({
        grantorId: t.owner.id,
        granteeId,
        permission,
        inviteToken: randomUUID(),
        createdAt: new Date(),
        acceptedAt: new Date(),
      });
      return { cookie, granteeId };
    }

    /** The garment as `bearer`'s changes feed carries it, every page read. */
    async function syncedGarment(bearer: string) {
      let cursor: string | undefined;
      for (;;) {
        const res = await t.api(bearer, {
          method: 'GET',
          url: `/api/v1/changes?limit=100${cursor ? `&cursor=${cursor}` : ''}`,
        });
        expect(res.statusCode, res.body).toBe(200);
        const page = res.json<{
          changes: {
            resource: string;
            id: number;
            data: { agent?: { name: string } };
          }[];
          cursor: string;
          more: boolean;
        }>();
        const found = page.changes.find(
          (change) => change.resource === 'garment' && change.id === garmentId,
        );
        if (found) return found;
        if (!page.more) throw new Error(`garment ${garmentId} not in the feed`);
        cursor = page.cursor;
      }
    }

    /** The garment's agent as `bearer` reads it through the API and the feed. */
    async function agentAs(bearer: string) {
      const res = await t.api(bearer, {
        method: 'GET',
        url: `/api/v1/garments/${garmentId}?ownerId=${t.owner.id}`,
      });
      expect(res.statusCode, res.body).toBe(200);
      const synced = await syncedGarment(bearer);
      const api = res.json<{ agent?: { name: string } }>().agent?.name;
      expect(synced.data.agent?.name).toBe(api);
      return api;
    }

    beforeAll(async () => {
      const manager = await share('dana@example.com', 'MANAGE');
      managerId = manager.granteeId;
      await t.db
        .update(user)
        .set({ firstName: 'Dana' })
        .where(eq(user.id, managerId));
      const managerToken = await createAccessToken(t, {
        cookie: manager.cookie,
        name: 'Dana’s laptop',
      });
      managerDevice = (await deviceToken(t, { email: 'dana@example.com' }))
        .token;
      const viewer = await share('sam@example.com', 'VIEW');
      viewerCookie = viewer.cookie;
      viewerToken = await createAccessToken(t, {
        cookie: viewer.cookie,
        name: 'Sam’s agent token',
      });
      viewerDevice = (await deviceToken(t, { email: 'sam@example.com' })).token;
      const added = await tool<{ garment: { id: number } }>(
        t,
        managerToken,
        'add_garment_from_link',
        { url: sites.url('/products/tee'), ownerId: t.owner.id },
      );
      garmentId = added.garment.id;
    });

    it('shows its author the token\'s name, the owner the grantee\'s first name, anyone else "Agent"', async () => {
      expect(await agentAs(managerDevice)).toBe('Dana’s laptop');
      expect(await agentAs(device)).toBe('Dana’s agent');
      expect(await agentAs(viewerDevice)).toBe('Agent');
      const got = await tool<{ agent?: string }>(
        t,
        viewerToken,
        'get_garment',
        {
          id: garmentId,
          ownerId: t.owner.id,
        },
      );
      expect(got.agent).toBe('Agent');
      const own = await tool<{ agent?: string }>(t, token, 'get_garment', {
        id: garmentId,
      });
      expect(own.agent).toBe('Dana’s agent');
    });

    it('names the agent to the owner and "Agent" to a grantee, on its needs and suggestions', async () => {
      // Outfits (the agent's proposals included) are the owner's alone: no
      // grantee reads one, so needs and picks are where the rule shows.
      sites.serve(
        '/products/knit',
        html(`<!doctype html><html><head><title>Knit</title>
        <script type="application/ld+json">${JSON.stringify({
          '@type': 'Product',
          name: 'Grey Knit',
          image: [sites.url('/img/tee.jpg')],
          offers: { price: '90.00', priceCurrency: 'USD' },
        })}</script></head><body></body></html>`),
      );
      const need = await tool<{ id: number }>(t, token, 'create_option_group', {
        name: 'A grey knit',
      });
      const pick = await tool<{ id: number }>(t, token, 'suggest_garment', {
        url: sites.url('/products/knit'),
        groupId: need.id,
        category: 'tops',
      });
      const needAgent = async (bearer: string) => {
        const res = await t.api(bearer, {
          method: 'GET',
          url: `/api/v1/wishlist?ownerId=${t.owner.id}`,
        });
        expect(res.statusCode, res.body).toBe(200);
        return res
          .json<{ needs: { need: { id: number; agent?: string } }[] }>()
          .needs.find((entry) => entry.need.id === need.id)?.need.agent;
      };
      expect(await needAgent(device)).toBe('Laptop Claude');
      expect(await needAgent(viewerDevice)).toBe('Agent');
      const fromAgent = async (cookie: string | undefined) => {
        const res = await t.inject({
          method: 'GET',
          url: `/wardrobe/${pick.id}?ownerId=${t.owner.id}`,
          headers: cookie ? { cookie } : {},
        });
        expect(res.statusCode).toBe(200);
        return /data-from-agent="">([^<]*)</.exec(unescapeHtml(res.body))?.[1];
      };
      expect(await fromAgent(undefined)).toBe('From Laptop Claude');
      expect(await fromAgent(viewerCookie)).toBe('From Agent');
    });

    it('still says "Agent" to the owner once the grantee\'s account is gone', async () => {
      await deleteAccount(
        { db: t.db, photos: t.photos, logger: t.logger },
        managerId,
      );
      expect(await agentAs(device)).toBe('Agent');
      const page = await t.inject({
        method: 'GET',
        url: `/wardrobe/${garmentId}`,
      });
      expect(page.statusCode).toBe(200);
    });
  });
});
