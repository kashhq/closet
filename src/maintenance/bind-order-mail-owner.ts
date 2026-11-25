import type { Writable } from 'node:stream';
import type { Db } from '../db/client';
import type { Logger } from '../logger';
import { normalizeEmail } from '../web/auth/queries';
import { bindOrderMailOwner } from '../web/wardrobe/order-mail/queries';

/**
 * `npm run order-mail:bind-owner -- --confirm` (#976): the one way the
 * order mail's owner moves once stored. It binds the account ORDER_MAIL_OWNER
 * names now, whatever was bound (a deleted owner, a new one, an account the
 * boot's adoption refused for the history rule). The server reads the owner
 * once per boot, so it takes effect at the next restart. Kept apart from the
 * entry point (bind-order-mail-owner.cli.ts) so the integration tier can run
 * it against a scratch database.
 */

export interface BindOrderMailOwnerCommand {
  /** The arguments after the script name: `--confirm`. */
  args: string[];
  db: Db;
  /** ORDER_MAIL_OWNER, as configured. */
  ownerEmail: string;
  output: Writable;
  errors: Writable;
  logger: Logger;
}

const USAGE = 'Usage: npm run order-mail:bind-owner -- --confirm\n';

/** The whole command; resolves to the process exit status: 0 bound, 1 refused, 2 usage. */
export async function runBindOrderMailOwner(
  command: BindOrderMailOwnerCommand,
): Promise<number> {
  const { args, db, output, errors, logger } = command;
  if (args.length !== 1 || args[0] !== '--confirm') {
    errors.write(USAGE);
    return 2;
  }
  const ownerEmail = normalizeEmail(command.ownerEmail);
  if (!ownerEmail) {
    errors.write(
      'ORDER_MAIL_OWNER is unset: set it to the email of the account to bind\n',
    );
    return 1;
  }
  const { wasBound, previousId, boundId } = await bindOrderMailOwner(
    db,
    ownerEmail,
  );
  if (boundId === null) {
    errors.write(
      "No account uses ORDER_MAIL_OWNER's address; the binding is unchanged\n",
    );
    return 1;
  }
  const before = previousBinding(wasBound, previousId);
  logger.info(
    `Order mail owner bound to user ${boundId} via CLI (was ${before})`,
  );
  output.write(
    `The order mail's owner is user ${boundId} (was ${before}); restart the app for the order mail to use it.\n`,
  );
  return 0;
}

function previousBinding(wasBound: boolean, previousId: number | null): string {
  if (!wasBound) return 'unbound';
  return previousId === null ? 'a deleted account' : `user ${previousId}`;
}
