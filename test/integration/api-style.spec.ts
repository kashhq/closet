import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  outfitRule,
  styleProfile,
  user,
  wardrobeShare,
} from '../../src/db/schema';
import { deviceToken, expectProblem } from './api';
import { addOutfitRule } from '../../src/web/style/queries';
import { NO_MATCHER } from '../../src/web/style/validation';
import { interleave } from './interleave';
import { createGarment } from './garments';
import {
  asFixture,
  createTestApp,
  type TestApp,
  TEST_PASSWORD,
  userIdOf,
} from './harness';
import { mintToken } from './mcp';

/**
 * The style profile, its outfit rules and the wardrobes shared with you on
 * /api/v1 (#195c): each its page twin's writer (style/queries.ts) or
 * list_shared_wardrobes' read, owner-only. The four style routes' refusals
 * per actor are the matrix's (authorization-account.spec.ts replays them on
 * these twins); what each costs is api-statements'.
 */

let t: TestApp;
let ownerToken: string;

interface Account {
  id: number;
  cookie: string;
  token: string;
}

const accounts: Record<
  'viewer' | 'manager' | 'stranger' | 'nameless',
  Account
> = {} as never;

const api = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  as = ownerToken,
) => t.api(as, { method, url: `/api/v1${url}`, payload });

async function signUp(email: string): Promise<Account> {
  const cookie = await t.register(email);
  return {
    id: await userIdOf(t, email),
    cookie,
    token: (await deviceToken(t, { email })).token,
  };
}

/** `grantorCookie`'s invite, accepted by `grantee`: the share's row id. */
async function share(
  grantorCookie: string | undefined,
  grantee: Account,
  permission: 'VIEW' | 'MANAGE',
): Promise<number> {
  const invite = await t.inject({
    method: 'POST',
    url: '/wardrobe-share/create-invite-link',
    payload: { permission, currentPassword: TEST_PASSWORD },
    headers: {
      'hx-request': 'true',
      ...(grantorCookie && { cookie: grantorCookie }),
    },
  });
  const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
    invite.body,
  )![1];
  const accepted = await t.inject({
    method: 'POST',
    url: `/wardrobe-share/invite/${token}/accept`,
    headers: { cookie: grantee.cookie },
  });
  expect(accepted.statusCode).toBe(302);
  const [row] = await t.db
    .select({ id: wardrobeShare.id })
    .from(wardrobeShare)
    .where(eq(wardrobeShare.granteeId, grantee.id))
    .orderBy(desc(wardrobeShare.id))
    .limit(1);
  return row.id;
}

const OWNER_NOTES = 'Owner-only notes: linen in August';

const rulesOf = (ownerId: number) =>
  t.db
    .select({ id: outfitRule.id, kind: outfitRule.kind })
    .from(outfitRule)
    .where(eq(outfitRule.ownerId, ownerId));

const profileOf = async (userId: number) =>
  (
    await t.db
      .select({
        styles: styleProfile.styles,
        palette: styleProfile.palette,
        budget: styleProfile.budget,
        notes: styleProfile.notes,
      })
      .from(styleProfile)
      .where(eq(styleProfile.userId, userId))
  )[0];

beforeAll(async () => {
  t = await createTestApp();
  ownerToken = (await deviceToken(t)).token;
  await t.db
    .update(user)
    .set({ firstName: 'Olive' })
    .where(eq(user.id, t.owner.id));
  accounts.viewer = await signUp('api-style-viewer@example.com');
  accounts.manager = await signUp('api-style-manager@example.com');
  accounts.stranger = await signUp('api-style-stranger@example.com');
  accounts.nameless = await signUp('api-style-nameless@example.com');
  await share(undefined, accounts.viewer, 'VIEW');
  await share(undefined, accounts.manager, 'MANAGE');
  const saved = await api('PUT', '/style-profile', {
    styles: ['minimal', 'classic'],
    palette: ['white', 'black'],
    budget: 'mid',
    notes: OWNER_NOTES,
  });
  expect(saved.statusCode, saved.body).toBe(200);
});

