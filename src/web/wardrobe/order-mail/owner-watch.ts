import type { Logger } from '../../../logger';

/**
 * Whether ORDER_MAIL_OWNER's account is missing (#706): at boot (no account
 * has the address) or later (the account was deleted while the app ran).
 * Either way only the order mail stops: the app boots and serves, since a
 * user action (changing an email, deleting an account) must never turn the
 * next deploy into an outage. Reported by /health/ready's optional
 * `order_mail_owner` check; the poll skips itself once it is set.
 *
 * One error per boot: `markMissing` logs only the first time, so a timer
 * that polls every few minutes never floods the log. The address is never
 * logged, only the key.
 */
export class OrderMailOwnerWatch {
  #missing = false;

  constructor(private readonly logger: Logger) {}

  get missing(): boolean {
    return this.#missing;
  }

  markMissing(when: 'boot' | 'poll'): void {
    if (this.#missing) return;
    this.#missing = true;
    this.logger.error(
      `ORDER_MAIL_OWNER names no closet account${when === 'boot' ? '' : ' any more'}: the order mail is off until it names a live account's email and the app restarts (docs/operations.md#health)`,
    );
  }
}
