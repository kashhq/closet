import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  capsuleGarment,
  garment,
  garmentWear,
  outfit,
  outfitCalendar,
  personalAccessToken,
} from '../../src/db/schema';
import { createCapsule } from '../../src/web/capsules/queries';
import { t as text } from '../../src/web/i18n';
import { HttpError } from '../../src/web/errors';
import { MCP_WRITES } from '../../src/web/api/operations';
import { MAX_TOOL_INPUT_ELEMENTS } from '../../src/web/mcp/routes';
import { mcpTools } from '../../src/web/mcp/tools';
import { defineTool, registerTools } from '../../src/web/mcp/tool';
import { acceptInvite, createInvite } from '../../src/web/sharing/queries';
import { deleteGarment } from '../../src/web/wardrobe/queries';
import {
  createTestApp,
  type TestApp,
  recordQueries,
  TEST_PASSWORD,
  uniqueClient,
  userIdOf,
  asFixture,
} from './harness';
import { interleave } from './interleave';
import {
  html,
  jpeg,
  type LinkSites,
  productShot,
  startLinkSites,
} from './link-sites';
import {
  callTool,
  createAccessToken,
  mcpRequest,
  mintToken,
  tool,
} from './mcp';

/**
 * The MCP endpoint (#33) driven like a client: JSON-RPC over POST /mcp
 * with a personal access token. Auth (and that a refusal says nothing),
 * every tool's happy path, access through shares exactly as the pages
 * grant it, the per-token rate limit, the same-origin rule for a bearer
 * route, and that no log line carries a token.
 */

interface Garment {
  id: number;
  name: string;
}