afterAll(async () => {
  await t?.cleanup();
});

describe('GET and PUT /style-profile', () => {
  it('saves whole, in set order, and reads back with the rules in their words', async () => {
    const saved = await api('PUT', '/style-profile', {
      styles: ['minimal', 'classic'],
      palette: ['white', 'black'],
      budget: 'mid',
      notes: `  ${OWNER_NOTES}  `,
    });
    // The page's reader: each set in its own order, notes trimmed.
    expect(saved.json()).toEqual({
      styles: ['minimal', 'classic'],
      palette: ['black', 'white'],
      budget: 'mid',
      notes: OWNER_NOTES,
    });
    const garmentId = await createGarment(t, {
      name: 'Rule loafers',
      category: 'footwear',
    });
    const added = await api('POST', '/outfit-rules', {
      kind: 'always',
      a: { category: 'bottoms', type: 'chinos' },
      b: { garmentId },
    });
    expect(added.statusCode, added.body).toBe(201);
    const { id } = added.json<{ id: number }>();
    expect(added.json()).toEqual({ added: true, id });
    expect(added.headers.location).toBe(`/api/v1/outfit-rules/${id}`);

    const read = await api('GET', '/style-profile');
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      styles: ['minimal', 'classic'],
      palette: ['black', 'white'],
      budget: 'mid',
      notes: OWNER_NOTES,
    });
    expect(
      read.json<{ rules: { id: number }[] }>().rules.find((r) => r.id === id),
    ).toEqual({
      id,
      kind: 'always',
      a: { category: 'bottoms', type: 'chinos', label: 'Chinos' },
      b: { garmentId, label: 'Rule loafers' },
      sentence: 'Always Rule loafers with Chinos',
    });
    expect((await api('DELETE', `/outfit-rules/${id}`)).statusCode).toBe(204);
  });

  it('a profile never saved is empty sets, no budget or notes', async () => {
    const res = await api(
      'GET',
      '/style-profile',
      undefined,
      accounts.nameless.token,
    );
    expect(res.json()).toEqual({ styles: [], palette: [], rules: [] });
  });

  it('a null or absent budget and notes clear them (replaced whole)', async () => {
    const as = accounts.stranger.token;
    await api(
      'PUT',
      '/style-profile',
      { styles: ['classic'], palette: [], budget: 'luxury', notes: 'x' },
      as,
    );
    const cleared = await api(
      'PUT',
      '/style-profile',
      { styles: [], palette: ['red'], budget: null, notes: null },
      as,
    );
    expect(cleared.json()).toEqual({ styles: [], palette: ['red'] });
    expect(await profileOf(accounts.stranger.id)).toEqual({
      styles: null,
      palette: ['red'],
      budget: null,
      notes: null,
    });
  });

  it.each([
    [
      'a repeated style',
      { styles: ['classic', 'classic'], palette: [] },
      'body/styles',
    ],
    ['an unknown style', { styles: ['grunge'], palette: [] }, 'body/styles/0'],
    ['an unknown colour', { styles: [], palette: ['navy'] }, 'body/palette/0'],
    ['an empty body', {}, 'body'],
    ['a key it lacks', { styles: [], palette: [], rhythm: 3 }, 'body/rhythm'],
    ['notes as a number', { styles: [], palette: [], notes: 3 }, 'body/notes'],
  ])('%s is a 400 naming it, and nothing is saved', async (_, body, path) => {
    const before = await profileOf(t.owner.id);
    const res = await api('PUT', '/style-profile', body);
    const problem = expectProblem(res, 400, 'validation');
    expect(problem.errors?.map((e) => e.path)).toContain(path);
    expect(await profileOf(t.owner.id)).toEqual(before);
  });
});

