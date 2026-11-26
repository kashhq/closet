import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { Db } from '../db/client';
import type { Logger } from '../logger';
import { passwordProblems, setPassword } from '../web/auth/passwords';
import {
  findUserByEmail,
  normalizeEmail,
  type SessionsEnded,
} from '../web/auth/queries';
import { t } from '../web/i18n';

/**
 * `npm run user:set-password -- <email>`: the recovery path for a locked-out
 * account, since there is no password reset by email. The logic lives here,
 * apart from the entry point (set-password.cli.ts), so the integration tier
 * can run it against a scratch database with a piped password.
 */

/** A refusal with its message for the operator; exit status 1. */
class SetPasswordRefused extends Error {}

export interface TerminalInput extends Readable {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

/**
 * Reads one line. On a terminal nothing is echoed (raw mode, Backspace
 * works, Ctrl-C cancels); from a pipe it is the first line of stdin.
 */
export async function readSecretLine(
  input: TerminalInput,
  output: Writable,
  prompt: string,
): Promise<string> {
  if (!input.isTTY || !input.setRawMode) {
    const decoder = new StringDecoder('utf8');
    let text = '';
    for await (const chunk of input as AsyncIterable<Buffer | string>) {
      text += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      if (text.includes('\n')) break;
    }
    return text.split(/\r?\n/)[0];
  }

  output.write(prompt);
  input.setRawMode(true);
  input.setEncoding('utf8');
  input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      input.off('data', onData);
      input.setRawMode!(false);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') {
          return finish();
        }
        if (char === '\u0003') {
          return finish(new SetPasswordRefused('Cancelled'));
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    input.on('data', onData);
  });
}

/**
 * Sets the password of the account behind `email` (compared as login does,
 * case-insensitively) after the registration rules, through the same path
 * as the change-password form, so every existing session of that account is
 * signed out. No device is making the change, so every push subscription of
 * the account goes too.
 */
async function setPasswordByEmail(
  db: Db,
  email: string,
  password: string,
): Promise<SessionsEnded> {
  const problems = passwordProblems(password);
  if (problems.length) {
    throw new SetPasswordRefused(problems.map((key) => t(key)).join('. '));
  }
  const account = await findUserByEmail(db, normalizeEmail(email));
  if (!account) throw new SetPasswordRefused(`No account uses ${email}`);
  return setPassword(db, account.id, password);
}

export interface SetPasswordCommand {
  /** The arguments after the script name: the email address. */
  args: string[];
  db: Db;
  input: TerminalInput;
  output: Writable;
  errors: Writable;
  logger: Logger;
}

/** The whole command; resolves to the process exit status. */
export async function runSetPassword(
  command: SetPasswordCommand,
): Promise<number> {
  const { args, db, input, output, errors, logger } = command;
  const email = args[0];
  if (!email || args.length > 1) {
    errors.write('Usage: npm run user:set-password -- <email>\n');
    return 2;
  }
  try {
    const password = await readSecretLine(input, output, 'New password: ');
    if (input.isTTY) {
      const again = await readSecretLine(input, output, 'Repeat it: ');
      if (again !== password) {
        throw new SetPasswordRefused(t('validation.PASSWORDS_MUST_MATCH'));
      }
    }
    const { account, revokedTokens, revokedDevices, revokedInvites } =
      await setPasswordByEmail(db, email, password);
    logger.info(
      `Password set for user ${account.id} via CLI: ${revokedTokens.mcp} MCP tokens, ${revokedTokens.device} device tokens, ${revokedDevices} push devices and ${revokedInvites} unanswered invites revoked`,
    );
    output.write(
      `Password set for user ${account.id}; every existing session of that account is signed out, and its access tokens, push subscriptions and unanswered invites are revoked.\n`,
    );
    return 0;
  } catch (error) {
    if (!(error instanceof SetPasswordRefused)) throw error;
    errors.write(`${error.message}\n`);
    return 1;
  }
}
