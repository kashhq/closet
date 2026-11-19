import type { Writable } from 'node:stream';
import type { Db } from '../db/client';
import type { Logger } from '../logger';
import { revokeDevices, usersWithDevices } from '../web/push/queries';

/**
 * `npm run push:revoke-all`: removes every account's push subscriptions, the
 * step after rotating ACCESS_TOKEN_SECRET (AGENTS.md, Deployment). A
 * rotation signs everyone out, and a signed-out device receives nobody's
 * notifications; each device drops its own subscription the next time it
 * opens the app (the login page, <push-signed-out>), but one left closed
 * would keep getting its account's reminders, which name planned outfits on
 * the lock screen. Kept apart from the entry point (revoke-push.cli.ts) so
 * the integration tier can run it against a scratch database.
 *
 * Run it after the server restarted with the new secret: before that, a
 * session still open sends its subscription again on its next page
 * (syncSubscription, views/assets/page/push.ts). Everyone re-enables notifications
 * and their reminders on the profile afterwards.
 */

export interface RevokePushCommand {
  /** The arguments after the script name: none. */
  args: string[];
  db: Db;
  output: Writable;
  errors: Writable;
  logger: Logger;
}

/** The whole command; resolves to the process exit status. */
export async function runRevokeAllPush(
  command: RevokePushCommand,
): Promise<number> {
  const { args, db, output, errors, logger } = command;
  if (args.length > 0) {
    errors.write('Usage: npm run push:revoke-all\n');
    return 2;
  }
  const { devices, accounts } = await revokeAllPushDevices(db, logger);
  logger.info(
    `Push subscriptions revoked via CLI: ${devices} devices of ${accounts} users`,
  );
  output.write(
    `Removed ${devices} push subscriptions of ${accounts} accounts; each device turns notifications on again from its profile.\n`,
  );
  return 0;
}

/**
 * Every account's push subscriptions, in one transaction through the
 * statement a password change uses (revokeDevicesStatement). Also the
 * post-restore command's (after-restore.ts): a restore brings back
 * subscriptions a new password had ended.
 */
export async function revokeAllPushDevices(
  db: Db,
  logger: Logger,
): Promise<{ devices: number; accounts: number }> {
  const revoked = await db.transaction(async (tx) => {
    const perUser: { userId: number; devices: number }[] = [];
    for (const userId of await usersWithDevices(tx)) {
      perUser.push({ userId, devices: await revokeDevices(tx, userId) });
    }
    return perUser;
  });
  for (const { userId, devices } of revoked) {
    logger.info(`Push devices revoked for user ${userId}: ${devices}`);
  }
  return {
    devices: revoked.reduce((sum, { devices }) => sum + devices, 0),
    accounts: revoked.length,
  };
}
