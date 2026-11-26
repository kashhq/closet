import type { RegistrationMode } from '../../config';
import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import {
  type AccountRow,
  anyAccountExists,
  insertFirstUser,
  insertUser,
} from './queries';

/** What a registration's insert came to; the route answers each. */
export type RegistrationOutcome =
  | { ok: true; account: AccountRow }
  | { ok: false; refused: 'closed' | 'email-taken' };

/**
 * REGISTRATION's one reading (#670), built once by createApp(): whether
 * sign-up is open (the registration routes' hook, the login and invite
 * pages' register link) and the insert that decides it for good.
 */
export interface RegistrationGate {
  readonly mode: RegistrationMode;
  open(): Promise<boolean>;
  register(email: string, passwordHash: string): Promise<RegistrationOutcome>;
}

/**
 * Async because first-user reads the account table once here, at boot: a
 * restart with an account already stored starts latched, so deleting the
 * last account in a session that never visited a registration page cannot
 * reopen sign-up.
 */
export async function createRegistrationGate(deps: {
  db: Db;
  mode: RegistrationMode;
  logger: Logger;
}): Promise<RegistrationGate> {
  const { db, mode, logger } = deps;
  // first-user's latch: once this process has seen an account (at boot or
  // later), sign-up stays closed without asking the database again. While it
  // is unset the table was empty at the last look, so open() keeps asking.
  // It assumes one instance (a second server latches on its own boot look)
  // and never re-opens: a last account deleted leaves sign-up closed until a
  // restart, the safe way.
  let accountSeen = false;
  const latch = () => {
    if (accountSeen) return;
    accountSeen = true;
    logger.info('Registration closed: the first account exists (first-user)');
  };

  if (mode === 'first-user' && (await anyAccountExists(db))) latch();

  return {
    mode,
    async open() {
      if (mode !== 'first-user') return mode === 'open';
      if (accountSeen) return false;
      if (await anyAccountExists(db)) latch();
      return !accountSeen;
    },
    async register(email, passwordHash) {
      if (mode === 'closed') return { ok: false, refused: 'closed' };
      if (mode === 'open') {
        const account = await insertUser(db, email, passwordHash);
        return account
          ? { ok: true, account }
          : { ok: false, refused: 'email-taken' };
      }
      const account = await insertFirstUser(db, email, passwordHash);
      latch();
      if (account) return { ok: true, account };
      logger.info('Registration refused: an account exists (first-user)');
      return { ok: false, refused: 'closed' };
    },
  };
}
