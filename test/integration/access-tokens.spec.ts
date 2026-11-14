import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personalAccessToken, user } from '../../src/db/schema';
import {
  authenticateToken,
  hashToken,
  MAX_ACTIVE_TOKENS,
} from '../../src/web/auth/personal-tokens';
import { updatePasswordHash } from '../../src/web/auth/queries';
import {
  createTestApp,
  TEST_PASSWORD,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import { interleave } from './interleave';
import { createAccessToken, mintToken } from './mcp';
import { expectNativePostForms } from './pages';

/**
 * The bearer credentials: the profile's Agent access page (#33), personal
 * access tokens for the MCP endpoint, created (shown once), listed by name
 * and prefix, and revoked; and the device tokens of native clients (#189),
 * listed and revoked on the profile's Devices. Only a hash is stored; each
 * surface takes only its own kind; nobody reaches another user's tokens;
 * a new password leaves no token alive, however the two interleave.
 */
describe('agent access tokens', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  const page = () => t.inject({ method: 'GET', url: '/auth/tokens' });

  it('is linked from the profile', async () => {
    const res = await t.inject({ method: 'GET', url: '/auth/profile' });
    expect(res.body).toContain('href="/auth/tokens"');
  });

  it('shows a new token once, with the command that connects Claude Code', async () => {
    const res = await t.inject({
      method: 'POST',
      url: '/auth/tokens',
      payload: { name: 'Laptop', currentPassword: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expectNativePostForms(res);
    const token = /closet_[A-Za-z0-9_-]{43}/.exec(res.body)![0];
    expect(unescapeHtml(res.body)).toContain(
      `claude mcp add --transport http closet http://localhost:3000/mcp --header "Authorization: Bearer ${token}"`,
    );

    const [row] = await t.db
      .select()
      .from(personalAccessToken)
      .where(eq(personalAccessToken.name, 'Laptop'));
    expect(row.tokenHash).toBe(hashToken(token));
    expect(row.tokenHash).not.toContain(token);
    expect(row.tokenPrefix).toBe(token.slice(0, 11));

    const listed = await page();
    expect(listed.body).toContain('Laptop');
    expect(listed.body).toContain(`${token.slice(0, 11)}…`);
    expect(listed.body).not.toContain(token);
  });

  describe('asks for the current password (a token outlives signing out)', () => {
    const WRONG = 'Not-the-password-9';
    const tokensOf = async (userId: number) =>
      t.db.$count(personalAccessToken, eq(personalAccessToken.userId, userId));

    it('refuses a wrong one: 400, the form again, nothing created, nothing echoed', async () => {
      const cookie = await t.register('stepup@example.com');
      const id = await userIdOf(t, 'stepup@example.com');
      t.logs.clear();
      const res = await t.inject({
        method: 'POST',
        url: '/auth/tokens',
        payload: { name: 'Borrowed phone', currentPassword: WRONG },
        headers: { cookie },
      });
      expect(res.statusCode).toBe(400);
      expectNativePostForms(res);
      expect(res.body).toContain('Current password is incorrect');
      // The name is kept, the password never.
      expect(res.body).toContain('value="Borrowed phone"');
      expect(res.body).not.toContain(WRONG);
      expect(res.body).not.toMatch(/closet_[A-Za-z0-9_-]{43}/);
      expect(await tokensOf(id)).toBe(0);
      expect(t.logs.messages('info', 'Web')).toContain(
        `Token refused for user ${id}: wrong current password`,
      );
      expect(JSON.stringify(t.logs.records)).not.toContain(WRONG);
    });

    it('refuses a missing one as a malformed form, creating nothing', async () => {
      const cookie = await t.register('nopassword@example.com');
      const id = await userIdOf(t, 'nopassword@example.com');
      const res = await t.inject({
        method: 'POST',
        url: '/auth/tokens',
        payload: { name: 'No password' },
        headers: { cookie },
      });
      expect(res.statusCode).toBe(400);
      expect(await tokensOf(id)).toBe(0);
    });

    it('creates with the right one, and never logs the password', async () => {
      const cookie = await t.register('right@example.com');
      const id = await userIdOf(t, 'right@example.com');
      t.logs.clear();
      await createAccessToken(t, { cookie });
      expect(await tokensOf(id)).toBe(1);
      expect(JSON.stringify(t.logs.records)).not.toContain(TEST_PASSWORD);
    });

    it('counts every attempt against the account limit (5 a minute)', async () => {
      const cookie = await t.register('guesser@example.com');
      const id = await userIdOf(t, 'guesser@example.com');
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await t.inject({
          method: 'POST',
          url: '/auth/tokens',
          payload: { name: 'Guess', currentPassword: `${WRONG}${attempt}` },
          headers: { cookie },
        });
        expect(res.statusCode).toBe(400);
      }
      // Even the right password is refused once the limit is reached.
      const limited = await t.inject({
        method: 'POST',
        url: '/auth/tokens',
        payload: { name: 'Guess', currentPassword: TEST_PASSWORD },
        headers: { cookie },
      });
      expect(limited.statusCode).toBe(429);
      expect(await tokensOf(id)).toBe(0);
    });
  });

  it('asks for a name', async () => {
    const res = await t.inject({
      method: 'POST',
      url: '/auth/tokens',
      payload: { name: '   ', currentPassword: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toMatch(/closet_[A-Za-z0-9_-]{43}/);
  });

  it('revokes a token of one’s own; anyone else’s, a device’s and a second revoke land back with a notice', async () => {
    const cookie = await t.register('other@example.com');
    await createAccessToken(t, { cookie, name: 'Theirs' });
    const [theirs] = await t.db
      .select({ id: personalAccessToken.id })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.name, 'Theirs'));
    const nothingToRevoke = (res: LightMyRequestResponse) => {
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/auth/tokens?revoked=0');
    };
    // Someone else's id: the same answer as an unknown one, nothing changed.
    const refused = await t.inject({
      method: 'POST',
      url: `/auth/tokens/${theirs.id}/revoke`,
    });
    nothingToRevoke(refused);
    // This page revokes agent tokens only: a device's id is nothing here.
    const device = await mintToken(
      t,
      await userIdOf(t, 'other@example.com'),
      'Their phone',
      'device',
    );
    if (!device.created) throw new Error('no device token');
    nothingToRevoke(
      await t.inject({
        method: 'POST',
        url: `/auth/tokens/${device.id}/revoke`,
        headers: { cookie },
      }),
    );
    const untouched = await t.db
      .select({ revokedAt: personalAccessToken.revokedAt })
      .from(personalAccessToken)
      .where(sql`${personalAccessToken.id} in (${theirs.id}, ${device.id})`);
    expect(untouched.every((row) => row.revokedAt === null)).toBe(true);

    const res = await t.inject({
      method: 'POST',
      url: `/auth/tokens/${theirs.id}/revoke`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/auth/tokens?revoked=1');
    const [row] = await t.db
      .select({ revokedAt: personalAccessToken.revokedAt })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.id, theirs.id));
    expect(row.revokedAt).not.toBeNull();
    // Revoked is gone from the list, and a second revoke finds nothing.
    const listed = await t.inject({
      method: 'GET',
      url: '/auth/tokens',
      headers: { cookie },
    });
    expect(listed.body).not.toContain('Theirs');
    // A stale tab's second tap: the page again, saying so, no error page.
    const again = await t.inject({
      method: 'POST',
      url: `/auth/tokens/${theirs.id}/revoke`,
      headers: { cookie },
    });
    nothingToRevoke(again);
    const notice = await t.inject({
      method: 'GET',
      url: '/auth/tokens?revoked=0',
      headers: { cookie },
    });
    expect(notice.statusCode).toBe(200);
    expect(notice.body).toContain('That token was already revoked.');
  });

  it(`stops at ${MAX_ACTIVE_TOKENS} tokens in force`, async () => {
    // Straight through the writer: the page is rate limited like the other
    // account writes (ACCOUNT_LIMIT, 5 a minute).
    const cookie = await t.register('busy@example.com');
    const id = await userIdOf(t, 'busy@example.com');
    for (let n = 0; n < MAX_ACTIVE_TOKENS; n += 1) {
      await mintToken(t, id, `Token ${n}`);
    }
    const res = await t.inject({
      method: 'POST',
      url: '/auth/tokens',
      payload: { name: 'One more', currentPassword: TEST_PASSWORD },
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toMatch(/closet_[A-Za-z0-9_-]{43}/);
  });

  describe('a token’s scope (#701)', () => {
    /** The scope words Agent Access shows on the token named `name`. */
    const scopeShown = (body: string, name: string) =>
      new RegExp(`>${name}</span>\\s*<span[^>]*data-scope[^>]*>([^<]*)<`).exec(
        unescapeHtml(body),
      )?.[1];

    it('is read-only with every wardrobe unless asked, stored as chosen, and shown on each token; a token from before keeps full power', async () => {
      const cookie = await t.register('scoped@example.com');
      const id = await userIdOf(t, 'scoped@example.com');
      const mint = (name: string, fields: Record<string, string> = {}) =>
        t.inject({
          method: 'POST',
          url: '/auth/tokens',
          payload: { name, currentPassword: TEST_PASSWORD, ...fields },
          headers: { cookie },
        });
      const form = await t.inject({
        method: 'GET',
        url: '/auth/tokens',
        headers: { cookie },
      });
      // Both toggles start off: the default is the narrowest read.
      expect(form.body).toMatch(/<input type="checkbox" name="writes"/);
      expect(form.body).not.toMatch(/name="writes"[^>]*checked/);
      expect(form.body).toMatch(
        /<input type="checkbox" name="ownWardrobeOnly"/,
      );
      expect(form.body).not.toMatch(/name="ownWardrobeOnly"[^>]*checked/);

      expect((await mint('Default')).statusCode).toBe(200);
      expect(
        (await mint('Writer', { writes: 'on', ownWardrobeOnly: 'on' }))
          .statusCode,
      ).toBe(200);
      // A row as every token before 0067 is: no scope written, the
      // columns' defaults.
      await t.db.insert(personalAccessToken).values({
        userId: id,
        kind: 'mcp',
        name: 'Earlier',
        tokenHash: hashToken('closet_earlier-701'),
        tokenPrefix: 'closet_earl',
      });

      const rows = await t.db
        .select({
          name: personalAccessToken.name,
          readOnly: personalAccessToken.readOnly,
          ownWardrobeOnly: personalAccessToken.ownWardrobeOnly,
        })
        .from(personalAccessToken)
        .where(eq(personalAccessToken.userId, id))
        .orderBy(asc(personalAccessToken.id));
      expect(rows).toEqual([
        { name: 'Default', readOnly: true, ownWardrobeOnly: false },
        { name: 'Writer', readOnly: false, ownWardrobeOnly: true },
        { name: 'Earlier', readOnly: false, ownWardrobeOnly: false },
      ]);
      expect(
        await authenticateToken(t.db, 'closet_earlier-701', 'mcp'),
      ).toMatchObject({ scope: { readOnly: false, ownWardrobeOnly: false } });

      const listed = await t.inject({
        method: 'GET',
        url: '/auth/tokens',
        headers: { cookie },
      });
      expect(scopeShown(listed.body, 'Default')).toBe('Read only');
      expect(scopeShown(listed.body, 'Writer')).toBe(
        'Can make changes · My wardrobe only',
      );
      expect(scopeShown(listed.body, 'Earlier')).toBe('Can make changes');
    });

    it('keeps the choices on a refused create, and a scope value the form never sends is a 400', async () => {
      const cookie = await t.register('scope-refused@example.com');
      const refused = await t.inject({
        method: 'POST',
        url: '/auth/tokens',
        payload: {
          name: 'Kept',
          currentPassword: 'not-the-password',
          writes: 'on',
          ownWardrobeOnly: 'on',
        },
        headers: { cookie },
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.body).toMatch(/name="writes"[^>]*checked/);
      expect(refused.body).toMatch(/name="ownWardrobeOnly"[^>]*checked/);

      const malformed = await t.inject({
        method: 'POST',
        url: '/auth/tokens',
        payload: { name: 'Odd', currentPassword: TEST_PASSWORD, writes: 'yes' },
        headers: { cookie },
      });
      expect(malformed.statusCode).toBe(400);
      const id = await userIdOf(t, 'scope-refused@example.com');
      expect(
        await t.db
          .select({ id: personalAccessToken.id })
          .from(personalAccessToken)
          .where(eq(personalAccessToken.userId, id)),
      ).toEqual([]);
    });
  });

  describe('device tokens (#189)', () => {
    const signedUp = async (email: string) => {
      const cookie = await t.register(email);
      return { cookie, id: await userIdOf(t, email) };
    };
    const minted = async (
      userId: number,
      name: string,
      kind: 'mcp' | 'device' = 'device',
    ) => {
      const result = await mintToken(t, userId, name, kind);
      if (!result.created) throw new Error(`${name}: ${result.reason}`);
      return result;
    };
    const mintedAll = async (userId: number, count: number) => {
      const ids: number[] = [];
      for (let n = 0; n < count; n += 1) {
        ids.push((await minted(userId, `Phone ${n}`)).id);
      }
      return ids;
    };
    const activeDevices = async (userId: number) =>
      (
        await t.db
          .select({ id: personalAccessToken.id })
          .from(personalAccessToken)
          .where(
            and(
              eq(personalAccessToken.userId, userId),
              eq(personalAccessToken.kind, 'device'),
              isNull(personalAccessToken.revokedAt),
            ),
          )
          .orderBy(asc(personalAccessToken.id))
      ).map((row) => row.id);
    const revokedAtOf = async (id: number) =>
      (
        await t.db
          .select({ revokedAt: personalAccessToken.revokedAt })
          .from(personalAccessToken)
          .where(eq(personalAccessToken.id, id))
      )[0].revokedAt;
    /** Every token of `userId` last used at `at`. */
    const usedAt = (userId: number, at: Date) =>
      t.db
        .update(personalAccessToken)
        .set({ lastUsedAt: at })
        .where(eq(personalAccessToken.userId, userId));
    const BASE = new Date('2026-01-01T12:00:00Z');
    const HOUR = 3_600_000;

    it('each surface takes only its own kind, and a deleted user’s token none', async () => {
      const { id } = await signedUp('kinds@example.com');
      const agent = await minted(id, 'Claude Code', 'mcp');
      const phone = await minted(id, 'Pixel');
      expect(await authenticateToken(t.db, phone.token, 'device')).toEqual({
        user: { id, email: 'kinds@example.com' },
        tokenId: phone.id,
        scope: { readOnly: false, ownWardrobeOnly: false },
      });
      expect(await authenticateToken(t.db, agent.token, 'device')).toEqual({
        refused: 'wrong kind',
      });
      expect(await authenticateToken(t.db, phone.token, 'mcp')).toEqual({
        refused: 'wrong kind',
      });
      await t.db.delete(user).where(eq(user.id, id));
      expect(await authenticateToken(t.db, phone.token, 'device')).toEqual({
        refused: 'unknown',
      });
    });

    it(`counts the cap (${MAX_ACTIVE_TOKENS}) per kind`, async () => {
      expect(MAX_ACTIVE_TOKENS).toBe(20);
      const { id } = await signedUp('per-kind@example.com');
      for (let n = 0; n < MAX_ACTIVE_TOKENS; n += 1) {
        await minted(id, `Agent ${n}`, 'mcp');
      }
      const refused = await mintToken(t, id, 'One agent more', 'mcp');
      expect(refused).toMatchObject({ created: false, reason: 'too-many' });
      const phone = await minted(id, 'Phone');
      expect(phone.evictedId).toBeUndefined();
    });

    it('at the cap a sign-in evicts the least recently used: a never-used token by its creation, a tie by the oldest id', async () => {
      const { id } = await signedUp('lru@example.com');
      const ids = await mintedAll(id, MAX_ACTIVE_TOKENS);
      await usedAt(id, BASE);
      // Never used and created before every other's last use: the least
      // recent. ids[3] is never used too, but created now: recent.
      await t.db
        .update(personalAccessToken)
        .set({ lastUsedAt: null, createdAt: new Date(BASE.getTime() - HOUR) })
        .where(eq(personalAccessToken.id, ids[7]));
      await t.db
        .update(personalAccessToken)
        .set({ lastUsedAt: null })
        .where(eq(personalAccessToken.id, ids[3]));
      t.logs.clear();
      const first = await minted(id, 'New phone');
      expect(first.evictedId).toBe(ids[7]);
      expect(await revokedAtOf(ids[7])).not.toBeNull();
      expect(JSON.stringify(t.logs.records)).toContain(
        `User ${id} at ${MAX_ACTIVE_TOKENS} device tokens: evicted ${ids[7]}, the least recently used`,
      );
      expect(JSON.stringify(t.logs.records)).not.toContain(first.token);

      // last_used_at is written at most once a minute, so equal times are
      // ordinary: the oldest row goes.
      await usedAt(id, BASE);
      const second = await minted(id, 'Newer phone');
      expect(second.evictedId).toBe(ids[0]);
      expect(await activeDevices(id)).toHaveLength(MAX_ACTIVE_TOKENS);
    });

    it('a revoked token neither counts toward the cap nor is evicted', async () => {
      const { id } = await signedUp('revoked-at-cap@example.com');
      const ids = await mintedAll(id, MAX_ACTIVE_TOKENS);
      await usedAt(id, BASE);
      await t.db
        .update(personalAccessToken)
        .set({ revokedAt: BASE, lastUsedAt: new Date(BASE.getTime() - HOUR) })
        .where(eq(personalAccessToken.id, ids[0]));
      // 19 in force: room for one, nothing evicted.
      expect((await minted(id, 'Room for one')).evictedId).toBeUndefined();
      // 20 in force: the eviction passes over the older, revoked row.
      expect((await minted(id, 'One more')).evictedId).toBe(ids[1]);
      expect(await revokedAtOf(ids[0])).toEqual(BASE);
      expect(await activeDevices(id)).toHaveLength(MAX_ACTIVE_TOKENS);
    });

    it('two sign-ins racing at the cap leave exactly the cap, neither evicting the other', async () => {
      const { id } = await signedUp('racing@example.com');
      const ids = await mintedAll(id, MAX_ACTIVE_TOKENS);
      await usedAt(id, BASE);
      const [a, b] = await Promise.all([
        minted(id, 'Racer A'),
        minted(id, 'Racer B'),
      ]);
      const active = await activeDevices(id);
      expect(active).toHaveLength(MAX_ACTIVE_TOKENS);
      expect(active).toEqual(expect.arrayContaining([a.id, b.id]));
      expect(a.evictedId).not.toBe(b.evictedId);
      expect(ids).toEqual(expect.arrayContaining([a.evictedId, b.evictedId]));
    });

    it('Profile › Devices lists the user’s own by name and last use, never the token, and hides while there are none', async () => {
      const { cookie, id } = await signedUp('devices@example.com');
      const profile = () =>
        t.inject({ method: 'GET', url: '/auth/profile', headers: { cookie } });
      expect((await profile()).body).not.toContain('id="devices"');

      const phone = await minted(id, 'Pixel 9');
      await minted(id, 'Claude Code', 'mcp');
      const stranger = await signedUp('devices-stranger@example.com');
      await minted(stranger.id, 'Not mine');

      const res = await profile();
      expect(res.statusCode).toBe(200);
      expectNativePostForms(res);
      expect(res.body).toContain('id="devices"');
      expect(res.body).toContain('Pixel 9');
      expect(res.body).toContain('never used');
      expect(res.body).toContain(`action="/auth/devices/${phone.id}/revoke"`);
      expect(res.body).not.toContain(phone.token);
      expect(res.body).not.toContain(phone.token.slice(0, 11));
      expect(res.body).not.toContain('Not mine');
      // Agent Access is the agent tokens only.
      const agents = await t.inject({
        method: 'GET',
        url: '/auth/tokens',
        headers: { cookie },
      });
      expect(agents.body).toContain('Claude Code');
      expect(agents.body).not.toContain('Pixel 9');
    });

    it('revoking a device lands on the profile; a stale, someone else’s or an agent token’s id is a notice, never an error page', async () => {
      const { cookie, id } = await signedUp('signout@example.com');
      const phone = await minted(id, 'Old phone');
      const agent = await minted(id, 'Claude Code', 'mcp');
      const stranger = await signedUp('signout-stranger@example.com');
      const theirs = await minted(stranger.id, 'Their phone');
      const revoke = (tokenId: number) =>
        t.inject({
          method: 'POST',
          url: `/auth/devices/${tokenId}/revoke`,
          headers: { cookie },
        });
      t.logs.clear();

      const done = await revoke(phone.id);
      expect(done.statusCode).toBe(303);
      expect(done.headers.location).toBe(
        '/auth/profile?deviceRevoked=1#devices',
      );
      expect(await revokedAtOf(phone.id)).not.toBeNull();
      expect(t.logs.messages('info', 'Web')).toContain(
        `User ${id} revoked device token ${phone.id}`,
      );
      const landed = await t.inject({
        method: 'GET',
        url: '/auth/profile?deviceRevoked=1',
        headers: { cookie },
      });
      expect(landed.body).toContain('Device signed out.');
      // The last one gone, so is the section; the notice stays above.
      expect(landed.body).not.toContain('id="devices"');

      for (const stale of [phone.id, theirs.id, agent.id]) {
        const res = await revoke(stale);
        expect(res.statusCode).toBe(303);
        expect(res.headers.location).toBe(
          '/auth/profile?deviceRevoked=0#devices',
        );
      }
      expect(await revokedAtOf(theirs.id)).toBeNull();
      expect(await revokedAtOf(agent.id)).toBeNull();
      const notice = await t.inject({
        method: 'GET',
        url: '/auth/profile?deviceRevoked=0',
        headers: { cookie },
      });
      expect(notice.body).toContain('That device was already signed out.');
      expect(JSON.stringify(t.logs.records)).not.toContain(phone.token);
    });
  });

  describe('a new password and the tokens', () => {
    it('revokes both kinds but the token it keeps; another user’s id keeps nothing', async () => {
      const email = 'keeper@example.com';
      await t.register(email);
      const id = await userIdOf(t, email);
      const kept = await mintToken(t, id, 'This phone', 'device');
      const other = await mintToken(t, id, 'Other phone', 'device');
      const agent = await mintToken(t, id, 'Claude Code');
      await t.register('keeper-stranger@example.com');
      const theirs = await mintToken(
        t,
        await userIdOf(t, 'keeper-stranger@example.com'),
        'Their phone',
        'device',
      );
      if (!kept.created || !other.created || !agent.created || !theirs.created)
        throw new Error('no tokens');
      const state = async (tokenId: number) =>
        (
          await t.db
            .select({ revokedAt: personalAccessToken.revokedAt })
            .from(personalAccessToken)
            .where(eq(personalAccessToken.id, tokenId))
        )[0].revokedAt === null
          ? 'active'
          : 'revoked';

      const first = await updatePasswordHash(t.db, id, 'not-a-hash-1', {
        tokenId: kept.id,
      });
      expect(first.revokedTokens).toEqual({ mcp: 1, device: 1 });
      expect(await state(kept.id)).toBe('active');
      expect(await state(other.id)).toBe('revoked');
      expect(await state(agent.id)).toBe('revoked');

      const second = await updatePasswordHash(t.db, id, 'not-a-hash-2', {
        tokenId: theirs.id,
      });
      expect(second.revokedTokens).toEqual({ mcp: 0, device: 1 });
      expect(await state(kept.id)).toBe('revoked');
      expect(await state(theirs.id)).toBe('active');
    });

    it('revokes a token minted while the password waited on the row lock', async () => {
      const email = 'race-minted@example.com';
      await t.register(email);
      const id = await userIdOf(t, email);
      // A mint's shape (createToken): the user's row locked, the token
      // inserted, the transaction held open while the password waits.
      const [tokenId, change] = await interleave(
        t.db,
        async (tx) => {
          await tx
            .select({ id: user.id })
            .from(user)
            .where(eq(user.id, id))
            .for('update');
          const [row] = await tx
            .insert(personalAccessToken)
            .values({
              userId: id,
              kind: 'device',
              name: 'Racing phone',
              tokenHash: hashToken('closet_racing'),
              tokenPrefix: 'closet_raci',
            })
            .returning({ id: personalAccessToken.id });
          return row.id;
        },
        () => updatePasswordHash(t.db, id, 'not-a-hash-race'),
      );
      expect(change.revokedTokens).toEqual({ mcp: 0, device: 1 });
      const [row] = await t.db
        .select({ revokedAt: personalAccessToken.revokedAt })
        .from(personalAccessToken)
        .where(eq(personalAccessToken.id, tokenId));
      expect(row.revokedAt).not.toBeNull();
    });

    it('refuses a mint whose checked password changed under it: the form asks again, nothing minted', async () => {
      const email = 'moved-under@example.com';
      const cookie = await t.register(email);
      const id = await userIdOf(t, email);
      t.logs.clear();
      // The new password commits while the route, having checked the old
      // one, waits for the lock in createToken.
      const [, res] = await interleave(
        t.db,
        (tx) =>
          tx
            .update(user)
            .set({ password: 'not-a-hash-moved' })
            .where(eq(user.id, id)),
        () =>
          t.inject({
            method: 'POST',
            url: '/auth/tokens',
            payload: { name: 'Too late', currentPassword: TEST_PASSWORD },
            headers: { cookie },
          }),
      );
      expect(res.statusCode).toBe(400);
      expectNativePostForms(res);
      expect(unescapeHtml(res.body)).toContain(
        'Your password was changed while this token was being made, so it was not. Enter your current password again.',
      );
      expect(res.body).toContain('value="Too late"');
      expect(res.body).not.toMatch(/closet_[A-Za-z0-9_-]{43}/);
      expect(
        await t.db.$count(
          personalAccessToken,
          eq(personalAccessToken.userId, id),
        ),
      ).toBe(0);
      expect(t.logs.messages('warn', 'Web')).toContain(
        `Token refused for user ${id}: password-changed`,
      );
    });
  });
});
