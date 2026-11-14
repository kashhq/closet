import * as bcrypt from 'bcryptjs';
import { PASSWORD_HASH_ROUNDS_PRODUCTION } from '../../config';
import type { Db } from '../../db/client';
import { markSecretChecked } from '../../metrics/request-timing';
import type { StringKey } from '../i18n';
import {
  type SessionsEnded,
  type PasswordChangeKeeps,
  updatePasswordHash,
} from './queries';

/**
 * Compared against when the account does not exist, so an unknown email
 * costs the same bcrypt work as a wrong password and response times do not
 * tell which addresses have accounts. A hash of a random string that was
 * thrown away; its value is irrelevant, since no account matches it
 * (verifyPassword answers false whatever the comparison says). A constant,
 * not a hash made on first use: that made the first unknown email after
 * each boot cost a hash and a comparison, twice a real account's time
 * (#136).
 */
const UNKNOWN_ACCOUNT_HASH_PRODUCTION =
  '$2b$12$2XMqcJVfAECVq8kMYvFPKOWE4G13BXHCFM.4YGO5pHDP8rUtNwe8S';

let rounds = PASSWORD_HASH_ROUNDS_PRODUCTION;
let unknownAccountHash = UNKNOWN_ACCOUNT_HASH_PRODUCTION;

/**
 * Sets bcrypt's cost for this process (Config.PASSWORD_HASH_ROUNDS): the
 * server at boot (createApp), the CLIs through runCli. Without a call the
 * production cost applies. Any other cost makes its unknown-account hash
 * here, once, so the comparison an unknown email pays stays the same as a
 * real account's at that cost.
 */
export function configurePasswordHashing(cost: number): void {
  rounds = cost;
  unknownAccountHash =
    cost === PASSWORD_HASH_ROUNDS_PRODUCTION
      ? UNKNOWN_ACCOUNT_HASH_PRODUCTION
      : bcrypt.hashSync('unknown-account', cost);
}

/** The cost every hash is made at, and the unknown-account hash of that cost. */
export function passwordHashing(): {
  rounds: number;
  unknownAccountHash: string;
} {
  return { rounds, unknownAccountHash };
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, rounds);
}

/** Whether `password` is the one behind `hash`; false, at the same cost, when there is no account. */
export async function verifyPassword(
  password: string,
  hash: string | undefined,
): Promise<boolean> {
  markSecretChecked();
  if (hash === undefined) {
    await bcrypt.compare(password, unknownAccountHash);
    return false;
  }
  return bcrypt.compare(password, hash);
}

/**
 * The rules every new password meets wherever it is set: registration, the
 * change-password form and `npm run user:set-password`. Each problem is the
 * t() key of the message shown under the field.
 */
export function passwordProblems(password: string): StringKey[] {
  const problems: StringKey[] = [];
  if (password.length < 8) problems.push('validation.MIN_PASSWORD_LENGTH');
  if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(password)) {
    problems.push('validation.PASSWORD_MUST_CONTAIN');
  }
  return problems;
}

/**
 * Replaces a user's password: the change-password route and `npm run
 * user:set-password` both come through here. The new hash changes the
 * fingerprint every session token carries (tokens.ts), so every session
 * issued before is rejected from the next request on, and every personal
 * access token and push subscription is revoked with it
 * (updatePasswordHash). `keep`: what of the device making the change stays
 * signed in (the route names its push subscription); the CLI has no
 * device, so everything goes. Returns the updated row, for a caller that
 * issues this device a fresh token, and what was revoked, for its log line.
 */
export async function setPassword(
  db: Db,
  userId: number,
  password: string,
  keep?: PasswordChangeKeeps,
): Promise<SessionsEnded> {
  return updatePasswordHash(db, userId, await hashPassword(password), keep);
}