describe('POST /outfit-rules', () => {
  it("a never-rule's mirror is the rule already held: 200 added false, one row", async () => {
    const as = accounts.manager.token;
    const first = await api(
      'POST',
      '/outfit-rules',
      { kind: 'never', a: { pattern: 'stripes' }, b: { pattern: 'check' } },
      as,
    );
    expect(first.statusCode, first.body).toBe(201);
    const mirror = await api(
      'POST',
      '/outfit-rules',
      { kind: 'never', a: { pattern: 'check' }, b: { pattern: 'stripes' } },
      as,
    );
    expect(mirror.statusCode, mirror.body).toBe(200);
    expect(mirror.json()).toEqual({ added: false });
    expect(mirror.headers.location).toBeUndefined();
    expect(await rulesOf(accounts.manager.id)).toHaveLength(1);
  });

  it('an always-rule the other way round is another rule: 201', async () => {
    const as = accounts.manager.token;
    const rule = (a: string, b: string) =>
      api(
        'POST',
        '/outfit-rules',
        { kind: 'always', a: { color: a }, b: { color: b } },
        as,
      );
    expect((await rule('red', 'blue')).statusCode).toBe(201);
    expect((await rule('blue', 'red')).statusCode).toBe(201);
    expect((await rule('red', 'blue')).statusCode).toBe(200);
  });

  it('two identical adds at once leave one row: the second waits on the owner lock, then adds nothing', async () => {
    const ownerId = accounts.viewer.id;
    // The first add holds its transaction (and the owner lock) open until
    // the second, the API's, is queued behind it.
    const [first, second] = await interleave(
      t.db,
      (tx) =>
        addOutfitRule(
          tx,
          { userId: ownerId },
          {
            kind: 'never',
            a: { ...NO_MATCHER, color: 'blue' },
            b: { ...NO_MATCHER, color: 'green' },
          },
        ),
      () =>
        api(
          'POST',
          '/outfit-rules',
          { kind: 'never', a: { color: 'blue' }, b: { color: 'green' } },
          accounts.viewer.token,
        ),
    );
    expect(first).toEqual(expect.any(Number));
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toEqual({ added: false });
    expect(await rulesOf(ownerId)).toHaveLength(1);
  });

  it.each([
    [
      'equal sides',
      { kind: 'never', a: { color: 'red' }, b: { color: 'red' } },
      'body/b',
    ],
    ['an empty side', { kind: 'never', a: { color: 'red' }, b: {} }, 'body/b'],
    [
      'a side of two matchers',
      {
        kind: 'never',
        a: { color: 'red' },
        b: { color: 'blue', pattern: 'check' },
      },
      'body/b/pattern',
    ],
    [
      'a type outside its category',
      {
        kind: 'never',
        a: { color: 'red' },
        b: { category: 'tops', type: 'jeans' },
      },
      'body/b/type',
    ],
    [
      'a garment id as a string',
      { kind: 'never', a: { color: 'red' }, b: { garmentId: '3' } },
      'body/b/garmentId',
    ],
    [
      'an unknown kind',
      { kind: 'sometimes', a: { color: 'red' }, b: { color: 'blue' } },
      'body/kind',
    ],
  ])('%s is a 400 naming it, and writes no row', async (_, body, path) => {
    const before = await rulesOf(t.owner.id);
    const problem = expectProblem(
      await api('POST', '/outfit-rules', body),
      400,
      'validation',
    );
    expect(problem.errors?.map((e) => e.path)).toContain(path);
    expect(await rulesOf(t.owner.id)).toEqual(before);
  });

  it("a side naming a garment seen only through a share, or a stranger's, is a 404 and writes no row", async () => {
    const garmentId = await createGarment(t, { name: 'Shared coat' });
    for (const who of ['viewer', 'manager', 'stranger'] as const) {
      const before = await rulesOf(accounts[who].id);
      const res = await api(
        'POST',
        '/outfit-rules',
        { kind: 'never', a: { garmentId }, b: { color: 'red' } },
        accounts[who].token,
      );
      expectProblem(res, 404, 'not_found');
      expect(res.body).not.toContain('Shared coat');
      expect(await rulesOf(accounts[who].id)).toEqual(before);
    }
  });
});

