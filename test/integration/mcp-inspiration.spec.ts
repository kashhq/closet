import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wardrobeShare } from '../../src/db/schema';
import { t as text } from '../../src/web/i18n';
import { jpegPhoto } from './garments';
import { createTestApp, OWNER_EMAIL, type TestApp, userIdOf } from './harness';
import { addLook } from './inspiration';
import {
  html,
  INTRANET_HOST,
  jpeg,
  type LinkSites,
  startLinkSites,
} from './link-sites';
import { callTool, createAccessToken, tool } from './mcp';

interface Piece {
  position: number;
  role: string;
  type: string | null;
  colors: string[];
  chosenGarmentId: number | null;
  missing: boolean;
  matches: { garmentId: number; name: string }[];
}

interface Look {
  id: number;
  title: string | null;
  sourceUrl: string | null;
  hasPhoto: boolean;
  pieces: Piece[];
  unread?: string | null;
}

/**
 * Saved looks over MCP (#22d, tools/inspiration.ts): the owner's own, like
 * the style profile. Listing, reading a look with the match view's matches,
 * saving one from a link through the paste's writer, and tagging it. Another
 * user's look, a MANAGE grantee's included, is the 404 the pages answer.
 */
describe('MCP: saved looks', () => {
  let t: TestApp;
  let sites: LinkSites;
  let token: string;
  let granteeToken: string;
  let look: number;
  let ownerId: number;
  let tee: number;

  const wear = async (name: string, type: string, color: string) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      payload: { name, category: 'tops', props: '1', type, color: [color] },
    });
    expect(res.statusCode).toBe(302);
    return Number(
      /^\/wardrobe\/(\d+)\?/.exec(String(res.headers.location))![1],
    );
  };

  beforeAll(async () => {
    sites = await startLinkSites();
    t = await createTestApp({}, { outboundFetch: sites.outboundFetch });
    const photo = await jpegPhoto(600, 800);
    sites.serve('/look.jpg', jpeg(photo));
    sites.serve(
      '/lookbook',
      html(
        `<html><head><title>White tee, blue jeans</title><meta property="og:image" content="${sites.url('/look.jpg')}"></head><body></body></html>`,
      ),
    );
    sites.serve('/blocked', {
      status: 403,
      type: 'text/html',
      body: '<title>Just a moment...</title>',
      headers: { 'cf-mitigated': 'challenge' },
    });
    token = await createAccessToken(t);
    ownerId = await userIdOf(t, OWNER_EMAIL);
    tee = await wear('White tee', 't-shirt', 'white');
    look = (await addLook(t, photo)).id;

    const granteeCookie = await t.register('look-grantee@example.com');
    await t.db.insert(wardrobeShare).values({
      grantorId: ownerId,
      granteeId: await userIdOf(t, 'look-grantee@example.com'),
      permission: 'MANAGE',
      inviteToken: randomUUID(),
      createdAt: new Date(),
      acceptedAt: new Date(),
    });
    granteeToken = await createAccessToken(t, { cookie: granteeCookie });
  });

  afterAll(async () => {
    await t?.cleanup();
    await sites?.close();
  });

  it('tags a look, matched against the closet; the same pieces again change nothing; a type of another role is a 400', async () => {
    const pieces = [
      { role: 'top', type: 't-shirt', colors: ['white'] },
      { role: 'footwear', colors: ['white'] },
    ];
    const tagged = await tool<Look>(t, token, 'set_inspiration_pieces', {
      id: look,
      pieces,
    });
    expect(tagged.pieces).toMatchObject([
      {
        position: 0,
        role: 'top',
        type: 't-shirt',
        colors: ['white'],
        missing: false,
        matches: [{ garmentId: tee, name: 'White tee' }],
      },
      { position: 1, role: 'footwear', type: null, missing: true, matches: [] },
    ]);
    // get_inspiration answers the match view's own reading.
    expect(await tool<Look>(t, token, 'get_inspiration', { id: look })).toEqual(
      tagged,
    );

    // Again, the tee kept and the shoes swapped for a bag: the tee keeps
    // its place, the bag takes the next one, the shoes' is never reused.
    const again = await tool<Look>(t, token, 'set_inspiration_pieces', {
      id: look,
      pieces: [pieces[0], { role: 'bag', colors: ['black'] }],
    });
    expect(again.pieces.map((p) => [p.position, p.role])).toEqual([
      [0, 'top'],
      [2, 'bag'],
    ]);
    expect(t.logs.ops('inspiration.pieces.set')).toContainEqual(
      expect.objectContaining({
        inspirationId: look,
        userId: ownerId,
        surface: 'mcp',
        kept: 1,
        removed: 1,
        added: 1,
      }),
    );

    const wrongType = await callTool(t, token, 'set_inspiration_pieces', {
      id: look,
      pieces: [{ role: 'bottom', type: 't-shirt' }],
    });
    expect(wrongType.isError).toBe(true);
    expect(wrongType.value.error).toMatch(
      /^pieces\[0\]\.type: "t-shirt" is not a type of bottom \(/,
    );
    expect(
      (await tool<Look>(t, token, 'get_inspiration', { id: look })).pieces,
    ).toHaveLength(2);
  });

  it('lists the own looks with their piece counts; never another user’s, a grantee’s included', async () => {
    const { looks } = await tool<{ looks: Record<string, unknown>[] }>(
      t,
      token,
      'list_inspiration',
    );
    expect(looks).toContainEqual({
      id: look,
      title: null,
      sourceUrl: null,
      hasPhoto: true,
      pieceCount: 2,
    });
    expect(await tool(t, granteeToken, 'list_inspiration')).toEqual({
      looks: [],
    });
  });

  it.each(['get_inspiration', 'set_inspiration_pieces'])(
    '%s refuses a grantee the owner’s look as not found, logged once',
    async (name) => {
      const answer = await callTool(
        t,
        granteeToken,
        name,
        name === 'get_inspiration' ? { id: look } : { id: look, pieces: [] },
      );
      expect(answer).toEqual({
        isError: true,
        value: { error: text('refusal.notFound.inspiration') },
      });
      const lines = t.logs
        .messages('info')
        .filter(
          (line) =>
            line.startsWith(`MCP ${name} by user `) &&
            line.includes('refused 404'),
        );
      expect(lines).toHaveLength(1);
    },
  );

  it('saves a look from a link, the page’s title and photo with it; a blocked site keeps the link and says why; a private address is refused', async () => {
    const saved = await tool<Look>(t, token, 'add_inspiration', {
      url: sites.url('/lookbook'),
    });
    expect(saved).toMatchObject({
      title: 'White tee, blue jeans',
      sourceUrl: sites.url('/lookbook'),
      hasPhoto: true,
      unread: null,
    });

    const blocked = await tool<Look>(t, token, 'add_inspiration', {
      url: sites.url('/blocked'),
    });
    expect(blocked).toMatchObject({
      sourceUrl: sites.url('/blocked'),
      hasPhoto: false,
      unread: 'blocked-by-site',
    });

    const refused = await callTool(t, token, 'add_inspiration', {
      url: `http://${INTRANET_HOST}/look`,
    });
    expect(refused.isError).toBe(true);
    expect(refused.value.error).toBe(
      `blocked-address: ${text('linkImport.BLOCKED_ADDRESS')}`,
    );
  });
});
