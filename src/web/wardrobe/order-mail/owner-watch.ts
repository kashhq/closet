import type { Logger } from '../../../logger';

/**
 * Why the order mail has no owner (#706, #976): `no-account`, never bound
 * and ORDER_MAIL_OWNER names no account; `history`, never bound and that
 * account is not the one the order mail's history belongs to; `deleted`,
 * the bound account was deleted before this boot; `unbound`, the boot's
 * owner was deleted or rebound while the app ran.
 */
export type OrderMailOwnerMissing =
  | 'no-account'
  | 'history'
  | 'deleted'
  | 'unbound';

const BIND = '`npm run order-mail:bind-owner -- --confirm`';

const MESSAGES: Record<OrderMailOwnerMissing, string> = {
  'no-account':
    'ORDER_MAIL_OWNER names no closet account: the order mail is off until it names one and the app restarts',
  history: `ORDER_MAIL_OWNER's account owns none of the order mail's earlier items, so it was not adopted as their owner: the order mail is off until ${BIND} binds it and the app restarts`,
  deleted: `The order mail's owner account was deleted: the order mail is off until ${BIND} binds another and the app restarts`,
  unbound:
    "The order mail's owner was deleted or rebound since the boot: the order mail is off until the app restarts",
};

/**
 * Whether the order mail is off for want of an owner: at boot (above) or
 * later (the poll finds the binding moved). Either way only the order mail
 * stops: the app boots and serves, since a user action (deleting an
 * account) must never turn the next deploy into an outage. Reported by
 * /health/ready's optional `order_mail_owner` check and the
 * `order_mail_owner_missing` gauge; the poll skips itself once it is set.
 *
 * One error per boot: `markMissing` logs only the first time, so a timer
 * that polls every few minutes never floods the log. No address is logged.
 */
export class OrderMailOwnerWatch {
  #missing: OrderMailOwnerMissing | undefined;

  constructor(private readonly logger: Logger) {}

  get missing(): boolean {
    return this.#missing !== undefined;
  }

  markMissing(why: OrderMailOwnerMissing): void {
    if (this.#missing) return;
    this.#missing = why;
    this.logger.error(`${MESSAGES[why]} (docs/operations.md#health)`);
  }
}
