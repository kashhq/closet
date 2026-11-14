import { eq } from 'drizzle-orm';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import webpush, { type PushSubscription } from 'web-push';
import { user, userDevice } from '../../src/db/schema';
import { runRevokeAllPush } from '../../src/maintenance/revoke-push';
import { runSetPassword } from '../../src/maintenance/set-password';
import { type MinuteOfDay } from '../../src/push/reminders';
import { addDays, instantAt } from '../../src/calendar-date';
import { updatePasswordHash } from '../../src/web/auth/queries';
import { saveReminderSettings, upsertDevice } from '../../src/web/push/queries';
import { sendDueReminders } from '../../src/web/push/reminders';
import { captureLogs } from '../support/log-capture';
import {
  createTestApp,
  PWA_ENV,
  sessionStampOf,
  TEST_PASSWORD,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import { interleave } from './interleave';

/**
 * Push subscriptions go with the sessions a new password revokes (#73): the
 * change-password route and `user:set-password` delete the account's
 * `user_device` rows in the password's own transaction (revokeDevices,
 * called by updatePasswordHash), keeping only the device that made the
 * change, named by the endpoint its form posts; `push:revoke-all` (after an
 * ACCESS_TOKEN_SECRET rotation) removes everyone's; account deletion
 * cascades. The browser side is the login page's <push-signed-out>
 * (test/push-revocation.spec.ts (retired 2026-10-13) drives it in Chromium). web-push is
 * stubbed: nothing leaves the process.
 */

const NEW_PASSWORD = 'NewPassword456!';
const MORNING: MinuteOfDay = 7 * 60 + 30;

function subscription(endpoint = newEndpoint()) {
  return {
    endpoint,
    keys: {
      p256dh: createECDH('prime256v1').generateKeys().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}

function newEndpoint(): string {
  return `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
}

describe('push subscriptions revoked with the sessions (PWA_ENABLED=true)', () => {
  let t: TestApp;
  let sentTo: string[];

  /** A device signed in with `cookie`, subscribed; its endpoint. */
  const subscribe = async (cookie: string) => {
    const sub = subscription();
    const res = await t.inject({
      method: 'POST',
      url: '/push/subscribe',
      payload: sub,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(204);
    return sub.endpoint;
  };

  const endpointsOf = async (userId: number) =>
    (
      await t.db
        .select({ endpoint: userDevice.pushEndpoint })
        .from(userDevice)
        .where(eq(userDevice.userId, userId))
        .orderBy(userDevice.id)
    ).map((row) => row.endpoint);

  const deviceAt = async (endpoint: string) =>
    (
      await t.db
        .select()
        .from(userDevice)
        .where(eq(userDevice.pushEndpoint, endpoint))
    )[0];

  const changePassword = (cookie: string, extra: Record<string, string>) =>
    t.inject({
      method: 'POST',
      url: '/auth/change-password',
      payload: {
        currentPassword: TEST_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
        ...extra,
      },
      headers: { cookie },
    });

  /** An account signed in on two devices, both subscribed. */
  const twoDevices = async (prefix: string) => {
    const email = `${prefix}-${randomUUID()}@example.com`;
    const cookieA = await t.register(email);
    const cookieB = await t.login(email);
    const userId = await userIdOf(t, email);
    return {
      email,
      userId,
      cookieA,
      endpointA: await subscribe(cookieA),
      endpointB: await subscribe(cookieB),
    };
  };

  beforeAll(async () => {
    t = await createTestApp(PWA_ENV);
  });

  afterAll(() => t?.cleanup());

  beforeEach(() => {
    sentTo = [];
    vi.spyOn(webpush, 'sendNotification').mockImplementation(
      (target: PushSubscription) => {
        sentTo.push(target.endpoint);
        return Promise.resolve({ statusCode: 201, body: '', headers: {} });
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('changing the password', () => {
    it('keeps the device that changed it, reminders and all, and revokes the other; the scheduler reminds only the one kept', async () => {
      const { userId, cookieA, endpointA, endpointB } =
        await twoDevices('changer');
      // Another account's device is none of this change's business.
      const bystander = await subscribe(t.owner.cookie);
      const setAt = new Date('2020-01-01T00:00:00Z');
      for (const endpoint of [endpointA, endpointB]) {
        await saveReminderSettings(
          t.db,
          userId,
          endpoint,
          { morning: MORNING, evening: null, museRounds: false },
          setAt,
        );
      }

      t.logs.clear();
      const res = await changePassword(cookieA, { pushEndpoint: endpointA });
      expect(res.statusCode).toBe(302);

      expect(await endpointsOf(userId)).toEqual([endpointA]);
      expect(await deviceAt(endpointA)).toMatchObject({
        morningReminder: MORNING,
        remindersSetAt: setAt,
      });
      expect(await deviceAt(bystander)).toBeDefined();
      expect(t.logs.messages('info', 'Web')).toContain(
        `Password changed for user ${userId}: other sessions, 0 MCP tokens, 0 device tokens, 1 other push devices and 0 unanswered invites revoked`,
      );
      // Endpoints are capability URLs: never logged.
      const logged = JSON.stringify(t.logs.records);
      expect(logged).not.toContain(endpointA);
      expect(logged).not.toContain(endpointB);

      // Tomorrow's morning reminder reaches device A and nothing else.
      const tomorrow = addDays(t.today(), 1);
      const run = await sendDueReminders(
        {
          db: t.db,
          sender: t.push!,
          weather: undefined,
          timeZone: t.timeZone,
          logger: t.logger.child({ logger: 'Push' }),
          replan: {
            db: t.db,
            weather: undefined,
            push: t.push,
            timeZone: t.timeZone,
            logger: t.logger.child({ logger: 'WeekPlan' }),
          },
        },
        new Date(instantAt(tomorrow, 7, t.timeZone, 30).getTime() + 1_000),
      );
      expect(run).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
      expect(sentTo).toEqual([endpointA]);
    });

    it('revokes every device of the account when the form names none (a browser without push)', async () => {
      const { userId, cookieA } = await twoDevices('no-push');
      const res = await changePassword(cookieA, { pushEndpoint: '' });
      expect(res.statusCode).toBe(302);
      expect(await endpointsOf(userId)).toEqual([]);
    });

    it('revokes every device when a page cached before the field posts without it', async () => {
      const { userId, cookieA } = await twoDevices('old-form');
      const res = await changePassword(cookieA, {});
      expect(res.statusCode).toBe(302);
      expect(await endpointsOf(userId)).toEqual([]);
    });

    it("keeps nothing for another account's endpoint, and leaves that device alone", async () => {
      const { userId, cookieA } = await twoDevices('borrowed');
      const bystander = await subscribe(t.owner.cookie);
      const res = await changePassword(cookieA, { pushEndpoint: bystander });
      expect(res.statusCode).toBe(302);
      expect(await endpointsOf(userId)).toEqual([]);
      expect(await deviceAt(bystander)).toMatchObject({
        userId: t.owner.id,
      });
    });

    it('revokes nothing when the change is refused', async () => {
      const { userId, cookieA, endpointA, endpointB } =
        await twoDevices('refused');
      const res = await changePassword(cookieA, {
        currentPassword: 'WrongPassword1!',
        pushEndpoint: endpointA,
      });
      expect(res.statusCode).toBe(400);
      expect(await endpointsOf(userId)).toEqual([endpointA, endpointB]);
    });
  });

  // A subscribe and a new password take turns on the user's row lock
  // (#512, upsertDevice): whichever commits first, no subscription made by
  // a session the password ended survives it.
  describe('a subscribe racing a new password', () => {
    it('revokes a subscription that held the row lock while the password waited', async () => {
      const email = `race-held-${randomUUID()}@example.com`;
      await t.register(email);
      const userId = await userIdOf(t, email);
      const session = await sessionStampOf(t.db, userId);
      const [deviceId, change] = await interleave(
        t.db,
        (tx) => upsertDevice(tx, userId, session, subscription(), undefined),
        () => updatePasswordHash(t.db, userId, 'not-a-hash-race'),
      );
      expect(deviceId).toBeDefined();
      expect(change.revokedDevices).toBe(1);
      expect(await endpointsOf(userId)).toEqual([]);
    });

    it("refuses a subscribe that waited while the password committed: the ended session's 401, no row", async () => {
      const email = `race-waited-${randomUUID()}@example.com`;
      const cookie = await t.register(email);
      const userId = await userIdOf(t, email);
      t.logs.clear();
      // The session gate let the request in on the old hash; the new one
      // commits while the subscribe waits for the lock.
      const [, res] = await interleave(
        t.db,
        (tx) =>
          tx
            .update(user)
            .set({ password: 'not-a-hash-moved' })
            .where(eq(user.id, userId)),
        () =>
          t.inject({
            method: 'POST',
            url: '/push/subscribe',
            payload: subscription(),
            headers: { cookie },
          }),
      );
      expect(res.statusCode).toBe(401);
      expect(res.headers['hx-redirect']).toBe('/auth/login');
      expect(res.headers['clear-site-data']).toBe('"cache"');
      expect(await endpointsOf(userId)).toEqual([]);
      expect(t.logs.messages('info', 'Web')).toContain(
        `User ${userId}'s push subscription refused: the session ended under it`,
      );
    });
  });

  it('user:set-password revokes every device of that account, and only that account', async () => {
    const { email, userId } = await twoDevices('recovered');
    const bystander = await subscribe(t.owner.cookie);
    const output = new PassThrough();
    let stdout = '';
    output.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    const { logger, logs } = captureLogs();

    const status = await runSetPassword({
      args: [email],
      db: t.db,
      input: Readable.from([`${NEW_PASSWORD}\n`]),
      output,
      errors: new PassThrough(),
      logger,
    });

    expect(status).toBe(0);
    expect(await endpointsOf(userId)).toEqual([]);
    expect(await deviceAt(bystander)).toBeDefined();
    expect(logs.records.map((record) => record.msg)).toEqual([
      `Password set for user ${userId} via CLI: 0 MCP tokens, 0 device tokens, 2 push devices and 0 unanswered invites revoked`,
    ]);
    expect(stdout).toContain(
      'push subscriptions and unanswered invites are revoked',
    );
  });

  describe('push:revoke-all (after rotating ACCESS_TOKEN_SECRET)', () => {
    const run = async (args: string[]) => {
      const output = new PassThrough();
      const errors = new PassThrough();
      let stdout = '';
      let stderr = '';
      output.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      errors.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      const { logger, logs } = captureLogs();
      const status = await runRevokeAllPush({
        args,
        db: t.db,
        output,
        errors,
        logger,
      });
      return {
        status,
        stdout,
        stderr,
        logged: logs.records.map((record) => record.msg),
      };
    };

    it('refuses arguments and changes nothing', async () => {
      const { userId } = await twoDevices('usage');
      const result = await run(['--all']);
      expect(result.status).toBe(2);
      expect(result.stderr).toBe('Usage: npm run push:revoke-all\n');
      expect(await endpointsOf(userId)).toHaveLength(2);
    });

    it("removes every account's devices and logs the count per user, never an endpoint", async () => {
      const { userId } = await twoDevices('rotated');
      await subscribe(t.owner.cookie);
      const counts = new Map<number, number>();
      for (const row of await t.db
        .select({ userId: userDevice.userId })
        .from(userDevice)) {
        counts.set(row.userId, (counts.get(row.userId) ?? 0) + 1);
      }
      const total = [...counts.values()].reduce((a, b) => a + b, 0);

      const result = await run([]);

      expect(result.status).toBe(0);
      expect(await t.db.$count(userDevice)).toBe(0);
      expect(result.logged).toContain(
        `Push devices revoked for user ${userId}: 2`,
      );
      expect(result.logged).toContain(
        `Push devices revoked for user ${t.owner.id}: ${counts.get(t.owner.id)}`,
      );
      expect(result.logged.at(-1)).toBe(
        `Push subscriptions revoked via CLI: ${total} devices of ${counts.size} users`,
      );
      expect(result.logged.join('\n')).not.toContain('https://');
    });
  });

  it("deleting the account takes its devices with it (the foreign key's cascade)", async () => {
    const { email, userId, cookieA } = await twoDevices('leaving');
    const res = await t.inject({
      method: 'POST',
      url: '/auth/delete-account',
      payload: { email, password: TEST_PASSWORD },
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(302);
    expect(await endpointsOf(userId)).toEqual([]);
  });

  describe('the pages the browser acts on', () => {
    it('the login page shown signed out tells push.js to drop the subscription; shown signed in, it does not', async () => {
      const signedOut = await t.inject({
        method: 'GET',
        url: '/auth/login',
        anonymous: true,
      });
      expect(signedOut.statusCode).toBe(200);
      expect(signedOut.body).toContain('<push-signed-out hidden');

      const signedIn = await t.inject({ method: 'GET', url: '/auth/login' });
      expect(signedIn.statusCode).toBe(200);
      expect(signedIn.body).not.toContain('<push-signed-out');
    });

    it('the change-password form carries the field push.js fills with this device', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/auth/change-password',
      });
      expect(res.statusCode).toBe(200);
      expect(unescapeHtml(res.body)).toMatch(
        /<push-endpoint><input type="hidden" name="pushEndpoint" value=""\/><\/push-endpoint>/,
      );
    });
  });
});

describe('without PWA_ENABLED', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  it('neither page carries the push elements', async () => {
    const login = await t.inject({
      method: 'GET',
      url: '/auth/login',
      anonymous: true,
    });
    expect(login.body).not.toContain('<push-signed-out');
    const form = await t.inject({
      method: 'GET',
      url: '/auth/change-password',
    });
    expect(form.body).not.toContain('<push-endpoint');
  });
});