describe('DELETE /outfit-rules/{id}', () => {
  it("another's rule is the 404 of an unknown id, a grantee's too, and it survives", async () => {
    const added = await api('POST', '/outfit-rules', {
      kind: 'never',
      a: { pattern: 'floral' },
      b: { pattern: 'check' },
    });
    const { id } = added.json<{ id: number }>();
    // Everything but the request's own id.
    const strip = (body: string) => {
      const { title, status, detail, code } = JSON.parse(body) as Record<
        string,
        unknown
      >;
      return { title, status, detail, code };
    };
    const unknown = await api(
      'DELETE',
      '/outfit-rules/999999',
      undefined,
      accounts.stranger.token,
    );
    expectProblem(unknown, 404, 'not_found');
    for (const who of ['stranger', 'viewer', 'manager'] as const) {
      const res = await api(
        'DELETE',
        `/outfit-rules/${id}`,
        undefined,
        accounts[who].token,
      );
      expectProblem(res, 404, 'not_found');
      expect(strip(res.body)).toEqual(strip(unknown.body));
    }
    expect((await rulesOf(t.owner.id)).map((r) => r.id)).toContain(id);
    expect((await api('DELETE', `/outfit-rules/${id}`)).statusCode).toBe(204);
    expectProblem(await api('DELETE', `/outfit-rules/${id}`), 404, 'not_found');
  });
});

describe("a grantee's ?ownerId= on the owner-only routes", () => {
  it.each(['viewer', 'manager'] as const)(
    "%s: a 400 at querystring/ownerId on every style route, the owner's rows unchanged",
    async (who) => {
      const as = accounts[who].token;
      const q = `?ownerId=${t.owner.id}`;
      const [{ id: ruleId }] = await asFixture(t.db, (tx) =>
        tx
          .insert(outfitRule)
          .values({
            ownerId: t.owner.id,
            kind: who === 'viewer' ? 'never' : 'always',
            aColor: 'gold',
            bColor: 'silver',
          })
          .returning({ id: outfitRule.id }),
      );
      const profile = await profileOf(t.owner.id);
      const rules = await rulesOf(t.owner.id);
      for (const [method, url, body] of [
        ['GET', `/style-profile${q}`, undefined],
        ['PUT', `/style-profile${q}`, { styles: ['minimal'], palette: [] }],
        [
          'POST',
          `/outfit-rules${q}`,
          { kind: 'never', a: { color: 'red' }, b: { color: 'pink' } },
        ],
        ['DELETE', `/outfit-rules/${ruleId}${q}`, undefined],
      ] as const) {
        const res = await api(method, url, body, as);
        const problem = expectProblem(res, 400, 'validation');
        expect(problem.errors?.map((e) => e.path)).toEqual([
          'querystring/ownerId',
        ]);
        expect(res.body).not.toContain(OWNER_NOTES);
      }
      expect(await profileOf(t.owner.id)).toEqual(profile);
      expect(await rulesOf(t.owner.id)).toEqual(rules);
      // Without it, the grantee's own profile.
      const own = await api(
        'PUT',
        '/style-profile',
        { styles: ['minimal'], palette: [] },
        as,
      );
      expect(own.statusCode).toBe(200);
      expect(await profileOf(accounts[who].id)).toMatchObject({
        styles: ['minimal'],
      });
      expect(await profileOf(t.owner.id)).toEqual(profile);
    },
  );
});

