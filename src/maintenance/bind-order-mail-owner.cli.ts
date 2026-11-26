import { runBindOrderMailOwner } from './bind-order-mail-owner';
import { runCli } from './cli';

/**
 * `npm run order-mail:bind-owner -- --confirm`: binds the order mail to the
 * account ORDER_MAIL_OWNER names (in production: `docker exec closet npm run
 * order-mail:bind-owner -- --confirm`, then restart the container). Exit
 * status 0 bound, 1 refused, 2 usage. Reads dist/, so `npm run build` first
 * when developing.
 */
runCli('BindOrderMailOwner', ({ config, db, logger }) =>
  runBindOrderMailOwner({
    args: process.argv.slice(2),
    db,
    ownerEmail: config.ORDER_MAIL_OWNER,
    output: process.stdout,
    errors: process.stderr,
    logger,
  }),
);
