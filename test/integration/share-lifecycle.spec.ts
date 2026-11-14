import { and, count, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SharePermission, user, wardrobeShare } from '../../src/db/schema';
import { LOGIN_PATH } from '../../src/web/auth/login-path';
import { loginUrl, registerUrl } from '../../src/web/auth/return-to';
import { updatePasswordHash } from '../../src/web/auth/queries';
import {
  acceptInvite,
  createInvite as mintInvite,
  INVITE_LIFETIME_MS,
} from '../../src/web/sharing/queries';
import { invitePath } from '../../src/web/sharing/urls';
import { createGarment, garmentRow, garmentsNamed } from './garments';
import {
  createTestApp,
  sessionStampOf,
  TEST_PASSWORD,
  TestApp,
  unescapeHtml,
  uniqueClient,
  userIdOf,
} from './harness';
import { interleave } from './interleave';

/**
 * A wardrobe share after it is created (share.spec.ts covers creating and
 * accepting): revoking it from either side ends read and write access,
 * declining an invite grants nothing, and the accept edge cases (the same
 * invite twice, your own invite, an invite addressed to someone else, a
 * clash with a pending addressed invite) are refused without a half-made
 * share. Every test uses fresh grantees so shares never interact.
 *
 * Without a share the owner's wardrobe does not exist for a user: reads and
 * writes addressing it are 404, as for an unknown id.
 */
