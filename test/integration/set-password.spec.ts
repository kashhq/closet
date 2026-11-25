import { eq } from 'drizzle-orm';
import { PassThrough, Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { user } from '../../src/db/schema';
import { runSetPassword } from '../../src/maintenance/set-password';
import { captureLogs } from '../support/log-capture';
import { createTestApp, TEST_PASSWORD, TestApp } from './harness';

/**
 * `npm run user:set-password -- <email>`, the recovery path for a locked-out
 * account, run as the CLI runs it (runSetPassword) against the test app's
 * database with the password piped in, as `echo pw | npm run ...` would.
 */
describe('user:set-password', () => {
  let t: TestApp;
  const NEW_PASSWORD = 'Recovered789!';

  interface Run {
    status: number;
    stdout: string;
    stderr: string;
    logged: string[];
  }

  const run = async (args: string[], stdin: string): Promise<Run> => {
    const output = new PassThrough();
    const errors = new PassThrough();
    let stdout = '';
    let stderr = '';
    output.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    errors.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const { logger, logs } = captureLogs();
    const status = await runSetPassword({
      args,
      db: t.db,
      input: Readable.from([stdin]),
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

  const hashOf = async (email: string) =>
    (
      await t.db
        .select({ password: user.password })
        .from(user)
        .where(eq(user.email, email))
    )[0].password;

  const profileStatus = async (cookie: string) =>
    (
      await t.inject({
        method: 'GET',
        url: '/auth/profile',
        headers: { cookie },
      })
    ).statusCode;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  it('sets the password, signs out every session, and logs no secret', async () => {
    const email = 'locked-out@example.com';
    const oldSession = await t.register(email);
    expect(await profileStatus(oldSession)).toBe(200);

    // The address as typed by the operator, in any case.
    const result = await run(['Locked-Out@Example.com'], `${NEW_PASSWORD}\n`);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.logged).toEqual([
      expect.stringMatching(
        /^Password set for user \d+ via CLI: 0 MCP tokens, 0 device tokens, 0 push devices and 0 unanswered invites revoked$/,
      ),
    ]);
    expect(result.stdout + result.logged.join('')).not.toContain(NEW_PASSWORD);

    // The fingerprint moved: the old session is over, the new password works.
    expect(await profileStatus(oldSession)).toBe(302);
    await expect(t.login(email, TEST_PASSWORD)).rejects.toThrow();
    expect(await profileStatus(await t.login(email, NEW_PASSWORD))).toBe(200);
  });

  it('refuses a password that breaks the registration rules', async () => {
    const email = 'weak@example.com';
    await t.register(email);
    const before = await hashOf(email);

    const result = await run([email], 'short\n');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('8 characters or more');
    expect(await hashOf(email)).toBe(before);
  });

  it('exits non-zero for an unknown email', async () => {
    const result = await run(['nobody@example.com'], `${NEW_PASSWORD}\n`);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('No account uses nobody@example.com\n');
    expect(result.logged).toEqual([]);
  });

  it('prints its usage without exactly one email argument', async () => {
    expect((await run([], '')).status).toBe(2);
    expect((await run(['a@example.com', 'b'], '')).status).toBe(2);
  });
});
