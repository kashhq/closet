import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../db/client';
import { verifyPassword } from './passwords';
import { findUserByEmail } from './queries';
import { checkSignIn } from './sign-in';

// The sign-in's cost and normalisation, for both doors (the login page and
// the API's device sign-in): the lookup and the comparison stand in, so
// the spec counts what checkSignIn asks of them.
vi.mock('./passwords', () => ({ verifyPassword: vi.fn() }));
vi.mock('./queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./queries')>()),
  findUserByEmail: vi.fn(),
}));

const db = {} as Db;
const account = {
  id: 7,
  email: 'ada@example.com',
  password: '$2b$hash',
  sessionEpoch: null,
  sessionVersion: 0,
};

beforeEach(() => {
  vi.mocked(findUserByEmail).mockReset();
  vi.mocked(verifyPassword).mockReset();
});

describe('checkSignIn', () => {
  it('looks the address up as the page login does: trimmed, lower case', async () => {
    vi.mocked(findUserByEmail).mockResolvedValue(account);
    vi.mocked(verifyPassword).mockResolvedValue(true);
    await checkSignIn(db, '  Ada@Example.COM ', 'pw');
    expect(findUserByEmail).toHaveBeenCalledWith(db, 'ada@example.com');
  });

  it('compares once against the unknown-account hash for an unknown email', async () => {
    vi.mocked(findUserByEmail).mockResolvedValue(undefined);
    vi.mocked(verifyPassword).mockResolvedValue(false);
    expect(await checkSignIn(db, 'nobody@example.com', 'pw')).toEqual({
      ok: false,
      userId: undefined,
    });
    // verifyPassword's undefined hash is the same-cost dummy comparison.
    expect(verifyPassword).toHaveBeenCalledTimes(1);
    expect(verifyPassword).toHaveBeenCalledWith('pw', undefined);
  });

  it('compares once for a wrong password, naming the account for the log only', async () => {
    vi.mocked(findUserByEmail).mockResolvedValue(account);
    vi.mocked(verifyPassword).mockResolvedValue(false);
    expect(await checkSignIn(db, account.email, 'wrong')).toEqual({
      ok: false,
      userId: 7,
    });
    expect(verifyPassword).toHaveBeenCalledTimes(1);
    expect(verifyPassword).toHaveBeenCalledWith('wrong', '$2b$hash');
  });

  it('compares once for the right one, handing back the hash it checked', async () => {
    vi.mocked(findUserByEmail).mockResolvedValue(account);
    vi.mocked(verifyPassword).mockResolvedValue(true);
    expect(await checkSignIn(db, account.email, 'pw')).toEqual({
      ok: true,
      account,
    });
    expect(verifyPassword).toHaveBeenCalledTimes(1);
  });
});