describe('wardrobe share lifecycle', () => {
  let t: TestApp;
  let owner: Account;
  let garmentId: number;

  interface Account {
    id: number;
    cookie: string;
  }

  /** Where sharing is managed since #82: Profile › Sharing. */
  const SHARING = '/auth/profile#sharing';

  const signUp = async (label: string): Promise<Account> => {
    const email = `${label}-${randomUUID().slice(0, 8)}@example.com`;
    const cookie = await t.register(email);
    const id = await userIdOf(t, email);
    return { id, cookie };
  };

  /**
   * An open invite link; its token. Through the writer: the route is
   * ACCOUNT_LIMITed and asks an edit link for the password (#668), which
   * `creating an invite` below drives.
   */
  const createInvite = async (grantor: Account, permission: SharePermission) =>
    (await mintInvite(t.db, grantor.id, permission)).inviteToken;

  /**
   * An invite with its grantee already set. The UI only makes open links
   * (grantee null); this is the row shape acceptInvite/declineInvite guard
   * with "sent to a different email address", so it is written directly.
   */
  const createAddressedInvite = async (addressee: Account) => {
    const inviteToken = randomUUID();
    await t.db.insert(wardrobeShare).values({
      grantorId: owner.id,
      granteeId: addressee.id,
      permission: 'VIEW',
      inviteToken,
      createdAt: new Date(),
    });
    return inviteToken;
  };

  const post = (url: string, account?: Account, payload?: object) =>
    t.inject({
      method: 'POST',
      url,
      payload,
      headers: account ? { cookie: account.cookie } : {},
      anonymous: !account,
    });

  const accept = (token: string, account?: Account) =>
    post(`/wardrobe-share/invite/${token}/accept`, account);

  const decline = (token: string, account?: Account) =>
    post(`/wardrobe-share/invite/${token}/decline`, account);

  /** Accepted: straight into the grantor's wardrobe (#661), every invite here the owner's. */
  const acceptOk = async (token: string, account: Account) => {
    const res = await accept(token, account);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/wardrobe?ownerId=${owner.id}`);
  };

  /**
   * A refused accept: redirect back to Profile › Sharing carrying the
   * refusal code, which the section shows as its message.
   */
  const expectAcceptRefused = async (
    res: Awaited<ReturnType<typeof accept>>,
    code: string,
    message: string,
    account: Account,
  ) => {
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      `/auth/profile?shareError=${code}#sharing`,
    );
    const page = await t.inject({
      method: 'GET',
      url: `/auth/profile?shareError=${code}`,
      headers: { cookie: account.cookie },
    });
    expect(page.body).toContain(message);
  };

  type ShareRow = typeof wardrobeShare.$inferSelect;

  const shareBetween = async (grantee: Account): Promise<ShareRow | null> => {
    const [row] = await t.db
      .select()
      .from(wardrobeShare)
      .where(
        and(
          eq(wardrobeShare.grantorId, owner.id),
          eq(wardrobeShare.granteeId, grantee.id),
        ),
      );
    return row ?? null;
  };

  const shareByToken = async (token: string): Promise<ShareRow | null> => {
    const [row] = await t.db
      .select()
      .from(wardrobeShare)
      .where(eq(wardrobeShare.inviteToken, token));
    return row ?? null;
  };

  /** Status of reading the owner's wardrobe grid and garment as `account`. */
  const readStatuses = async (account: Account) => {
    const headers = { cookie: account.cookie };
    const [grid, garment] = await Promise.all([
      t.inject({
        method: 'GET',
        url: `/wardrobe?ownerId=${owner.id}`,
        headers,
      }),
      t.inject({
        method: 'GET',
        url: `/wardrobe/${garmentId}?ownerId=${owner.id}`,
        headers,
      }),
    ]);
    return [grid.statusCode, garment.statusCode];
  };

  /** Edit the owner's garment and create one in their wardrobe; statuses. */
  const writeStatuses = async (account: Account) => {
    const edit = await post(
      `/wardrobe/${garmentId}?ownerId=${owner.id}`,
      account,
      { name: `Edited by ${account.id}`, category: 'pants' },
    );
    const create = await post(`/wardrobe?ownerId=${owner.id}`, account, {
      name: `Planted by ${account.id}`,
      category: 'shirt',
    });
    return [edit.statusCode, create.statusCode];
  };

  const expectNoWritesLanded = async (account: Account) => {
    const garment = (await garmentRow(t, garmentId))!;
    expect(garment.name).toBe('Owner coat');
    expect(garment.category).toBe('shirt');
    expect(await garmentsNamed(t, `Planted by ${account.id}`)).toBe(0);
  };

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signUp('owner');
    garmentId = await createGarment(t, {
      name: 'Owner coat',
      cookie: owner.cookie,
    });
  });

  afterAll(() => t?.cleanup());

  it('the wardrobe switcher is the title’s menu: each wardrobe a page of its own, and Manage sharing', async () => {
    const grantee = await signUp('switcher');
    await acceptOk(await createInvite(owner, 'VIEW'), grantee);
    const page = await t.inject({
      method: 'GET',
      url: '/wardrobe',
      headers: { cookie: grantee.cookie },
    });
    const menu =
      /<details class="dropdown min-w-0" id="title-menu">[\s\S]*?<\/details>/.exec(
        unescapeHtml(page.body),
      )?.[0];
    expect(menu).toBeDefined();
    // The page's one h1 is the menu's summary.
    expect(menu).toMatch(/<summary[^>]*><h1[^>]*>Wardrobe<\/h1>/);
    expect(menu).toMatch(/href="\/wardrobe" aria-current="true"/);
    // Plain boosted links, whole pages: the title and the tabs change too.
    expect(menu).toContain(`href="/wardrobe?ownerId=${owner.id}"`);
    expect(menu).not.toContain('hx-target');
    expect(menu).toContain('View only');
    expect(menu).toContain('href="/auth/profile#sharing"');

    const shared = await t.inject({
      method: 'GET',
      url: `/wardrobe?ownerId=${owner.id}`,
      headers: { cookie: grantee.cookie },
    });
    expect(shared.statusCode).toBe(200);
    expect(shared.body).toMatch(/<h1[^>]*>[^<]*’s wardrobe<\/h1>/);
    expect(shared.body).toContain(`/wardrobe/${garmentId}?ownerId=${owner.id}`);

    // Pages the installed app cached before still swap the grid with the
    // old <select>: the fragment answers it, the empty value the grantee's
    // own wardrobe.
    const swapped = await t.inject({
      method: 'GET',
      url: `/wardrobe?ownerId=${owner.id}`,
      headers: { cookie: grantee.cookie, 'hx-request': 'true' },
    });
    expect(swapped.statusCode).toBe(200);
    expect(swapped.body).toMatch(/^<main id="wardrobe-main"/);
    expect(swapped.body).toContain(
      `/wardrobe/${garmentId}?ownerId=${owner.id}`,
    );
    const own = await t.inject({
      method: 'GET',
      url: '/wardrobe?ownerId=',
      headers: { cookie: grantee.cookie, 'hx-request': 'true' },
    });
    expect(own.statusCode).toBe(200);
    expect(own.body).not.toContain(`/wardrobe/${garmentId}`);
  });

  it('the public invite page never shows the inviter email', async () => {
    const email = `inviter-${randomUUID().slice(0, 8)}@example.com`;
    const cookie = await t.register(email);
    const inviter = { id: await userIdOf(t, email), cookie };
    const token = await createInvite(inviter, 'VIEW');

    const res = await t.inject({
      method: 'GET',
      url: `/wardrobe-share/invite/${token}`,
      anonymous: true,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(email);
    expect(res.body).toContain('A user');
  });

  describe('revoke (POST /wardrobe-share/:id/remove)', () => {
    it('by the grantor: the MANAGE grantee loses read and write access', async () => {
      const grantee = await signUp('manager');
      await acceptOk(await createInvite(owner, 'MANAGE'), grantee);
      expect(await readStatuses(grantee)).toEqual([200, 200]);
      const share = await shareBetween(grantee);

      const res = await post(`/wardrobe-share/${share!.id}/remove`, owner);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(SHARING);
      expect(await shareBetween(grantee)).toBeNull();

      expect(await readStatuses(grantee)).toEqual([404, 404]);
      expect(await writeStatuses(grantee)).toEqual([404, 404]);
      await expectNoWritesLanded(grantee);
    });

    it('by the grantee: leaving a VIEW share ends read access', async () => {
      const grantee = await signUp('viewer');
      await acceptOk(await createInvite(owner, 'VIEW'), grantee);
      const share = await shareBetween(grantee);

      const res = await post(`/wardrobe-share/${share!.id}/remove`, grantee);
      expect(res.statusCode).toBe(302);
      expect(await shareBetween(grantee)).toBeNull();
      expect(await readStatuses(grantee)).toEqual([404, 404]);
    });

    it('by a third party or anonymously: refused, the share and its access stay', async () => {
      const grantee = await signUp('manager');
      const stranger = await signUp('stranger');
      await acceptOk(await createInvite(owner, 'MANAGE'), grantee);
      const share = await shareBetween(grantee);
      const url = `/wardrobe-share/${share!.id}/remove`;

      // Not their share: as unknown as a missing id.
      expect((await post(url, stranger)).statusCode).toBe(404);
      const anonymous = await post(url);
      expect(anonymous.statusCode).toBe(302);
      expect(anonymous.headers.location).toBe(LOGIN_PATH);

      expect(await shareBetween(grantee)).toMatchObject({
        id: share!.id,
        permission: 'MANAGE',
      });
      expect(await readStatuses(grantee)).toEqual([200, 200]);
    });

    it('an unknown share id is a 404', async () => {
      expect(
        (await post('/wardrobe-share/999999/remove', owner)).statusCode,
      ).toBe(404);
    });
  });

  describe('decline (POST /wardrobe-share/invite/:token/decline)', () => {
    // declineInvite doubles as "the grantor revokes an open link"; anyone
    // else declining an open link is refused (and the refusal swallowed by
    // the controller), so the link survives for whoever it was meant for.
    it('by a recipient of an open link: the link stays pending and they gain nothing', async () => {
      const recipient = await signUp('recipient');
      const token = await createInvite(owner, 'MANAGE');

      const res = await decline(token, recipient);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(SHARING);

      const invite = await shareByToken(token);
      expect(invite).not.toBeNull();
      expect(invite!.granteeId).toBeNull();
      expect(invite!.acceptedAt).toBeNull();
      expect(await shareBetween(recipient)).toBeNull();
      expect(await readStatuses(recipient)).toEqual([404, 404]);
    });

    it('by the grantor: the open link is deleted and can no longer be accepted', async () => {
      const recipient = await signUp('recipient');
      const token = await createInvite(owner, 'VIEW');

      expect((await decline(token, owner)).statusCode).toBe(302);
      expect(await shareByToken(token)).toBeNull();

      await expectAcceptRefused(
        await accept(token, recipient),
        'not-found',
        'Invite not found or has already been accepted.',
        recipient,
      );
      expect(await shareBetween(recipient)).toBeNull();
      expect(await readStatuses(recipient)).toEqual([404, 404]);
    });

    it('by the addressee of an addressed invite: the invite is deleted, no share made', async () => {
      const addressee = await signUp('addressee');
      const token = await createAddressedInvite(addressee);

      expect((await decline(token, addressee)).statusCode).toBe(302);
      expect(await shareByToken(token)).toBeNull();
      expect(await shareBetween(addressee)).toBeNull();
      expect(await readStatuses(addressee)).toEqual([404, 404]);
    });

    it('by someone other than the addressee: refused, the invite is untouched', async () => {
      const addressee = await signUp('addressee');
      const other = await signUp('other');
      const token = await createAddressedInvite(addressee);

      expect((await decline(token, other)).statusCode).toBe(302);
      const invite = await shareByToken(token);
      expect(invite!.granteeId).toBe(addressee.id);
      expect(invite!.acceptedAt).toBeNull();
    });

    it('anonymously: redirected to login, the invite is untouched', async () => {
      const token = await createInvite(owner, 'VIEW');
      const res = await decline(token);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(LOGIN_PATH);
      expect(await shareByToken(token)).not.toBeNull();
    });
  });

  // #661: a partner opening an invite signed out signs in or registers and
  // comes back to it, then Accept opens the grantor's wardrobe.
  describe('an invite opened signed out', () => {
    const grantorNamed = async (firstName: string | null) => {
      const grantor = await signUp('named-grantor');
      await t.db.update(user).set({ firstName }).where(eq(user.id, grantor.id));
      return grantor;
    };

    const landing = (token: string, account?: Account) =>
      t.inject({
        method: 'GET',
        url: invitePath(token),
        headers: account ? { cookie: account.cookie } : {},
        anonymous: !account,
      });

    it('names the owner in the invitee’s words, never by email', async () => {
      const grantor = await grantorNamed('James');
      const view = unescapeHtml(
        (await landing(await createInvite(grantor, 'VIEW'))).body,
      );
      // A name ending in s keeps the house possessive, as WARDROBE_OF does.
      expect(view).toContain(
        'You’ll be able to see everything in James’s wardrobe. You can’t add, edit or delete.',
      );
      expect(view).not.toContain('They can view');
      expect(view).not.toMatch(/named-grantor-[0-9a-f]+@example\.com/);

      const manage = unescapeHtml(
        (await landing(await createInvite(grantor, 'MANAGE'))).body,
      );
      expect(manage).toContain(
        'You’ll be able to see, add and edit garments in James’s wardrobe.',
      );
    });

    it('says “this wardrobe” for a grantor with no name, never their email', async () => {
      const grantor = await grantorNamed(null);
      const body = unescapeHtml(
        (await landing(await createInvite(grantor, 'VIEW'))).body,
      );
      expect(body).toContain(
        'You’ll be able to see everything in this wardrobe.',
      );
      expect(body).not.toMatch(/named-grantor-[0-9a-f]+@example\.com/);
    });

    it('signing in from it returns to it, and Accept opens the grantor’s wardrobe', async () => {
      const grantor = await grantorNamed('Theo');
      const token = await createInvite(grantor, 'VIEW');
      const page = await landing(token);
      expect(page.body).toContain(`href="${loginUrl(invitePath(token))}"`);
      expect(page.body).toContain(`href="${registerUrl(invitePath(token))}"`);

      const invitee = await signUp('invitee');
      const email = (await t.db.query.user.findFirst({
        where: eq(user.id, invitee.id),
      }))!.email!;
      const signedIn = await t.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email,
          password: TEST_PASSWORD,
          returnTo: invitePath(token),
        },
        headers: uniqueClient(),
        anonymous: true,
      });
      expect(signedIn.statusCode).toBe(302);
      expect(signedIn.headers.location).toBe(invitePath(token));
      const cookie = signedIn.cookies.find((c) => c.name === 'access_token')!;
      const session = {
        id: invitee.id,
        cookie: `access_token=${cookie.value}`,
      };

      expect((await landing(token, session)).body).toContain(
        `action="${invitePath(token)}/accept"`,
      );
      const accepted = await accept(token, session);
      expect(accepted.headers.location).toBe(`/wardrobe?ownerId=${grantor.id}`);
      // The new grantee's way in: a page, not a refusal.
      const wardrobe = await t.inject({
        method: 'GET',
        url: accepted.headers.location,
        headers: { cookie: session.cookie },
      });
      expect(wardrobe.statusCode).toBe(200);
    });

    it('registering from it returns to it', async () => {
      const token = await createInvite(owner, 'VIEW');
      const res = await t.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: `new-invitee-${randomUUID().slice(0, 8)}@example.com`,
          password: TEST_PASSWORD,
          confirmPassword: TEST_PASSWORD,
          returnTo: invitePath(token),
        },
        headers: uniqueClient(),
        anonymous: true,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(invitePath(token));
    });

    it.each(['accept', 'decline'])(
      'a %s whose session ended returns to the invite page, never the post',
      async (answer) => {
        const token = await createInvite(owner, 'VIEW');
        const res = await t.inject({
          method: 'POST',
          url: `${invitePath(token)}/${answer}`,
          headers: { referer: `http://localhost${invitePath(token)}` },
          anonymous: true,
        });
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe(loginUrl(invitePath(token)));
        expect(await shareByToken(token)).toMatchObject({ acceptedAt: null });
      },
    );
  });

  describe('accept edge cases (POST /wardrobe-share/invite/:token/accept)', () => {
    it('the same invite twice: the second is refused and the share is unchanged', async () => {
      const grantee = await signUp('viewer');
      const token = await createInvite(owner, 'VIEW');
      await acceptOk(token, grantee);
      const first = await shareBetween(grantee);

      await expectAcceptRefused(
        await accept(token, grantee),
        'not-found',
        'Invite not found or has already been accepted.',
        grantee,
      );
      const [{ shares }] = await t.db
        .select({ shares: count() })
        .from(wardrobeShare)
        .where(eq(wardrobeShare.granteeId, grantee.id));
      expect(shares).toBe(1);
      expect(await shareBetween(grantee)).toMatchObject({
        id: first!.id,
        permission: 'VIEW',
      });
    });

    it('an invite someone else already accepted: refused, no access', async () => {
      const grantee = await signUp('viewer');
      const latecomer = await signUp('latecomer');
      const token = await createInvite(owner, 'MANAGE');
      await acceptOk(token, grantee);

      await expectAcceptRefused(
        await accept(token, latecomer),
        'not-found',
        'Invite not found or has already been accepted.',
        latecomer,
      );
      expect(await shareBetween(latecomer)).toBeNull();
      expect(await readStatuses(latecomer)).toEqual([404, 404]);
      expect(await writeStatuses(latecomer)).toEqual([404, 404]);
      await expectNoWritesLanded(latecomer);
    });

    it('your own invite: refused, the link stays pending', async () => {
      const token = await createInvite(owner, 'MANAGE');

      await expectAcceptRefused(
        await accept(token, owner),
        'own-invite',
        'You cannot accept your own invite.',
        owner,
      );
      const invite = await shareByToken(token);
      expect(invite!.granteeId).toBeNull();
      expect(invite!.acceptedAt).toBeNull();
    });

    it('an invite addressed to someone else: refused, only the addressee can accept', async () => {
      const addressee = await signUp('addressee');
      const other = await signUp('other');
      const token = await createAddressedInvite(addressee);

      await expectAcceptRefused(
        await accept(token, other),
        'wrong-recipient',
        'This invite was sent to a different email address.',
        other,
      );
      expect(await shareBetween(other)).toBeNull();
      expect(await readStatuses(other)).toEqual([404, 404]);
      expect(await shareByToken(token)).toMatchObject({ acceptedAt: null });

      await acceptOk(token, addressee);
      expect(await readStatuses(addressee)).toEqual([200, 200]);
    });

    // The unique (grantor, grantee) constraint trips when a user with a
    // pending addressed invite accepts an open link from the same grantor;
    // acceptInvite maps the violation to a 400-style refusal (audit A4 bug 1
    // was this path turning into a 500).
    it('an open link while an addressed invite is pending: refused without a 500', async () => {
      const addressee = await signUp('addressee');
      const pending = await createAddressedInvite(addressee);
      const open = await createInvite(owner, 'MANAGE');

      await expectAcceptRefused(
        await accept(open, addressee),
        'already-shared',
        'You already have access to this wardrobe.',
        addressee,
      );
      expect(await readStatuses(addressee)).toEqual([404, 404]);
      expect(await shareByToken(open)).toMatchObject({ granteeId: null });
      expect(await shareByToken(pending)).toMatchObject({ acceptedAt: null });
    });

    it('anonymously: redirected to login, the invite is untouched', async () => {
      const token = await createInvite(owner, 'VIEW');
      const res = await accept(token);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(LOGIN_PATH);
      expect(await shareByToken(token)).toMatchObject({ granteeId: null });
    });
  });

  // #668: an edit link is a credential (it asks for the password), an
  // unanswered invite lives INVITE_LIFETIME_MS, and a new password deletes
  // the invites its account sent that nobody accepted.
  describe('invites as credentials', () => {
    const NEW_PASSWORD = 'Another-pass-668';

    const signUpAs = async (label: string) => {
      const email = `${label}-${randomUUID().slice(0, 8)}@example.com`;
      const cookie = await t.register(email);
      return { id: await userIdOf(t, email), cookie, email };
    };

    const createLink = (
      grantor: Account,
      payload: { permission?: SharePermission; currentPassword?: string },
      htmx = false,
    ) =>
      t.inject({
        method: 'POST',
        url: '/wardrobe-share/create-invite-link',
        payload,
        headers: htmx
          ? { cookie: grantor.cookie, 'hx-request': 'true' }
          : { cookie: grantor.cookie },
      });

    const invitesOf = (grantor: Account) =>
      t.db
        .select({
          permission: wardrobeShare.permission,
          granteeId: wardrobeShare.granteeId,
          acceptedAt: wardrobeShare.acceptedAt,
        })
        .from(wardrobeShare)
        .where(eq(wardrobeShare.grantorId, grantor.id));

    /** An open invite's created_at, `ms` before the app's clock. */
    const age = (token: string, ms: number) =>
      t.db
        .update(wardrobeShare)
        .set({ createdAt: new Date(Date.now() - ms) })
        .where(eq(wardrobeShare.inviteToken, token));

    const INVITE_URL = /\/wardrobe-share\/invite\/[0-9a-f-]{36}/;

    it('an edit link without the current password, or with a wrong one, is a 400 and stores nothing', async () => {
      const grantor = await signUpAs('stepup-refused');
      for (const currentPassword of [undefined, 'Wrong-pass-1']) {
        for (const htmx of [false, true]) {
          const res = await createLink(
            grantor,
            { permission: 'MANAGE', currentPassword },
            htmx,
          );
          expect(res.statusCode).toBe(400);
          expect(res.body).toContain('Current password is incorrect');
          expect(res.body).not.toMatch(INVITE_URL);
        }
      }
      expect(await invitesOf(grantor)).toEqual([]);
    });

    it('an edit link with the current password: a MANAGE invite, back on Profile › Sharing with its link', async () => {
      const grantor = await signUpAs('stepup-ok');
      const res = await createLink(grantor, {
        permission: 'MANAGE',
        currentPassword: TEST_PASSWORD,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(SHARING);
      expect(await invitesOf(grantor)).toEqual([
        { permission: 'MANAGE', granteeId: null, acceptedAt: null },
      ]);
      const [row] = await t.db
        .select({ token: wardrobeShare.inviteToken })
        .from(wardrobeShare)
        .where(eq(wardrobeShare.grantorId, grantor.id));
      const profile = await t.inject({
        method: 'GET',
        url: '/auth/profile',
        headers: { cookie: grantor.cookie },
      });
      expect(unescapeHtml(profile.body)).toContain(invitePath(row.token!));
    });

    it('a view link takes no password: one tap', async () => {
      const grantor = await signUpAs('view-link');
      const res = await createLink(grantor, { permission: 'VIEW' }, true);
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(INVITE_URL);
      expect(await invitesOf(grantor)).toEqual([
        { permission: 'VIEW', granteeId: null, acceptedAt: null },
      ]);
    });

    it('a grantee naming the owner’s wardrobe mints a link to their own, never the owner’s', async () => {
      const manager = await signUpAs('stepup-grantee');
      await acceptOk(await createInvite(owner, 'MANAGE'), manager);
      const res = await t.inject({
        method: 'POST',
        url: `/wardrobe-share/create-invite-link?ownerId=${owner.id}`,
        payload: { permission: 'MANAGE', currentPassword: TEST_PASSWORD },
        headers: { cookie: manager.cookie },
      });
      expect(res.statusCode).toBe(302);
      expect(await invitesOf(manager)).toEqual([
        { permission: 'MANAGE', granteeId: null, acceptedAt: null },
      ]);
    });

    it('the step-up page is a native post form no cache keeps', async () => {
      const grantor = await signUpAs('stepup-page');
      const res = await t.inject({
        method: 'GET',
        url: '/wardrobe-share/edit-invite',
        headers: { cookie: grantor.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toContain('action="/wardrobe-share/create-invite-link"');
      expect(res.body).toContain('name="currentPassword"');
    });

    it('an invite past its lifetime: the landing says it expired, accepting refuses, and its grantor sees it expired', async () => {
      const guest = await signUpAs('expired-guest');
      const token = await createInvite(owner, 'MANAGE');
      await age(token, INVITE_LIFETIME_MS + 60_000);
      const expired = 'This invite has expired. Ask for a new link.';

      const landing = await t.inject({
        method: 'GET',
        url: invitePath(token),
        headers: { cookie: guest.cookie },
      });
      expect(landing.statusCode).toBe(200);
      expect(unescapeHtml(landing.body)).toContain(expired);
      expect(landing.body).not.toContain(`${invitePath(token)}/accept`);

      await expectAcceptRefused(
        await accept(token, guest),
        'expired',
        expired,
        guest,
      );
      expect(await shareBetween(guest)).toBeNull();
      const row = (await shareByToken(token))!;
      expect(row).toMatchObject({ granteeId: null, acceptedAt: null });

      // Listed to its grantor as expired, without its link, still revocable.
      const profile = await t.inject({
        method: 'GET',
        url: '/auth/profile',
        headers: { cookie: owner.cookie },
      });
      expect(unescapeHtml(profile.body)).not.toContain(invitePath(token));
      expect(profile.body).toContain('Expired');
      expect(profile.body).toContain(`/wardrobe-share/${row.id}/remove`);
    });

    it('valid until the instant created_at plus its lifetime, not at it', async () => {
      const guest = await signUpAs('boundary');
      const token = await createInvite(owner, 'VIEW');
      const { createdAt } = (await shareByToken(token))!;
      const expiry = createdAt.getTime() + INVITE_LIFETIME_MS;
      expect(
        await acceptInvite(t.db, token, guest.id, new Date(expiry)),
      ).toEqual({ accepted: false, reason: 'expired' });
      expect(
        await acceptInvite(t.db, token, guest.id, new Date(expiry - 1)),
      ).toMatchObject({ accepted: true, grantorId: owner.id });
    });

    it('an accepted share outlives the invite lifetime', async () => {
      const grantee = await signUpAs('long-share');
      await acceptOk(await createInvite(owner, 'VIEW'), grantee);
      await t.db
        .update(wardrobeShare)
        .set({ createdAt: new Date(Date.now() - 10 * INVITE_LIFETIME_MS) })
        .where(eq(wardrobeShare.granteeId, grantee.id));
      expect(await readStatuses(grantee)).toEqual([200, 200]);
    });

    // The read finds the invite in force; it expires before the guarded
    // write runs, whose own cutoff refuses it: "gone meanwhile".
    it.each([
      ['claimed', undefined],
      ['folded into a VIEW share', 'VIEW'],
    ] as const)(
      'an invite that expires between the read and the write is not found: %s',
      async (_what, held) => {
        const guest = await signUpAs('race-expiry');
        if (held) await acceptOk(await createInvite(owner, held), guest);
        const token = await createInvite(owner, 'MANAGE');
        const [, result] = await interleave(
          t.db,
          (tx) =>
            tx
              .update(wardrobeShare)
              .set({
                createdAt: new Date(Date.now() - INVITE_LIFETIME_MS - 60_000),
              })
              .where(eq(wardrobeShare.inviteToken, token)),
          () => acceptInvite(t.db, token, guest.id),
        );
        expect(result).toEqual({ accepted: false, reason: 'not-found' });
        expect(await shareByToken(token)).toMatchObject({
          granteeId: null,
          acceptedAt: null,
        });
        expect((await shareBetween(guest))?.permission ?? null).toBe(
          held ?? null,
        );
      },
    );

    it('a new password deletes the invites its account sent that nobody accepted, keeps the rest, and lists who still has the wardrobe', async () => {
      const grantor = await signUpAs('new-password');
      const grantee = await signUpAs('kept-grantee');
      const other = await signUpAs('other-sender');
      const kept = await createInvite(grantor, 'MANAGE');
      expect((await acceptInvite(t.db, kept, grantee.id)).accepted).toBe(true);
      const open = await createInvite(grantor, 'MANAGE');
      const addressed = randomUUID();
      const received = randomUUID();
      await t.db.insert(wardrobeShare).values([
        // Sent by the grantor to someone: goes with the open link.
        {
          grantorId: grantor.id,
          granteeId: other.id,
          permission: 'VIEW',
          inviteToken: addressed,
          createdAt: new Date(),
        },
        // Received by the grantor: not theirs to revoke, it stays.
        {
          grantorId: other.id,
          granteeId: grantor.id,
          permission: 'VIEW',
          inviteToken: received,
          createdAt: new Date(),
        },
      ]);
      const othersOpen = await createInvite(other, 'VIEW');

      t.logs.clear();
      const res = await t.inject({
        method: 'POST',
        url: '/auth/change-password',
        payload: {
          currentPassword: TEST_PASSWORD,
          newPassword: NEW_PASSWORD,
          confirmPassword: NEW_PASSWORD,
        },
        headers: { cookie: grantor.cookie },
      });
      expect(res.statusCode).toBe(302);

      expect(await shareByToken(open)).toBeNull();
      expect(await shareByToken(addressed)).toBeNull();
      expect(await shareByToken(received)).not.toBeNull();
      expect(await shareByToken(othersOpen)).not.toBeNull();
      expect(await invitesOf(grantor)).toEqual([
        expect.objectContaining({
          granteeId: grantee.id,
          permission: 'MANAGE',
        }),
      ]);
      expect(t.logs.messages('info', 'Web').join('\n')).toContain(
        '2 unanswered invites revoked',
      );

      const confirmation = await t.inject({
        method: 'GET',
        url: res.headers.location,
        headers: { cookie: await t.login(grantor.email, NEW_PASSWORD) },
      });
      const shown = unescapeHtml(confirmation.body);
      expect(shown).toContain('Your unused invite links no longer work.');
      expect(shown).toContain(grantee.email);
    });

    it('an invite accepted after its grantor’s new password is not found', async () => {
      const grantor = await signUpAs('after-password');
      const guest = await signUpAs('too-late');
      const token = await createInvite(grantor, 'MANAGE');
      await updatePasswordHash(t.db, grantor.id, 'not-a-hash-668');
      expect(await acceptInvite(t.db, token, guest.id)).toEqual({
        accepted: false,
        reason: 'not-found',
      });
    });

    it('an invite minted while the password waits goes with it; one that waited for the password is refused', async () => {
      const grantor = await signUpAs('mint-race');
      const session = await sessionStampOf(t.db, grantor.id);
      const [minted, change] = await interleave(
        t.db,
        (tx) => mintInvite(tx, grantor.id, 'VIEW', { session }),
        () => updatePasswordHash(t.db, grantor.id, 'not-a-hash-held'),
      );
      expect(minted).toBeDefined();
      expect(change.revokedInvites).toBe(1);
      expect(await invitesOf(grantor)).toEqual([]);

      const waiter = await signUpAs('mint-waited');
      const [, res] = await interleave(
        t.db,
        (tx) =>
          tx
            .update(user)
            .set({ password: 'not-a-hash-moved' })
            .where(eq(user.id, waiter.id)),
        () => createLink(waiter, { permission: 'VIEW' }, true),
      );
      expect(res.statusCode).toBe(401);
      expect(res.headers['hx-redirect']).toBe('/auth/login');
      expect(await invitesOf(waiter)).toEqual([]);
    });

    // Sign out everywhere moves only the session version (#700): an invite
    // asked for by a session it ended, waiting on the lock, is refused too.
    it('an invite that waited for a session-version bump is refused', async () => {
      const waiter = await signUpAs('mint-version');
      const [, res] = await interleave(
        t.db,
        (tx) =>
          tx
            .update(user)
            .set({ sessionVersion: 7 })
            .where(eq(user.id, waiter.id)),
        () => createLink(waiter, { permission: 'VIEW' }, true),
      );
      expect(res.statusCode).toBe(401);
      expect(await invitesOf(waiter)).toEqual([]);
    });
  });
});