describe('GET /shared-wardrobes', () => {
  it('lists accepted shares only, by first name, never an email', async () => {
    const grantee = await signUp('api-style-grantee@example.com');
    await share(undefined, grantee, 'MANAGE');
    // A grantor without a first name, whose switcher name is their email.
    await share(accounts.nameless.cookie, grantee, 'VIEW');
    // A share not accepted yet.
    await t.db.insert(wardrobeShare).values({
      grantorId: accounts.stranger.id,
      granteeId: grantee.id,
      permission: 'VIEW',
      createdAt: new Date(),
    });
    const res = await api('GET', '/shared-wardrobes', undefined, grantee.token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: [
        { ownerId: t.owner.id, ownerFirstName: 'Olive', permission: 'MANAGE' },
        { ownerId: accounts.nameless.id, permission: 'VIEW' },
      ],
    });
    expect(res.body).not.toContain('@');
  });

  it("a share revoked under a live token: the grantee's next ?ownerId= is a 404 and the list drops it", async () => {
    const grantee = await signUp('api-style-revoked@example.com');
    const shareId = await share(undefined, grantee, 'VIEW');
    const garments = () =>
      api('GET', `/garments?ownerId=${t.owner.id}`, undefined, grantee.token);
    expect((await garments()).statusCode).toBe(200);
    const removed = await t.inject({
      method: 'POST',
      url: `/wardrobe-share/${shareId}/remove`,
    });
    expect(removed.statusCode).toBeLessThan(400);
    expectProblem(await garments(), 404, 'not_found');
    const list = await api(
      'GET',
      '/shared-wardrobes',
      undefined,
      grantee.token,
    );
    expect(list.json()).toEqual({ data: [] });
  });
});

describe('credentials and the closed querystring', () => {
  const ROUTES = [
    ['GET', '/style-profile', undefined],
    ['PUT', '/style-profile', { styles: [], palette: [] }],
    [
      'POST',
      '/outfit-rules',
      { kind: 'never', a: { color: 'red' }, b: { color: 'pink' } },
    ],
    ['DELETE', '/outfit-rules/1', undefined],
    ['GET', '/shared-wardrobes', undefined],
  ] as const;

  it('a revoked, agent, unknown or password-revoked token is the 401 on every route, a live session cookie beside it or not', async () => {
    const email = 'api-style-tokens@example.com';
    const cookie = await t.register(email);
    const id = await userIdOf(t, email);
    const revoked = (await deviceToken(t, { email })).token;
    expect(
      (await t.api(revoked, { method: 'DELETE', url: '/api/v1/auth/token' }))
        .statusCode,
    ).toBe(204);
    const agent = await mintToken(t, id, 'Agent', 'mcp');
    if (!agent.created) throw new Error('no agent token');
    const passwordRevoked = (await deviceToken(t, { email })).token;
    const changed = await t.inject({
      method: 'POST',
      url: '/auth/change-password',
      payload: {
        currentPassword: TEST_PASSWORD,
        newPassword: 'Changed456!',
        confirmPassword: 'Changed456!',
      },
      headers: { cookie },
    });
    expect(changed.statusCode).toBeLessThan(400);
    const session = await t.login(email, 'Changed456!');
    const before = await rulesOf(id);
    for (const token of [
      revoked,
      agent.token,
      'closet_unknown',
      passwordRevoked,
    ]) {
      for (const [method, url, payload] of ROUTES) {
        const res = await t.api(token, {
          method,
          url: `/api/v1${url}`,
          payload,
          headers: { cookie: session },
        });
        expectProblem(res, 401, 'unauthorized');
      }
    }
    expect(await profileOf(id)).toBeUndefined();
    expect(await rulesOf(id)).toEqual(before);
  });

  it.each(ROUTES.filter(([method]) => method === 'GET' || method === 'DELETE'))(
    '%s %s?x=1 is a 400 naming the parameter',
    async (method, url) => {
      const problem = expectProblem(
        await api(method, `${url}?x=1`, undefined, accounts.stranger.token),
        400,
        'validation',
      );
      expect(problem.errors?.map((e) => e.path)).toEqual(['querystring/x']);
    },
  );
});
