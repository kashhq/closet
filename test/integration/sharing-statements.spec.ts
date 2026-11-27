import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  capsule,
  capsuleGarment,
  garment,
  wardrobeShare,
} from '../../src/db/schema';
import { selectScalars } from '../../src/db/select-scalars';
import {
  capsuleListSql,
  readCapsuleList,
} from '../../src/web/capsules/queries';
import { createInvite } from '../../src/web/sharing/queries';
import { createGarment } from './garments';
import {
  createTestApp,
  recordQueries,
  type TestApp,
  unescapeHtml,
  userIdOf,
  asFixture,
} from './harness';

/**
 * What a grantee's requests, the invites and Profile › Sharing cost in
 * statements (#170). Production reaches Postgres at about 114 ms a
 * statement (#156), so each count here is a round trip:
 * - the access check rides in the session's statement: a request whose
 *   `?ownerId=` names another user's wardrobe reads that share with the
 *   session row (shareToReadAhead), never in a statement of its own;
 * - accept, decline and remove are one write each after a read at most;
 * - Profile's three share lists are one statement.
 * The grants themselves are the authorization matrix's
 * (authorization-*.spec.ts) and share-lifecycle.spec.ts's.
 */
describe('sharing: statements per request', () => {
  let t: TestApp;
  let owner: Account;
  let viewer: Account;
  let manager: Account;
  let garmentId: number;

  interface Account {
    id: number;
    cookie: string;
  }

  const signUp = async (label: string): Promise<Account> => {
    const email = `${label}-${randomUUID().slice(0, 8)}@example.com`;
    const cookie = await t.register(email);
    return { id: await userIdOf(t, email), cookie };
  };

  const get = (url: string, as?: Account) =>
    t.inject({
      method: 'GET',
      url,
      headers: as ? { cookie: as.cookie } : {},
      anonymous: !as,
    });

  const post = (url: string, as: Account, payload: object = {}) =>
    t.inject({ method: 'POST', url, payload, headers: { cookie: as.cookie } });

  /** Through the writer: the route is ACCOUNT_LIMITed (#668). */
  const newInvite = async (permission: 'VIEW' | 'MANAGE' = 'VIEW') =>
    (await createInvite(t.db, owner.id, permission)).inviteToken;

  const shareWith = async (grantee: Account, permission: 'VIEW' | 'MANAGE') => {
    const token = await newInvite(permission);
    const res = await post(`/wardrobe-share/invite/${token}/accept`, grantee);
    expect(res.statusCode).toBe(302);
  };

  /** Statements that read or write shares of their own (not the session's). */
  const shareStatements = (sql: string[]) =>
    sql.slice(1).filter((text) => text.includes('"wardrobe_share"'));

  beforeAll(async () => {
    t = await createTestApp();
    owner = { id: t.owner.id, cookie: t.owner.cookie };
    viewer = await signUp('viewer');
    manager = await signUp('manager');
    await shareWith(viewer, 'VIEW');
    await shareWith(manager, 'MANAGE');
    garmentId = await createGarment(t, { name: 'Shared tee' });
    const capsule = await post('/capsules', owner, { name: 'Weekend' });
    expect(capsule.statusCode).toBe(303);
  });

  afterAll(() => t?.cleanup());

  describe('a grantee’s requests', () => {
    const ownerQuery = () => `ownerId=${owner.id}`;

    it('reads the share in the session’s statement, and no other', async () => {
      const record = await recordQueries(() =>
        get(`/wardrobe?${ownerQuery()}`, viewer),
      );
      expect(record.sql[0]).toMatch(/from "user"/);
      expect(record.sql[0]).toContain('"wardrobe_share"');
      expect(shareStatements(record.sql)).toEqual([
        // The app bar's switcher, inside the grid's context statement.
        expect.stringContaining('json_agg'),
      ]);
    });

    it.each([
      ['the shared wardrobe', () => `/wardrobe?${ownerQuery()}`, 3],
      ['a shared garment', () => `/wardrobe/${garmentId}?${ownerQuery()}`, 3],
      ['the shared capsules', () => `/capsules?${ownerQuery()}`, 2],
      ['the shared wishlist', () => `/wardrobe/wishlist?${ownerQuery()}`, 2],
      ['Styling a shared wardrobe', () => `/styling?${ownerQuery()}`, 2],
    ])('%s: %i statements', async (_page, url, statements) => {
      const record = await recordQueries(async () => {
        const res = await get(url(), viewer);
        expect(res.statusCode).toBe(200);
      });
      expect(record.statements).toBe(statements);
    });

    it('a MANAGE grantee’s edit: the session with the share, the write (#161)', async () => {
      const record = await recordQueries(async () => {
        const res = await post(
          `/wardrobe/${garmentId}?${ownerQuery()}`,
          manager,
          {
            name: 'Shared tee, edited',
            category: 'shirt',
          },
        );
        expect(res.statusCode).toBe(302);
      });
      expect(record.statements).toBe(2);
      expect(shareStatements(record.sql)).toEqual([]);
    });

    // #680: the hamper of a wardrobe shared to MANAGE reads the share
    // ahead like any shared page (the switcher's list is its own read, as
    // on one's own laundry), and a plain Washed is the session and the write.
    it('a MANAGE partner’s laundry and Washed cost what the owner’s do', async () => {
      const laundry = await recordQueries(async () => {
        const res = await get(`/laundry?${ownerQuery()}`, manager);
        expect(res.statusCode).toBe(200);
      });
      expect(laundry.statements).toBe(3);
      const washed = await recordQueries(async () => {
        const res = await post(
          `/wardrobe/${garmentId}/washed?${ownerQuery()}`,
          manager,
          {},
        );
        expect(res.statusCode).toBe(303);
      });
      expect(washed.statements).toBe(2);
      expect(shareStatements(washed.sql)).toEqual([]);
    });

    it('a stranger’s request is the 404 on the session’s statement alone', async () => {
      const stranger = await signUp('stranger');
      const record = await recordQueries(async () => {
        const res = await get(`/wardrobe?${ownerQuery()}`, stranger);
        expect(res.statusCode).toBe(404);
      });
      expect(record.statements).toBe(1);
    });

    it('reads no share for one’s own wardrobe, named or not', async () => {
      for (const url of ['/wardrobe', `/wardrobe?ownerId=${viewer.id}`]) {
        const record = await recordQueries(() => get(url, viewer));
        expect(record.sql[0]).not.toContain('"wardrobe_share"');
      }
    });

    it('reads the share itself when the query is no plain id', async () => {
      // `?ownerId=0<id>` is the same wardrobe to the schema, not to the
      // read-ahead: the resolver falls back to its own lookup.
      const record = await recordQueries(async () => {
        const res = await get(`/wardrobe?ownerId=0${owner.id}`, viewer);
        expect(res.statusCode).toBe(200);
      });
      expect(record.sql[0]).not.toContain('"wardrobe_share"');
      expect(record.sql[1]).toMatch(
        /^select "permission" from "wardrobe_share"/,
      );
    });

    it('never reads ahead for a repeated ?ownerId=, whatever each names', async () => {
      // The viewer holds a share of each wardrobe named, so a read-ahead of
      // either would open it; the query parser answers an array, which is
      // no plain id, and the schema refuses it before any wardrobe is read.
      const second = await signUp('second-grantor');
      const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
        (
          await t.inject({
            method: 'POST',
            url: '/wardrobe-share/create-invite-link',
            payload: { permission: 'VIEW' },
            headers: { cookie: second.cookie, 'hx-request': 'true' },
          })
        ).body,
      )![1];
      await post(`/wardrobe-share/invite/${token}/accept`, viewer);
      for (const query of [
        `ownerId=${owner.id}&ownerId=${second.id}`,
        `ownerId=${second.id}&ownerId=${owner.id}`,
        `ownerId=${owner.id}&ownerId=${owner.id}`,
      ]) {
        const record = await recordQueries(async () => {
          const res = await get(`/wardrobe?${query}`, viewer);
          expect(res.statusCode).toBe(400);
        });
        expect(record.sql[0]).not.toContain('"wardrobe_share"');
        expect(record.statements).toBe(1);
      }
    });

    it('a revoked share stops access on the next request', async () => {
      const leaver = await signUp('leaver');
      await shareWith(leaver, 'VIEW');
      expect((await get(`/wardrobe?${ownerQuery()}`, leaver)).statusCode).toBe(
        200,
      );
      await t.db
        .delete(wardrobeShare)
        .where(eq(wardrobeShare.granteeId, leaver.id));
      expect((await get(`/wardrobe?${ownerQuery()}`, leaver)).statusCode).toBe(
        404,
      );
    });
  });

  describe('invites', () => {
    it('create: the session (with the hash) and the locked insert', async () => {
      const creator = await signUp('creator');
      const record = await recordQueries(async () => {
        const res = await t.inject({
          method: 'POST',
          url: '/wardrobe-share/create-invite-link',
          payload: { permission: 'VIEW' },
          headers: { cookie: creator.cookie, 'hx-request': 'true' },
        });
        expect(res.statusCode).toBe(200);
      });
      expect(record.statements).toBe(2);
    });

    it('the landing: the session and the invite, which reads no email', async () => {
      const token = await newInvite();
      const guest = await signUp('guest');
      const record = await recordQueries(async () => {
        const res = await get(`/wardrobe-share/invite/${token}`, guest);
        expect(res.statusCode).toBe(200);
      });
      expect(record.statements).toBe(2);
      expect(record.sql[1]).not.toContain('"email"');
      expect(record.sql[1]).not.toContain('"grantee"');
    });

    it('the landing signed out: the invite alone', async () => {
      const token = await newInvite('MANAGE');
      const record = await recordQueries(async () => {
        const res = await get(`/wardrobe-share/invite/${token}`);
        expect(res.statusCode).toBe(200);
        expect(unescapeHtml(res.body)).toContain('/auth/login');
      });
      expect(record.statements).toBe(1);
    });

    it('accept: the session, the invite with any share it folds into, the write', async () => {
      const token = await newInvite();
      const guest = await signUp('accepts');
      const record = await recordQueries(async () => {
        const res = await post(`/wardrobe-share/invite/${token}/accept`, guest);
        expect(res.headers.location).toBe(`/wardrobe?ownerId=${owner.id}`);
      });
      expect(record.statements).toBe(3);
      expect(record.sql).not.toContain('begin');
    });

    it('accept folding a MANAGE invite into a VIEW share: still one write', async () => {
      const guest = await signUp('upgrades');
      await shareWith(guest, 'VIEW');
      const token = await newInvite('MANAGE');
      const record = await recordQueries(async () => {
        const res = await post(`/wardrobe-share/invite/${token}/accept`, guest);
        expect(res.headers.location).toBe(`/wardrobe?ownerId=${owner.id}`);
      });
      expect(record.statements).toBe(3);
    });

    it('decline: the session and the delete, whoever asks', async () => {
      const token = await newInvite();
      const guest = await signUp('declines');
      const refused = await recordQueries(() =>
        post(`/wardrobe-share/invite/${token}/decline`, guest),
      );
      expect(refused.statements).toBe(2);
      const withdrawn = await recordQueries(() =>
        post(`/wardrobe-share/invite/${token}/decline`, owner),
      );
      expect(withdrawn.statements).toBe(2);
    });

    it('remove: the session and the delete', async () => {
      const guest = await signUp('removed');
      await shareWith(guest, 'VIEW');
      const [share] = await t.db
        .select({ id: wardrobeShare.id })
        .from(wardrobeShare)
        .where(eq(wardrobeShare.granteeId, guest.id));
      const record = await recordQueries(async () => {
        const res = await post(`/wardrobe-share/${share.id}/remove`, owner);
        expect(res.statusCode).toBe(302);
      });
      expect(record.statements).toBe(2);
    });
  });

  it('the capsule list’s one statement: each card’s closet count and newest four', async () => {
    const ids: number[] = [];
    for (const name of ['One', 'Two', 'Three', 'Four', 'Five']) {
      ids.push(await createGarment(t, { name }));
    }
    const [capsuleRow] = await t.db
      .select({ id: capsule.id })
      .from(capsule)
      .where(eq(capsule.ownerId, owner.id));
    await asFixture(t.db, (tx) =>
      tx
        .insert(capsuleGarment)
        .values(
          ids.map((garmentId) => ({ capsuleId: capsuleRow.id, garmentId })),
        ),
    );
    // An archived member keeps its membership and leaves the card.
    await asFixture(t.db, (tx) =>
      tx
        .update(garment)
        .set({ status: 'archived' })
        .where(eq(garment.id, ids[4])),
    );

    const list = readCapsuleList(
      await selectScalars(t.db, capsuleListSql(owner.id)),
    );
    const closet = await t.db
      .select({ id: garment.id })
      .from(garment)
      .where(and(eq(garment.ownerId, owner.id), eq(garment.status, 'closet')))
      .orderBy(desc(garment.id));
    expect(list.closet.count).toBe(closet.length);
    expect(list.closet.strip.map((shown) => shown.id)).toEqual(
      closet.slice(0, 4).map((row) => row.id),
    );
    expect(list.capsules).toEqual([
      {
        id: capsuleRow.id,
        name: 'Weekend',
        count: 4,
        strip: [ids[3], ids[2], ids[1], ids[0]].map((id, i) => ({
          id,
          name: ['Four', 'Three', 'Two', 'One'][i],
          category: 'shirt',
          photo: null,
        })),
      },
    ]);
  });

  it('Profile reads its three share lists in one statement', async () => {
    const record = await recordQueries(async () => {
      const res = await get('/auth/profile', viewer);
      expect(res.statusCode).toBe(200);
    });
    expect(shareStatements(record.sql)).toHaveLength(1);
  });
});
