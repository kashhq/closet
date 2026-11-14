import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import {
  enforceLimit,
  type RateLimitChecker,
  SIGN_IN_ACCOUNT_LIMIT,
  SIGN_IN_LIMIT,
} from '../security/rate-limit';
import { verifyPassword } from './passwords';
import { type AccountRow, findUserByEmail, normalizeEmail } from './queries';

/**
 * Who a sign-in's email and password open: the login page's and the API's
 * device sign-in's one check (src/web/auth/routes.tsx, api-routes.ts), so
 * both doors normalise the address alike and cost alike. Exactly one bcrypt
 * comparison whatever the outcome: a wrong password, and an unknown email
 * against the unknown-account hash of the same cost (verifyPassword), so
 * the answer's timing does not tell which addresses have accounts.
 * `userId` on a refusal is for the log line alone, never the answer.
 */
export type SignInCheck =
  | { ok: true; account: AccountRow }
  | { ok: false; userId?: number };

export async function checkSignIn(
  db: Db,
  email: string,
  password: string,
): Promise<SignInCheck> {
  const account = await findUserByEmail(db, normalizeEmail(email));
  if (!(await verifyPassword(password, account?.password)) || !account) {
    return { ok: false, userId: account?.id };
  }
  return { ok: true, account };
}

/** The log line's name for whose sign-in failed. */
export function failedSignInFor(check: { userId?: number }): string {
  return check.userId === undefined
    ? 'an unknown email'
    : `user ${check.userId}`;
}

/**
 * What the two sign-in doors are registered with: their two shared
 * checkers, built once in webPlugin by createSignInLimits (a checker per
 * door would be a budget each, #705): `address`, SIGN_IN_LIMIT per client
 * address, and `account`, SIGN_IN_ACCOUNT_LIMIT per account.
 */
export interface SignInLimits {
  signInLimits: { address: RateLimitChecker; account: RateLimitChecker };
}

/** `accountMax` is WebOptions.signInAccountMax, for the specs alone. */
export function createSignInLimits(
  app: FastifyInstance,
  accountMax = SIGN_IN_ACCOUNT_LIMIT.max,
): SignInLimits['signInLimits'] {
  return {
    address: app.createRateLimit(SIGN_IN_LIMIT),
    account: app.createRateLimit({
      ...SIGN_IN_ACCOUNT_LIMIT,
      max: accountMax,
      keyGenerator: accountKey,
    }),
  };
}

/**
 * SIGN_IN_ACCOUNT_LIMIT's key: a hash of the address as the lookup
 * normalises it (checkSignIn), so the counter never holds an email. Read
 * at preHandler, after the body's schema check; both doors' bodies name it
 * `email`.
 */
function accountKey(request: FastifyRequest): string {
  const { body } = request;
  const email =
    typeof body === 'object' &&
    body !== null &&
    'email' in body &&
    typeof body.email === 'string'
      ? body.email
      : '';
  return `account ${createHash('sha256').update(normalizeEmail(email)).digest('hex')}`;
}

/**
 * The hooks both sign-in doors spread into their route options, so the
 * two cannot count differently: the per-address budget at onRequest,
 * before the body is read, then the per-account budget at preHandler,
 * once the email is parsed and before checkSignIn's bcrypt comparison.
 * Every attempt counts, a right password included: a 429 is the same
 * answer whether the password was right, so the limit tells a guesser
 * nothing.
 */
export function signInGuards(
  { address, account }: SignInLimits['signInLimits'],
  logger: Logger,
) {
  return {
    onRequest: (request: FastifyRequest) =>
      enforceLimit(address, request, { logger, who: request.ip }),
    preHandler: (request: FastifyRequest) =>
      enforceLimit(account, request, { logger, who: 'an account' }),
  };
}