describe('the MCP endpoint', () => {
  let t: TestApp;
  let sites: LinkSites;
  let token: string;
  let viewer: { cookie: string; id: number; token: string };
  let manager: { cookie: string; id: number; token: string };
  const issued: string[] = [];
  const garments: Record<string, Garment> = {};
  let capsuleId: number;

  /** A garment of `ownerId`'s through the garment form (POST /wardrobe). */
  const addGarment = async (
    name: string,
    fields: Record<string, string>,
    cookie?: string,
  ): Promise<Garment> => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      payload: { name, props: '1', ...fields },
      headers: cookie ? { cookie } : {},
    });
    expect(res.statusCode, res.body).toBe(302);
    return {
      id: Number(/^\/wardrobe\/(\d+)/.exec(String(res.headers.location))![1]),
      name,
    };
  };

  const signUp = async (email: string) => {
    const cookie = await t.register(email);
    const id = await userIdOf(t, email);
    const own = await createAccessToken(t, { cookie });
    issued.push(own);
    return { cookie, id, token: own };
  };

  const share = async (granteeId: number, permission: 'VIEW' | 'MANAGE') => {
    const invite = await createInvite(t.db, t.owner.id, permission);
    const accepted = await acceptInvite(t.db, invite.inviteToken, granteeId);
    expect(accepted.accepted).toBe(true);
  };

  beforeAll(async () => {
    sites = await startLinkSites();
    sites.serve('/img/tee.jpg', jpeg(await productShot('#223355')));
    sites.serve(
      '/products/tee',
      html(`<!doctype html><html><head><title>Pocket Tee</title>
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'Product',
        name: 'Heavyweight Pocket Tee',
        brand: { '@type': 'Brand', name: 'Studio Knit' },
        color: 'Navy',
        image: [sites.url('/img/tee.jpg')],
        offers: { price: '48.00', priceCurrency: 'USD' },
      })}</script></head><body></body></html>`),
    );
    sites.serve('/products/mystery', html('<html><body>Hello</body></html>'));
    sites.serve('/products/limited', {
      status: 429,
      type: 'text/html',
      body: '<title>Too many requests</title>',
    });
    t = await createTestApp({}, { outboundFetch: sites.outboundFetch });

    garments.tee = await addGarment('White Tee', {
      category: 'tops',
      type: 't-shirt',
      color: 'white',
      warmth: '2',
      formality: '2',
    });
    garments.jeans = await addGarment('Raw Denim', {
      category: 'bottoms',
      type: 'jeans',
      color: 'blue',
    });
    garments.boots = await addGarment('Chelsea Boots', {
      category: 'footwear',
      type: 'boots',
      color: 'brown',
    });

    capsuleId = (await createCapsule(t.db, t.owner.id, {
      name: 'Office',
      notes: null,
    })) as number;

    token = await createAccessToken(t);
    issued.push(token);
    viewer = await signUp('viewer@example.com');
    manager = await signUp('manager@example.com');
    await share(viewer.id, 'VIEW');
    await share(manager.id, 'MANAGE');
  });

  afterAll(async () => {
    await t?.cleanup();
    await sites?.close();
  });

  describe('authentication', () => {
    const refusals: [string, () => Record<string, string>][] = [
      ['no Authorization header', () => ({})],
      ['a malformed header', () => ({ authorization: `Token ${token}` })],
      [
        'an unknown token',
        () => ({
          authorization: `Bearer closet_${'A'.repeat(43)}`,
        }),
      ],
      ['a session cookie instead', () => ({ cookie: t.owner.cookie })],
    ];

    it.each(refusals)('refuses %s with a bare 401', async (_name, headers) => {
      const res = await mcpRequest(t, undefined, 'tools/list', {}, headers());
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer realm="closet"');
      expect(res.json()).toEqual({
        statusCode: 401,
        message: 'Unauthorized',
        request_id: res.headers['x-request-id'],
      });
    });

    it('refuses a revoked token the same way, and says nothing more', async () => {
      const doomed = await createAccessToken(t, { name: 'Doomed' });
      issued.push(doomed);
      expect((await mcpRequest(t, doomed, 'tools/list')).statusCode).toBe(200);
      const [row] = await t.db
        .select({ id: personalAccessToken.id })
        .from(personalAccessToken)
        .where(eq(personalAccessToken.name, 'Doomed'));
      const revoke = await t.inject({
        method: 'POST',
        url: `/auth/tokens/${row.id}/revoke`,
      });
      expect(revoke.statusCode).toBe(303);
      const res = await mcpRequest(t, doomed, 'tools/list');
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({
        statusCode: 401,
        message: 'Unauthorized',
        request_id: res.headers['x-request-id'],
      });
    });

    it('refuses a device token (#189) with the same 401 as an unknown one, recording no use', async () => {
      const device = await mintToken(t, t.owner.id, 'Phone', 'device');
      if (!device.created) throw new Error('no device token');
      issued.push(device.token);
      t.logs.clear();
      const res = await mcpRequest(t, device.token, 'tools/list');
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer realm="closet"');
      expect(res.json()).toEqual({
        statusCode: 401,
        message: 'Unauthorized',
        request_id: res.headers['x-request-id'],
      });
      const [row] = await t.db
        .select({ lastUsedAt: personalAccessToken.lastUsedAt })
        .from(personalAccessToken)
        .where(eq(personalAccessToken.id, device.id));
      expect(row.lastUsedAt).toBeNull();
      const refused = t.logs.messages('warn', 'Mcp');
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatch(
        /^MCP POST \/mcp refused: wrong kind of token \(wants mcp\) from /,
      );
    });

    it('answers GET and DELETE with 405 (stateless: no stream, no session)', async () => {
      for (const method of ['GET', 'DELETE'] as const) {
        const res = await t.inject({
          method,
          url: '/mcp',
          anonymous: true,
          sameOrigin: false,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(405);
      }
    });

    it('lets a request without Origin through and refuses a foreign one', async () => {
      const foreign = await mcpRequest(
        t,
        token,
        'tools/list',
        {},
        {
          origin: 'https://evil.example',
        },
      );
      expect(foreign.statusCode).toBe(403);
      const own = await mcpRequest(
        t,
        token,
        'tools/list',
        {},
        {
          origin: 'http://localhost',
        },
      );
      expect(own.statusCode).toBe(200);
    });

    it('records when a token was last used', async () => {
      await mcpRequest(t, token, 'tools/list');
      const rows = await t.db
        .select({ lastUsedAt: personalAccessToken.lastUsedAt })
        .from(personalAccessToken)
        .where(eq(personalAccessToken.userId, t.owner.id));
      expect(rows.some((row) => row.lastUsedAt !== null)).toBe(true);
    });
  });

  describe('the protocol', () => {
    it('initializes statelessly: no session id', async () => {
      const res = await mcpRequest(t, token, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'spec', version: '1' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['mcp-session-id']).toBeUndefined();
      const { result } = res.json<{
        result: { serverInfo: { name: string }; instructions: string };
      }>();
      expect(result.serverInfo.name).toBe('Closet');
      expect(result.instructions).toContain('nothing deletes');
      // The styling workflow (#269; Muse's since #337): feedback first,
      // and the owner buys.
      expect(result.instructions).toContain(
        'Start every conversation with get_suggestion_feedback',
      );
      expect(result.instructions).toContain('never buy');
    });

    it('lists every tool; each write says it writes and none is destructive', async () => {
      const res = await mcpRequest(t, token, 'tools/list');
      const { tools } = res.json<{
        result: {
          tools: {
            name: string;
            description: string;
            annotations: { readOnlyHint: boolean; destructiveHint: boolean };
          }[];
        };
      }>().result;
      expect(tools.map((listed) => listed.name).sort()).toEqual(
        [
          'add_garment_copy',
          'add_garment_from_link',
          'add_inspiration',
          'compare_with_shared_wardrobe',
          'create_option_group',
          'create_outfit',
          'finish_round',
          'get_calendar',
          'get_capsule',
          'get_closet_coverage',
          'get_garment',
          'get_garment_photo',
          'get_inspiration',
          'get_outfit',
          'get_sizes',
          'get_style_profile',
          'get_suggestion_feedback',
          'get_today',
          'get_trip',
          'get_wardrobe',
          'goes_with_closet',
          'laundry_status',
          'list_capsules',
          'list_inspiration',
          'list_outfits',
          'list_shared_wardrobes',
          'list_suggestions',
          'list_trips',
          'list_wishlist',
          'mark_washed',
          'mark_worn',
          'pick_outfit',
          'plan_week',
          'plan_trip_outfit',
          'schedule_outfit',
          'search_garments',
          'set_capsule_membership',
          'set_inspiration_pieces',
          'suggest_garment',
          'suggest_outfit',
          'suggest_outfits',
          'update_garment',
          'wardrobe_stats',
        ].sort(),
      );
      for (const listed of tools) {
        expect(listed.annotations.destructiveHint).toBe(false);
        expect(listed.description.startsWith('WRITES')).toBe(
          !listed.annotations.readOnlyHint,
        );
      }
    });

    it('refuses arguments outside the schema', async () => {
      const answer = await callTool(t, token, 'get_garment', { id: 'seven' });
      expect(answer.isError).toBe(true);
    });

    it('refuses arguments over the element cap before any schema runs', async () => {
      const answer = await callTool(t, token, 'mark_washed', {
        garmentIds: Array.from(
          { length: MAX_TOOL_INPUT_ELEMENTS + 1 },
          (_, i) => i + 1,
        ),
      });
      expect(answer).toMatchObject({
        isError: true,
        value: { error: expect.stringContaining('more than the maximum') },
      });
    });
  });

  describe('a read-only token (#701)', () => {
    let readOnly: string;
    const READ_ONLY = { readOnly: true, ownWardrobeOnly: false };
    /** The tools that write nothing, by their flag, with the weather's. */
    const readTools = () =>
      mcpTools({ weather: true })
        .filter((listed) => listed.writes === false)
        .map((listed) => listed.name);

    beforeAll(async () => {
      readOnly = await createAccessToken(t, {
        name: 'Read only',
        scope: READ_ONLY,
      });
      issued.push(readOnly);
    });

    it('is told so first, and lists exactly the tools marked writes: false', async () => {
      const init = await mcpRequest(t, readOnly, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'spec', version: '1' },
      });
      expect(
        init.json<{ result: { instructions: string } }>().result.instructions,
      ).toMatch(/^This token is read-only: the tools that write/);

      const res = await mcpRequest(t, readOnly, 'tools/list');
      const { tools } = res.json<{
        result: {
          tools: { name: string; annotations: { readOnlyHint: boolean } }[];
        };
      }>().result;
      // This app has the weather off, so get_weather is not offered.
      expect(tools.map((listed) => listed.name).sort()).toEqual(
        readTools()
          .filter((name) => name !== 'get_weather')
          .sort(),
      );
      expect(tools.every((listed) => listed.annotations.readOnlyHint)).toBe(
        true,
      );
    });

    it('marks writes: false exactly the tools MCP_WRITES does not list', () => {
      const every = mcpTools({ weather: true }).map((listed) => listed.name);
      expect(new Set(readTools())).toEqual(
        new Set(every.filter((name) => !(name in MCP_WRITES))),
      );
    });

    it('calls a write tool as an unknown one: no tool error that invites a retry, nothing written, a warn line', async () => {
      const res = await mcpRequest(t, readOnly, 'tools/call', {
        name: 'update_garment',
        arguments: { id: garments.tee.id, name: 'Injected' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        jsonrpc: '2.0',
        id: expect.any(Number),
        result: {
          content: [
            {
              type: 'text',
              text: 'MCP error -32602: Tool update_garment not found',
            },
          ],
          isError: true,
        },
      });
      const [row] = await t.db
        .select({ name: garment.name })
        .from(garment)
        .where(eq(garment.id, garments.tee.id));
      expect(row.name).toBe('White Tee');
      expect(t.logs.messages('warn', 'Mcp')).toContainEqual(
        expect.stringMatching(
          /^MCP update_garment by user \d+ \(token \d+\): refused \(read-only token\)$/,
        ),
      );
      // A read still answers.
      expect(
        await tool(t, readOnly, 'get_garment', { id: garments.tee.id }),
      ).toMatchObject({ name: 'White Tee' });
    });

    it('offers no prompts and no resources, to any token', async () => {
      for (const bearer of [token, readOnly]) {
        for (const method of ['prompts/list', 'resources/list']) {
          const res = await mcpRequest(t, bearer, method);
          expect(res.statusCode).toBe(200);
          expect(res.json()).toMatchObject({
            error: { code: -32601, message: 'Method not found' },
          });
        }
      }
    });
  });

  describe('garments', () => {
    it('search_garments filters like the grid', async () => {
      const all = await tool<{ total: number; garments: Garment[] }>(
        t,
        token,
        'search_garments',
      );
      expect(all.total).toBe(3);
      const tops = await tool<{ garments: { name: string; role: string }[] }>(
        t,
        token,
        'search_garments',
        { category: 'tops', type: 't-shirt', warmth: 2 },
      );
      expect(tops.garments).toEqual([
        expect.objectContaining({ name: 'White Tee', role: 'top' }),
      ]);
      const blue = await tool<{ garments: { name: string }[] }>(
        t,
        token,
        'search_garments',
        { color: 'blue' },
      );
      expect(blue.garments.map((g) => g.name)).toEqual(['Raw Denim']);
    });

    // One paging contract for search_garments and get_capsule (#784):
    // `next` is a string, and a bare id (as answers once gave it) is the same
    // rank-0 cursor; a rank no page answers is refused.
    it('search_garments pages from a string cursor or a bare id alike', async () => {
      const page = (before: number | string) =>
        tool<{ garments: Garment[]; next: string | null }>(
          t,
          token,
          'search_garments',
          { before },
        );
      const all = await tool<{ garments: Garment[] }>(
        t,
        token,
        'search_garments',
      );
      const [newest, ...rest] = all.garments.map((g) => g.id);
      const numeric = await page(newest);
      expect(numeric.garments.map((g) => g.id)).toEqual(rest);
      expect(numeric.next).toBeNull();
      expect(await page(String(newest))).toEqual(numeric);
      const refused = await callTool(t, token, 'search_garments', {
        before: `2.${newest}`,
      });
      expect(refused.isError).toBe(true);
    });

    it('search_garments refuses a type without its category, or of another', async () => {
      expect(
        (await callTool(t, token, 'search_garments', { type: 'jeans' })).value
          .error,
      ).toMatch(/category/);
      expect(
        (
          await callTool(t, token, 'search_garments', {
            category: 'tops',
            type: 'jeans',
          })
        ).value.error,
      ).toMatch(/not a type of tops/);
    });

    it('get_garment answers everything but the photo, and the owner’s care', async () => {
      const found = await tool<Record<string, unknown>>(
        t,
        token,
        'get_garment',
        { id: garments.tee.id },
      );
      expect(found).toMatchObject({
        name: 'White Tee',
        role: 'top',
        colors: ['white'],
        properties: { type: 't-shirt', warmth: 2, formality: 2 },
        hasPhoto: false,
        care: { worn: 0 },
      });
      expect(JSON.stringify(found)).not.toContain('/file/');
    });

    it('update_garment writes properties through the form’s readers and condition', async () => {
      const updated = await tool<{
        garment: { properties: Record<string, unknown>; condition: string };
        ignored: string[];
      }>(t, token, 'update_garment', {
        id: garments.boots.id,
        waterResistant: true,
        materials: ['leather'],
        sleeve: 'long',
        // A clear of what the role lacks is no ignore.
        fit: null,
        condition: 'needs_repair',
        conditionNote: 'Heel worn down',
      });
      expect(updated.garment.properties).toMatchObject({
        waterResistant: true,
        materials: ['leather'],
        sleeve: null,
      });
      expect(updated.garment.condition).toBe('needs_repair');
      // Boots have no sleeve: named, not stored.
      expect(updated.ignored).toEqual(['sleeve']);
      const [row] = await t.db
        .select({ conditionNote: garment.conditionNote })
        .from(garment)
        .where(eq(garment.id, garments.boots.id));
      expect(row.conditionNote).toBe('Heel worn down');
      const attention = await tool<{ garments: { name: string }[] }>(
        t,
        token,
        'search_garments',
        { needsAttention: true },
      );
      expect(attention.garments.map((g) => g.name)).toEqual(['Chelsea Boots']);
    });

    it('update_garment brings a new type’s presets, the explicit values winning', async () => {
      const shirt = await addGarment('Oxford', { category: 'tops' });
      const updated = await tool<{
        garment: { properties: Record<string, unknown> };
      }>(t, token, 'update_garment', {
        id: shirt.id,
        type: 'shirt',
        formality: 4,
      });
      expect(updated.garment.properties).toMatchObject({
        type: 'shirt',
        formality: 4,
        sleeve: 'long',
      });
    });

    // #372: the garment's own fields through the form's reader. What is
    // not given stays as stored; above all the product link, which the
    // form posts beside the price (product=1).
    it('update_garment edits the garment’s own fields, null clearing, the rest as stored', async () => {
      const { id } = await addGarment('Linen Shirt', {
        category: 'tops',
        type: 'shirt',
        warmth: '2',
        color: 'white',
        size: 'M',
        brand: 'Acme',
        notes: 'Soft',
        product: '1',
        sourceUrl: 'https://shop.example/linen',
        price: '80',
      });
      // What a save most easily wipes: the weight (the form shows ounces),
      // the materials, the condition's note, a bought item's replaced garment.
      await asFixture(t.db, (tx) =>
        tx
          .update(garment)
          .set({
            fabricWeight: 203,
            materials: ['linen'],
            condition: 'needs_repair',
            conditionNote: 'Frayed cuff',
            replacesGarmentId: garments.tee.id,
          })
          .where(eq(garment.id, id)),
      );
      const row = async () => {
        const [stored] = await t.db
          .select({
            name: garment.name,
            category: garment.category,
            colors: garment.colors,
            size: garment.size,
            brand: garment.brand,
            notes: garment.notes,
            price: garment.price,
            acquiredOn: garment.acquiredOn,
            sourceUrl: garment.sourceUrl,
            type: garment.type,
            warmth: garment.warmth,
            fabricWeight: garment.fabricWeight,
            materials: garment.materials,
            condition: garment.condition,
            conditionNote: garment.conditionNote,
            replacesGarmentId: garment.replacesGarmentId,
          })
          .from(garment)
          .where(eq(garment.id, id));
        return stored;
      };
      const kept = {
        category: 'tops',
        sourceUrl: 'https://shop.example/linen',
        type: 'shirt',
        warmth: 2,
        fabricWeight: 203,
        materials: ['linen'],
        condition: 'needs_repair',
        replacesGarmentId: garments.tee.id,
      };

      await tool(t, token, 'update_garment', { id, name: 'Linen Overshirt' });
      const renamed = {
        ...kept,
        name: 'Linen Overshirt',
        colors: ['white'],
        size: 'Medium',
        brand: 'Acme',
        notes: 'Soft',
        price: '80.00',
        acquiredOn: null,
        conditionNote: 'Frayed cuff',
      };
      expect(await row()).toEqual(renamed);
      // A repeat, and the condition sent again without its note, write
      // nothing: the note stays.
      const repeat = await recordQueries(async () => {
        await tool(t, token, 'update_garment', {
          id,
          name: 'Linen Overshirt',
          condition: 'needs_repair',
        });
      });
      expect(
        repeat.sql.filter((sql) => /^update "garment"/i.test(sql)),
      ).toEqual([]);
      expect(await row()).toEqual(renamed);
      // A note alone changes the note of a garment with a problem.
      await tool(t, token, 'update_garment', {
        id,
        conditionNote: 'Both cuffs frayed',
      });

      const updated = await tool<{ garment: Record<string, unknown> }>(
        t,
        token,
        'update_garment',
        {
          id,
          colors: ['blue', 'green'],
          size: 'xl',
          brand: 'Uniqlo',
          notes: 'Runs large',
          price: 49.9,
          acquiredOn: '2026-03-01',
        },
      );
      const edited = {
        ...kept,
        name: 'Linen Overshirt',
        colors: ['green', 'blue'],
        size: 'X-Large',
        brand: 'Uniqlo',
        notes: 'Runs large',
        price: '49.90',
        acquiredOn: '2026-03-01',
        conditionNote: 'Both cuffs frayed',
      };
      expect(await row()).toEqual(edited);
      // The answer is what was stored.
      expect(updated.garment).toMatchObject({
        name: 'Linen Overshirt',
        colors: ['green', 'blue'],
        size: 'X-Large',
        price: '49.90',
        sourceUrl: 'https://shop.example/linen',
      });

      for (const refused of [
        { colors: ['mint'] },
        { category: ' ' },
        { acquiredOn: '2026-02-30' },
        { price: -1 },
        // Never rounded to 20.00.
        { price: 19.999 },
      ]) {
        const answer = await callTool(t, token, 'update_garment', {
          id,
          name: 'Refused',
          ...refused,
        });
        expect(answer.isError, JSON.stringify(refused)).toBe(true);
      }
      expect(
        (await callTool(t, token, 'update_garment', { id, category: '' })).value
          .error,
      ).toBe(`category: ${text('validation.CATEGORY_REQUIRED')}`);
      expect(await row()).toEqual(edited);

      await tool(t, token, 'update_garment', {
        id,
        name: null,
        colors: [],
        size: null,
        brand: null,
        notes: null,
        price: null,
        acquiredOn: null,
        conditionNote: null,
      });
      expect(await row()).toEqual({
        ...kept,
        name: null,
        colors: null,
        size: null,
        brand: null,
        notes: null,
        price: null,
        acquiredOn: null,
        conditionNote: null,
      });
    });

    it('update_garment on a new category drops what its role lacks, naming it', async () => {
      const { id } = await addGarment('Camp Tee', {
        category: 'tops',
        type: 't-shirt',
        warmth: '2',
        fit: 'slim',
        sleeve: 'short',
        careLabel: '1',
        careWash: 'cold',
      });
      // A type is judged against the new category.
      expect(
        (
          await callTool(t, token, 'update_garment', {
            id,
            category: 'bottoms',
            type: 't-shirt',
          })
        ).value.error,
      ).toMatch(/not a type of bottoms/);
      const updated = await tool<{
        garment: Record<string, unknown>;
        ignored: string[];
      }>(t, token, 'update_garment', { id, category: 'Footwear' });
      // Shoes have warmth, but no fit, sleeve or care label, and no t-shirt.
      expect(updated.ignored).toEqual(['type', 'fit', 'sleeve', 'careWash']);
      const [row] = await t.db
        .select({
          category: garment.category,
          type: garment.type,
          warmth: garment.warmth,
          fit: garment.fit,
          sleeve: garment.sleeve,
          careWash: garment.careWash,
        })
        .from(garment)
        .where(eq(garment.id, id));
      expect(row).toEqual({
        category: 'footwear',
        type: null,
        warmth: 2,
        fit: null,
        sleeve: null,
        careWash: null,
      });
      expect(updated.garment).toMatchObject({
        category: 'footwear',
        role: 'footwear',
      });
    });

    // Read, then written: a delete committed between the two is the
    // refusal it would have been before the read, never an answer for a
    // garment that is gone.
    it('update_garment on a garment deleted meanwhile is Garment not found', async () => {
      const { id } = await addGarment('Deleted Midway', { category: 'tops' });
      const [deleted, answer] = await interleave(
        t.db,
        (tx) => deleteGarment(tx, id, t.owner.id),
        () => callTool(t, token, 'update_garment', { id, name: 'Too Late' }),
      );
      expect(deleted.ok).toBe(true);
      expect(answer).toEqual({
        isError: true,
        value: { error: 'Garment not found' },
      });
      expect(await t.db.$count(garment, eq(garment.id, id))).toBe(0);
    });

    // A product link is usually something being considered (#18): the
    // wishlist unless the caller says the closet.
    it('add_garment_from_link imports to the wishlist, and list_wishlist shows it', async () => {
      const added = await tool<{
        garment: { id: number; name: string; brand: string; price: string };
        notices: string[];
        confidence: string;
      }>(t, token, 'add_garment_from_link', {
        url: sites.url('/products/tee'),
        replacesGarmentId: garments.tee.id,
      });
      expect(added.confidence).toBe('product');
      expect(added.garment).toMatchObject({
        name: 'Heavyweight Pocket Tee',
        brand: 'Studio Knit',
        price: '48.00',
        status: 'wishlist',
        replacesGarmentId: garments.tee.id,
        hasPhoto: true,
        properties: expect.objectContaining({ type: 't-shirt' }),
      });
      const [row] = await t.db
        .select({ ownerId: garment.ownerId, photoId: garment.photoId })
        .from(garment)
        .where(eq(garment.id, added.garment.id));
      expect(row.ownerId).toBe(t.owner.id);
      expect(row.photoId).not.toBeNull();

      const wishlist = await tool<{
        items: { id: number; price: string; replaces: { id: number } }[];
      }>(t, token, 'list_wishlist');
      expect(wishlist.items).toContainEqual(
        expect.objectContaining({
          id: added.garment.id,
          price: '48.00',
          replaces: expect.objectContaining({ id: garments.tee.id }),
        }),
      );
      // Not in the closet: search_garments never finds it.
      const search = await tool<{ garments: { id: number }[] }>(
        t,
        token,
        'search_garments',
        { keyword: 'Pocket Tee', includeArchived: true },
      );
      expect(search.garments.map((g) => g.id)).not.toContain(added.garment.id);
      // Nor can it be worn.
      const worn = await callTool(t, token, 'mark_worn', {
        garmentId: added.garment.id,
      });
      expect(worn).toEqual({
        isError: true,
        value: { error: 'On the wishlist: not bought yet' },
      });
      // goes_with_closet judges a wishlist item: no lookalikes here (#20),
      // and it has no copies to add.
      expect(added).not.toHaveProperty('lookalikes');
      expect(
        await callTool(t, token, 'add_garment_copy', { id: added.garment.id }),
      ).toEqual({
        isError: true,
        value: { error: 'Only a garment in the closet has copies to add' },
      });
    });

    // #20: a tool call cannot ask before saving, so an import to the closet
    // names the closet garments it looks like, and add_garment_copy counts
    // a copy. (Two imports only: the file shares one 10-a-minute budget.)
    it('add_garment_from_link saves to the closet when asked, naming its lookalikes', async () => {
      type Added = {
        garment: { id: number; status: string; quantity: number };
        lookalikes?: { id: number; name: string; quantity: number }[];
      };
      const first = await tool<Added>(t, token, 'add_garment_from_link', {
        url: sites.url('/products/tee'),
        destination: 'closet',
      });
      expect(first.garment.status).toBe('closet');
      // Navy: nothing in the closet looks like it yet.
      expect(first.lookalikes).toEqual([]);
      const second = await tool<Added>(t, token, 'add_garment_from_link', {
        url: sites.url('/products/tee'),
        destination: 'closet',
      });
      expect(second.lookalikes).toEqual([
        {
          id: first.garment.id,
          name: 'Heavyweight Pocket Tee',
          category: 'tops',
          quantity: 1,
        },
      ]);

      const copied = await tool<Added>(t, token, 'add_garment_copy', {
        id: first.garment.id,
        copies: 2,
      });
      expect(copied.garment.quantity).toBe(3);
      expect(
        await callTool(t, token, 'add_garment_copy', {
          id: first.garment.id,
          copies: 28,
        }),
      ).toEqual({
        isError: true,
        value: {
          error: 'That would be more than 30 copies, the most a garment holds',
        },
      });
      // A viewer may not; a MANAGE grantee may, in the shared wardrobe.
      const viewed = await callTool(t, viewer.token, 'add_garment_copy', {
        id: first.garment.id,
        ownerId: t.owner.id,
      });
      expect(viewed.isError).toBe(true);
      const managed = await tool<Added>(t, manager.token, 'add_garment_copy', {
        id: first.garment.id,
        ownerId: t.owner.id,
      });
      expect(managed.garment.quantity).toBe(4);
      const [row] = await t.db
        .select({ quantity: garment.quantity })
        .from(garment)
        .where(eq(garment.id, first.garment.id));
      expect(row.quantity).toBe(4);
    });

    it('add_garment_from_link answers a title-only read with its reason and keeps nothing, until a name is sent', async () => {
      const before = await t.db.$count(garment);
      const answer = await callTool(t, token, 'add_garment_from_link', {
        url: sites.url('/products/mystery'),
      });
      expect(answer).toEqual({
        isError: true,
        value: {
          error: `title-only: ${text('linkImport.TITLE_ONLY_SEND_NAME')}`,
        },
      });
      expect(await t.db.$count(garment)).toBe(before);
      // With a name the form's own rules speak: the category is still needed.
      const unnamed = await callTool(t, token, 'add_garment_from_link', {
        url: sites.url('/products/mystery'),
        name: 'Scarf',
      });
      expect(unnamed.isError).toBe(true);
      expect(unnamed.value.error).toMatch(/category/i);
      expect(await t.db.$count(garment)).toBe(before);
      const named = await tool<{
        garment: { category: string };
        confidence: string;
      }>(t, token, 'add_garment_from_link', {
        url: sites.url('/products/mystery'),
        category: 'Accessories',
        name: 'Scarf',
      });
      expect(named.garment.category).toBe('accessories');
      expect(named.confidence).toBe('title-only');
    });

    it('add_garment_from_link refuses an address inside the network', async () => {
      const answer = await callTool(t, token, 'add_garment_from_link', {
        url: sites.url('/admin', 'intranet.test'),
      });
      expect(answer.isError).toBe(true);
      expect(answer.value.error).not.toMatch(/127\.0\.0\.1|intranet/);
    });

    it('add_garment_from_link names a shop that blocks it first, so the agent picks another (#347)', async () => {
      const before = await t.db.$count(garment);
      const answer = await callTool(t, token, 'add_garment_from_link', {
        url: sites.url('/products/limited'),
      });
      expect(answer).toEqual({
        isError: true,
        value: {
          error: `blocked-by-site: ${text('linkImport.BLOCKED_BY_SITE')}`,
        },
      });
      expect(await t.db.$count(garment)).toBe(before);
    });
  });

  describe('capsules', () => {
    it('set_capsule_membership adds and removes through the one writer', async () => {
      const result = await tool(t, token, 'set_capsule_membership', {
        id: capsuleId,
        add: [garments.tee.id, garments.jeans.id],
      });
      expect(result).toEqual({ added: 2, removed: 0 });
      await tool(t, token, 'set_capsule_membership', {
        id: capsuleId,
        remove: [garments.jeans.id],
      });
      const members = await t.db
        .select({ id: capsuleGarment.garmentId })
        .from(capsuleGarment)
        .where(eq(capsuleGarment.capsuleId, capsuleId));
      expect(members).toEqual([{ id: garments.tee.id }]);
    });

    it('list_capsules and get_capsule read what the pages show', async () => {
      const list = await tool<{ capsules: unknown[] }>(
        t,
        token,
        'list_capsules',
      );
      expect(list.capsules).toEqual([
        { id: capsuleId, name: 'Office', count: 1 },
      ]);
      const capsule = await tool<{ name: string; garments: { id: number }[] }>(
        t,
        token,
        'get_capsule',
        { id: capsuleId },
      );
      expect(capsule.name).toBe('Office');
      expect(capsule.garments.map((g) => g.id)).toEqual([garments.tee.id]);
      const filtered = await tool<{ garments: { id: number }[] }>(
        t,
        token,
        'search_garments',
        { capsuleId },
      );
      expect(filtered.garments.map((g) => g.id)).toEqual([garments.tee.id]);
    });

    it('a capsule of another wardrobe is not found', async () => {
      const answer = await callTool(t, viewer.token, 'get_capsule', {
        id: capsuleId,
      });
      expect(answer).toEqual({
        isError: true,
        value: { error: 'Capsule not found' },
      });
    });
  });

  describe('outfits, the calendar and wears', () => {
    const today = () => t.today();
    let outfitId: number;

    it('create_outfit saves the garments as slots, planned on a day', async () => {
      const created = await tool<{ id: number }>(t, token, 'create_outfit', {
        garmentIds: [garments.tee.id, garments.jeans.id, garments.boots.id],
        name: 'Friday',
        scheduleDate: today(),
      });
      outfitId = created.id;
      const listed = await tool<{
        outfits: { id: number; origin: string; garments: Garment[] }[];
      }>(t, token, 'list_outfits');
      expect(listed.outfits[0].id).toBe(outfitId);
      // The agent made it (#659): kept, on Saved.
      expect(listed.outfits[0].origin).toBe('agent');
      expect(listed.outfits[0].garments.map((g) => g.name)).toEqual([
        'White Tee',
        'Raw Denim',
        'Chelsea Boots',
      ]);
      const one = await tool<{ name: string; origin: string }>(
        t,
        token,
        'get_outfit',
        { id: outfitId },
      );
      expect(one).toMatchObject({ name: 'Friday', origin: 'agent' });
    });

    it('create_outfit refuses a garment that is not the caller’s', async () => {
      const answer = await callTool(t, viewer.token, 'create_outfit', {
        garmentIds: [garments.tee.id],
      });
      expect(answer.isError).toBe(true);
      expect(await t.db.$count(outfit, eq(outfit.ownerId, viewer.id))).toBe(0);
    });

    it('get_calendar shows the day; schedule_outfit adds outfits by occasion, each once a day', async () => {
      const calendar = await tool<{
        entries: { id: number; day: string; outfit: { id: number } }[];
      }>(t, token, 'get_calendar', { from: today(), to: today() });
      expect(calendar.entries).toEqual([
        expect.objectContaining({
          day: today(),
          occasion: 'all-day',
          outfit: expect.objectContaining({ id: outfitId }),
        }),
      ]);
      // The same outfit again, for another occasion: kept as it was.
      const again = await tool(t, token, 'schedule_outfit', {
        outfitId,
        date: today(),
        occasion: 'evening',
      });
      expect(again).toMatchObject({
        outcome: 'already-scheduled',
        occasion: 'all-day',
      });
      // Another outfit on the day, for the evening (#13).
      const other = await tool<{ id: number }>(t, token, 'create_outfit', {
        garmentIds: [garments.tee.id],
      });
      const evening = await tool(t, token, 'schedule_outfit', {
        outfitId: other.id,
        date: today(),
        occasion: 'evening',
      });
      expect(evening).toMatchObject({
        outcome: 'scheduled',
        occasion: 'evening',
      });
      const workout = await tool<{ id: number; scheduled: unknown }>(
        t,
        token,
        'create_outfit',
        {
          // Not the tee alone again: that is `other`, reused (#219).
          garmentIds: [garments.boots.id],
          scheduleDate: today(),
          occasion: 'workout',
        },
      );
      expect(workout.scheduled).toEqual({ day: today(), occasion: 'workout' });
      const day = await tool<{
        entries: { occasion: string; outfit: { id: number } }[];
      }>(t, token, 'get_calendar', { from: today(), to: today() });
      expect(
        day.entries.map((entry) => [entry.occasion, entry.outfit.id]),
      ).toEqual([
        ['all-day', outfitId],
        ['workout', workout.id],
        ['evening', other.id],
      ]);
      const unknown = await callTool(t, token, 'schedule_outfit', {
        outfitId: other.id,
        date: today(),
        occasion: 'brunch',
      });
      expect(unknown.isError).toBe(true);
    });

    it('get_calendar refuses a range past two months', async () => {
      const answer = await callTool(t, token, 'get_calendar', {
        from: '2026-01-01',
        to: '2026-06-01',
      });
      expect(answer.isError).toBe(true);
    });

    it('mark_worn records the entry’s wears; laundry_status and mark_washed follow', async () => {
      const [entry] = await t.db
        .select({ id: outfitCalendar.id })
        .from(outfitCalendar)
        .where(
          and(
            eq(outfitCalendar.ownerId, t.owner.id),
            eq(outfitCalendar.outfitId, outfitId),
          ),
        );
      const worn = await tool(t, token, 'mark_worn', { entryId: entry.id });
      expect(worn).toMatchObject({ worn: true, garmentsRecorded: 3 });
      const laundry = await tool<{
        garments: { id: number; needsWash: boolean }[];
      }>(t, token, 'laundry_status');
      expect(laundry.garments).toContainEqual(
        expect.objectContaining({ id: garments.tee.id, needsWash: true }),
      );
      const dirty = await tool<{ garments: { id: number }[] }>(
        t,
        token,
        'search_garments',
        { needsWash: true },
      );
      expect(dirty.garments.map((g) => g.id)).toContain(garments.tee.id);
      const washed = await tool(t, token, 'mark_washed', {
        garmentIds: [garments.tee.id],
      });
      expect(washed).toEqual({ washed: [garments.tee.id], day: today() });
      const after = await tool<{ garments: { id: number }[] }>(
        t,
        token,
        'search_garments',
        { needsWash: true },
      );
      expect(after.garments.map((g) => g.id)).not.toContain(garments.tee.id);
    });

    it('mark_worn with a garment is Wore today', async () => {
      await tool(t, token, 'mark_worn', { garmentId: garments.jeans.id });
      const rows = await t.db
        .select({ day: garmentWear.day })
        .from(garmentWear)
        .where(
          and(
            eq(garmentWear.garmentId, garments.jeans.id),
            eq(garmentWear.day, today()),
          ),
        );
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  describe('shares', () => {
    it('list_shared_wardrobes names the owner without an email', async () => {
      const listed = await tool<{
        wardrobes: {
          ownerId: number;
          name: string | null;
          permission: string;
        }[];
      }>(t, viewer.token, 'list_shared_wardrobes');
      expect(listed.wardrobes).toEqual([
        { ownerId: t.owner.id, name: null, permission: 'VIEW' },
      ]);
      expect(JSON.stringify(listed)).not.toContain('@');
    });

    it('VIEW reads the shared wardrobe but writes nothing', async () => {
      const found = await tool<{ total: number }>(
        t,
        viewer.token,
        'search_garments',
        {
          ownerId: t.owner.id,
        },
      );
      expect(found.total).toBeGreaterThan(0);
      const detail = await tool<Record<string, unknown>>(
        t,
        viewer.token,
        'get_garment',
        { id: garments.tee.id, ownerId: t.owner.id },
      );
      // The owner's wears are theirs alone.
      expect(detail.care).toBeUndefined();
      const refused = await callTool(t, viewer.token, 'update_garment', {
        id: garments.tee.id,
        ownerId: t.owner.id,
        warmth: 5,
        name: 'Viewed',
      });
      expect(refused).toEqual({ isError: true, value: { error: 'Forbidden' } });
      const [row] = await t.db
        .select({ warmth: garment.warmth, name: garment.name })
        .from(garment)
        .where(eq(garment.id, garments.tee.id));
      expect(row).toEqual({ warmth: 2, name: 'White Tee' });
    });

    it('VIEW cannot needs-wash filter a shared wardrobe (it reads the owner’s wears)', async () => {
      const answer = await callTool(t, viewer.token, 'search_garments', {
        ownerId: t.owner.id,
        needsWash: true,
      });
      expect(answer.isError).toBe(true);
    });

    it('MANAGE writes the garments but not the wears', async () => {
      // The wash limit is the owner's record (FormAudience): a grantee's
      // save through the form's reader leaves it as stored.
      await asFixture(t.db, (tx) =>
        tx
          .update(garment)
          .set({ washAfterWears: 5 })
          .where(eq(garment.id, garments.jeans.id)),
      );
      await tool(t, manager.token, 'update_garment', {
        id: garments.jeans.id,
        ownerId: t.owner.id,
        fit: 'slim',
        brand: 'Levi’s',
        size: '32',
      });
      const [row] = await t.db
        .select({
          fit: garment.fit,
          brand: garment.brand,
          size: garment.size,
          washAfterWears: garment.washAfterWears,
        })
        .from(garment)
        .where(eq(garment.id, garments.jeans.id));
      expect(row).toEqual({
        fit: 'slim',
        brand: 'Levi’s',
        size: '32',
        washAfterWears: 5,
      });
      for (const [name, args] of [
        ['mark_worn', { garmentId: garments.jeans.id, ownerId: t.owner.id }],
        [
          'mark_washed',
          { garmentIds: [garments.jeans.id], ownerId: t.owner.id },
        ],
      ] as const) {
        const answer = await callTool(t, manager.token, name, args);
        expect(answer, name).toEqual({
          isError: true,
          value: { error: 'Forbidden' },
        });
      }
    });

    // Each tool through a share, as the pages grant it: a VIEW grantee
    // reads, a MANAGE grantee also changes garments and capsule membership,
    // wears stay the owner's, a stranger finds nothing.
    it.each([
      ['viewer', 'get_capsule', undefined],
      ['viewer', 'list_capsules', undefined],
      ['viewer', 'list_wishlist', undefined],
      ['viewer', 'set_capsule_membership', 'Forbidden'],
      ['manager', 'set_capsule_membership', undefined],
      ['manager', 'mark_washed', 'Forbidden'],
      ['viewer', 'mark_worn', 'Forbidden'],
    ] as const)(
      '%s calling %s on the shared wardrobe: %s',
      async (actor, name, refusal) => {
        const caller = actor === 'viewer' ? viewer : manager;
        const args: Record<string, Record<string, unknown>> = {
          get_capsule: { id: capsuleId },
          list_capsules: {},
          list_wishlist: {},
          set_capsule_membership: { id: capsuleId, add: [garments.boots.id] },
          mark_washed: { garmentIds: [garments.tee.id] },
          mark_worn: { garmentId: garments.tee.id },
        };
        const answer = await callTool(t, caller.token, name, {
          ...args[name],
          ownerId: t.owner.id,
        });
        if (refusal) {
          expect(answer).toEqual({ isError: true, value: { error: refusal } });
        } else {
          expect(answer.isError, JSON.stringify(answer.value)).toBe(false);
        }
      },
    );

    it('a wardrobe not shared with the caller does not exist for them', async () => {
      const stranger = await signUp('stranger@example.com');
      const answer = await callTool(t, stranger.token, 'search_garments', {
        ownerId: t.owner.id,
      });
      expect(answer).toEqual({
        isError: true,
        value: { error: 'Wardrobe not found' },
      });
      const garmentAnswer = await callTool(t, stranger.token, 'get_garment', {
        id: garments.tee.id,
      });
      expect(garmentAnswer.value.error).toBe('Garment not found');
    });

    it('compare_with_shared_wardrobe finds the gaps against the shared closet', async () => {
      await addGarment(
        'Grey Tee',
        { category: 'tops', type: 't-shirt' },
        viewer.cookie,
      );
      const compared = await tool<{
        gaps: { kind: string; shared: { name: string }[] }[];
        overlap: { kind: string }[];
        complete: boolean;
      }>(t, viewer.token, 'compare_with_shared_wardrobe', {
        ownerId: t.owner.id,
      });
      expect(compared.complete).toBe(true);
      expect(compared.overlap.map((group) => group.kind)).toContain('t-shirt');
      expect(compared.gaps.map((group) => group.kind)).toEqual(
        expect.arrayContaining(['jeans', 'boots']),
      );
    });
  });

  describe('a new password', () => {
    it('revokes every token, as it ends every session', async () => {
      const user = await signUp('rotating@example.com');
      expect((await mcpRequest(t, user.token, 'tools/list')).statusCode).toBe(
        200,
      );
      const res = await t.inject({
        method: 'POST',
        url: '/auth/change-password',
        payload: {
          currentPassword: TEST_PASSWORD,
          newPassword: 'Another-pass1',
          confirmPassword: 'Another-pass1',
        },
        headers: { cookie: user.cookie, ...uniqueClient() },
      });
      expect(res.statusCode).toBe(302);
      expect((await mcpRequest(t, user.token, 'tools/list')).statusCode).toBe(
        401,
      );
    });
  });

  describe('the rate limit', () => {
    it('allows 120 calls a minute per token, then 429', async () => {
      const busy = await createAccessToken(t, { name: 'Busy' });
      issued.push(busy);
      for (let call = 0; call < 120; call += 1) {
        const res = await mcpRequest(t, busy, 'tools/list');
        expect(res.statusCode).toBe(200);
      }
      const refused = await mcpRequest(t, busy, 'tools/list');
      expect(refused.statusCode).toBe(429);
      // Another token of the same user has its own budget.
      expect((await mcpRequest(t, token, 'tools/list')).statusCode).toBe(200);
    });

    it('allows a user 10 link imports a minute, whichever token', async () => {
      const importer = await signUp('importer@example.com');
      const second = await createAccessToken(t, {
        cookie: importer.cookie,
        name: 'Second',
      });
      issued.push(second);
      // Refused by the fetcher's address rule, but each is an import.
      const blocked = { url: sites.url('/admin', 'intranet.test') };
      for (let call = 0; call < 10; call += 1) {
        const answer = await callTool(
          t,
          call % 2 ? second : importer.token,
          'add_garment_from_link',
          blocked,
        );
        expect(answer.value.error).not.toMatch(/Too many/);
      }
      const refused = await callTool(
        t,
        importer.token,
        'add_garment_from_link',
        blocked,
      );
      expect(refused).toEqual({
        isError: true,
        value: { error: 'Too many link imports: try again in a minute' },
      });
    });
  });

  describe('logging', () => {
    it('logs each call with its tool, user and outcome', () => {
      const lines = t.logs.messages('info', 'Mcp');
      expect(lines).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^MCP search_garments by user ${t.owner.id} \\(token \\d+\\): ok `,
          ),
        ),
      );
      expect(lines).toContainEqual(
        expect.stringMatching(
          /^MCP update_garment by user \d+ \(token \d+\): refused 403: Forbidden /,
        ),
      );
    });

    it('logs one line per call: a refusal at info, a chosen 5xx at warn', async () => {
      const failing = (name: string, status: number) =>
        defineTool({
          name,
          title: name,
          description: name,
          input: z.object({}),
          writes: false,
          run: () => Promise.reject(new HttpError(status)),
        });
      const handlers = new Map<string, () => Promise<unknown>>();
      const server = {
        registerTool: (name: string, _config: unknown, handler: never) =>
          handlers.set(name, handler),
      } as unknown as McpServer;
      registerTools(
        server,
        [failing('probe_503', 503), failing('probe_403', 403)],
        {
          userId: t.owner.id,
          tokenId: 1,
        } as Parameters<typeof registerTools>[2],
        { logger: t.logger.child({ logger: 'Mcp' }), metrics: t.metrics },
      );
      t.logs.clear();
      await handlers.get('probe_503')!();
      await handlers.get('probe_403')!();
      const warned = t.logs.messages('warn', 'Mcp');
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatch(/^MCP probe_503 by user \d+ .*: failed 503: /);
      const informed = t.logs.messages('info', 'Mcp');
      expect(informed).toHaveLength(1);
      expect(informed[0]).toMatch(
        /^MCP probe_403 by user \d+ .*: refused 403: /,
      );
      expect(t.logs.messages('error', 'Mcp')).toHaveLength(0);
    });

    it('never writes a token, or its prefix, to a log line', () => {
      const everything = JSON.stringify(t.logs.records);
      expect(issued.length).toBeGreaterThan(3);
      for (const issuedToken of issued) {
        expect(everything).not.toContain(issuedToken);
        expect(everything).not.toContain(issuedToken.slice(0, 11));
      }
    });
  });
});
