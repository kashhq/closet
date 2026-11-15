import { and, eq } from 'drizzle-orm';
import { PassThrough, Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment } from '../../src/db/schema';
import { runSeed } from '../../src/seed/seed';
import { deviceToken } from './api';
import {
  createTestApp,
  OWNER_EMAIL,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import { callTool, createAccessToken, tool } from './mcp';

/**
 * The MCP endpoint against the seed personas (#32, #33), the loop the
 * owner runs: Theo (demo) shared with the owner, the owner's Claude
 * searching his wardrobe and comparing it with their own; and the seed's
 * own token (`--token`), with which Theo's Claude reads his closet and
 * compares it with Dana's (sparse), shared with him. And the keyword
 * search over Theo's closet (#673): the grid's, the API's and
 * search_garments' one predicate.
 */
describe('MCP over the seed personas', () => {
  let t: TestApp;
  let stdout = '';
  let demoToken: string;
  let ownerToken: string;

  beforeAll(async () => {
    t = await createTestApp();
    const output = new PassThrough();
    output.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    const status = await runSeed({
      args: [
        ...['--persona', 'demo', '--persona', 'sparse'],
        ...['--anchor', '2026-09-26', '--password-stdin'],
        ...['--share-with', OWNER_EMAIL, '--token'],
      ],
      db: t.db,
      photos: t.photos,
      logger: t.logger,
      timeZone: 'America/New_York',
      weatherEnabled: true,
      input: Readable.from(['Closet-demo-1\n']),
      output,
      errors: new PassThrough(),
      now: new Date('2026-09-26T16:00:00Z'),
    });
    expect(status, stdout).toBe(0);
    demoToken = /demo: MCP token (closet_\S+) /.exec(stdout)![1];
    ownerToken = await createAccessToken(t);
  }, 120_000);

  afterAll(async () => {
    await t?.cleanup();
  });

  it('prints each persona’s token once, and never logs it', () => {
    expect(stdout.match(/MCP token closet_/g)).toHaveLength(2);
    expect(JSON.stringify(t.logs.records)).not.toContain(demoToken);
  });

  it('audits a seed-minted token as the command line’s, not a page’s', () => {
    expect(t.logs.ops('token.created')).toContainEqual(
      expect.objectContaining({ surface: 'cli' }),
    );
  });

  it('lets the owner’s Claude search Theo’s wardrobe through the share', async () => {
    const demoId = await userIdOf(t, 'demo@closet.invalid');
    const { wardrobes } = await tool<{
      wardrobes: { ownerId: number; name: string; permission: string }[];
    }>(t, ownerToken, 'list_shared_wardrobes');
    expect(wardrobes).toContainEqual({
      ownerId: demoId,
      name: 'Theo',
      permission: 'VIEW',
    });
    const boots = await tool<{ total: number; garments: { role: string }[] }>(
      t,
      ownerToken,
      'search_garments',
      { ownerId: demoId, category: 'footwear' },
    );
    expect(boots.total).toBeGreaterThan(0);
    expect(new Set(boots.garments.map((g) => g.role))).toEqual(
      new Set(['footwear']),
    );
    const office = await tool<{ capsules: { name: string }[] }>(
      t,
      ownerToken,
      'list_capsules',
      { ownerId: demoId },
    );
    expect(office.capsules.map((c) => c.name)).toContain('Office');
  });

  it('compares the owner’s (empty) closet with Theo’s: every kind is a gap', async () => {
    const demoId = await userIdOf(t, 'demo@closet.invalid');
    const compared = await tool<{
      counts: Record<string, { owned: number; shared: number }>;
      gaps: { kind: string; shared: { price: string | null }[] }[];
      overlap: unknown[];
      complete: boolean;
    }>(t, ownerToken, 'compare_with_shared_wardrobe', { ownerId: demoId });
    expect(compared.complete).toBe(true);
    expect(compared.overlap).toEqual([]);
    expect(compared.counts.top.shared).toBeGreaterThan(0);
    // Theo's pieces are real products: the gaps come with prices.
    expect(
      compared.gaps.some((gap) => gap.shared.some((g) => g.price !== null)),
    ).toBe(true);
  });

  it('judges each of Theo’s wishlist items against his closet (#18b)', async () => {
    interface Answer {
      outfits: { count: number; capped: boolean; cap: number };
      best: { garments: { id: number }[]; atItemsFormality: boolean }[];
      pairsWith: { role: string; goWithIt: number; inCloset: number }[];
      nearDuplicates: { name: string; replacesIt: boolean }[];
    }
    const { items } = await tool<{ items: { id: number; name: string }[] }>(
      t,
      demoToken,
      'list_wishlist',
    );
    const judge = async (name: string) => {
      const item = items.find((i) => i.name === name)!;
      const answer = await tool<Answer>(t, demoToken, 'goes_with_closet', {
        garmentId: item.id,
      });
      for (const idea of answer.best) {
        expect(idea.garments.map((g) => g.id)).toContain(item.id);
      }
      return { id: item.id, answer };
    };

    // W01, the grey merino: like for like with the pilling one (T21), and
    // with everything he owns; the best at its formality (3) first.
    const merino = (await judge('New grey merino crewneck')).answer;
    expect(merino.outfits).toEqual({ count: 50, capped: true, cap: 50 });
    expect(merino.best[0].atItemsFormality).toBe(true);
    expect(merino.nearDuplicates).toEqual([
      expect.objectContaining({
        name: 'Grey merino crewneck',
        replacesIt: true,
      }),
    ]);
    expect(
      merino.pairsWith.map((r) => [r.role, r.goWithIt === r.inCloset]),
    ).toEqual([
      ['layer', true],
      ['bottom', true],
      ['footwear', true],
    ]);
    // W02, the padded shirt jacket: the layer of every outfit, no twin
    // (the olive chore coat is a jacket of another colour).
    const jacket = (await judge('Padded shirt jacket')).answer;
    expect(jacket.outfits.capped).toBe(true);
    expect(jacket.pairsWith.map((r) => r.role)).toEqual([
      'top',
      'bottom',
      'footwear',
    ]);
    expect(jacket.nearDuplicates).toEqual([]);
    // W03, the Allbirds: he already has white sneakers.
    const couriers = await judge('White Couriers');
    expect(couriers.answer.nearDuplicates).toEqual([
      expect.objectContaining({ name: 'White sneakers', replacesIt: false }),
    ]);
    // The owner sees Theo's wishlist through the share, never this.
    const refused = await callTool(t, ownerToken, 'goes_with_closet', {
      garmentId: couriers.id,
    });
    expect(refused.value.error).toBe('Not on your wishlist');
  });

  it('lets Theo’s own token read his closet and compare it with Dana’s', async () => {
    const sparseId = await userIdOf(t, 'sparse@closet.invalid');
    const own = await tool<{ total: number }>(t, demoToken, 'search_garments');
    expect(own.total).toBe(80);
    const compared = await tool<{
      overlap: unknown[];
      onlyOwned: unknown[];
    }>(t, demoToken, 'compare_with_shared_wardrobe', { ownerId: sparseId });
    expect(compared.overlap.length).toBeGreaterThan(0);
    expect(compared.onlyOwned.length).toBeGreaterThan(0);
    const laundry = await tool<{ garments: unknown[] }>(
      t,
      demoToken,
      'laundry_status',
    );
    expect(Array.isArray(laundry.garments)).toBe(true);
  });

  it('reads Theo’s Austin conference (#10) and its packing list; the owner’s token sees no trip', async () => {
    const { trips } = await tool<{
      trips: { id: number; name: string; phase: string; outfits: number }[];
    }>(t, demoToken, 'list_trips');
    expect(trips).toEqual([
      expect.objectContaining({
        name: 'Austin conference',
        phase: 'past',
        outfits: 5,
      }),
    ]);
    const read = await tool<{
      located: boolean;
      packing: {
        garments: number;
        packed: number;
        groups: {
          role: string;
          garments: {
            name: string;
            wears: number;
            copiesNeeded: number;
            warnings: unknown[];
          }[];
        }[];
      };
      extras: { label: string; packed: boolean }[];
    }>(t, demoToken, 'get_trip', { tripId: trips[0].id });
    expect(read.located).toBe(true);
    expect(read.packing).toMatchObject({ garments: 15, packed: 9 });
    const tops = read.packing.groups.find((g) => g.role === 'top')!;
    // The travel tee on both flying days: two wears, two copies (k = 1).
    expect(tops.garments).toContainEqual(
      expect.objectContaining({
        name: 'Charcoal heavyweight tee',
        wears: 2,
        copiesNeeded: 2,
      }),
    );
    // A finished trip's list is a record: no warnings.
    expect(
      read.packing.groups.flatMap((g) => g.garments.flatMap((r) => r.warnings)),
    ).toEqual([]);
    expect(read.extras.filter((e) => e.packed)).toHaveLength(3);
    const owners = await tool<{ trips: unknown[] }>(
      t,
      ownerToken,
      'list_trips',
    );
    expect(owners.trips).toEqual([]);
    const refused = await callTool(t, ownerToken, 'get_trip', {
      tripId: trips[0].id,
    });
    expect(refused.value.error).toBe('Trip not found');
  });

  // The owner searches Theo's closet through the VIEW share on all three
  // surfaces; each answer fits one page (the closet is 80 garments).
  describe('the keyword search over Theo’s closet (#673)', () => {
    let demoId: number;
    let apiToken: string;
    const names = new Map<number, string>();

    beforeAll(async () => {
      demoId = await userIdOf(t, 'demo@closet.invalid');
      apiToken = (await deviceToken(t, { email: OWNER_EMAIL })).token;
      const rows = await t.db
        .select({ id: garment.id, name: garment.name })
        .from(garment)
        .where(eq(garment.ownerId, demoId));
      for (const row of rows) names.set(row.id, row.name ?? '');
    });

    /** The grid's names in page order, once the API and MCP give its ids. */
    const search = async (keyword: string): Promise<string[]> => {
      const query = `ownerId=${demoId}&keyword=${encodeURIComponent(keyword)}`;
      const page = await t.inject({ method: 'GET', url: `/wardrobe?${query}` });
      expect(page.statusCode).toBe(200);
      const grid = [
        ...unescapeHtml(page.body).matchAll(
          /<a href="\/wardrobe\/(\d+)[^"]*"[^>]*data-tile=""/g,
        ),
      ].map((m) => Number(m[1]));
      const api = await t.api(apiToken, {
        method: 'GET',
        url: `/api/v1/garments?${query}`,
      });
      expect(api.statusCode, api.body).toBe(200);
      const listed = api.json<{ data: { id: number }[] }>().data;
      expect(listed.map((g) => g.id)).toEqual(grid);
      const mcp = await tool<{ garments: { id: number }[] }>(
        t,
        ownerToken,
        'search_garments',
        { ownerId: demoId, keyword },
      );
      expect(mcp.garments.map((g) => g.id)).toEqual(grid);
      return grid.map((id) => names.get(id)!);
    };

    it('needs every word, in any order, matched through colour and type labels', async () => {
      const blueShirts = await search('blue shirt');
      // Shirt-typed and blue; then the chinos, whose notes name "the linen
      // shirt": a notes-only match ranks after them.
      expect(new Set(blueShirts.slice(0, 3))).toEqual(
        new Set(['Blue oxford', 'Western denim shirt', 'Plaid flannel']),
      );
      expect(blueShirts.slice(3)).toEqual(['Navy chinos']);
      expect(await search('navy blazer')).toEqual(['Navy blazer']);
      expect(await search('blazer navy')).toEqual(['Navy blazer']);
    });

    it('folds punctuation on both sides: "jcrew" is "J.Crew"', async () => {
      const jcrew = await search('jcrew');
      expect(await search('J.Crew')).toEqual(jcrew);
      const brand = await t.db
        .select({ id: garment.id })
        .from(garment)
        .where(
          and(
            eq(garment.ownerId, demoId),
            eq(garment.brand, 'J.Crew'),
            eq(garment.status, 'closet'),
          ),
        );
      expect(brand.length).toBeGreaterThan(0);
      expect(jcrew).toHaveLength(brand.length);
    });

    it('ranks a notes-only match below every name or type match', async () => {
      const tees = await search('tee');
      // The blazer's notes say "over a tee or oxford".
      const blazer = tees.indexOf('Navy blazer');
      expect(blazer).toBeGreaterThan(0);
      for (const [index, name] of tees.entries()) {
        if (/\btee\b/i.test(name)) expect(index).toBeLessThan(blazer);
      }
    });
  });
});
