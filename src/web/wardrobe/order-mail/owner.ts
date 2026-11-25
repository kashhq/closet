import type { Db } from '../../../db/client';
import type { Logger } from '../../../logger';
import type { OrderMailOwnerWatch } from './owner-watch';
import {
  adoptOrderMailOwner,
  type StoredOrderMailOwner,
  storedOrderMailOwner,
} from './queries';

/**
 * The order mail's owner at boot (createApp, #706, #976): the stored id
 * (order_mail_owner), never ORDER_MAIL_OWNER looked up again. Only with no
 * row is the address read, to adopt its account once (adoptOrderMailOwner).
 * Undefined, with the order mail off and `watch` set, when the stored
 * account was deleted, the address names no account, or its account fails
 * the adoption's history rule. `ownerEmail` is normalized.
 */
export async function resolveOrderMailOwner(
  db: Db,
  ownerEmail: string,
  watch: OrderMailOwnerWatch,
  logger: Logger,
): Promise<number | undefined> {
  const stored = await storedOrderMailOwner(db);
  if (stored) return storedOwner(stored, ownerEmail, watch, logger);
  const adoption = await adoptOrderMailOwner(db, ownerEmail);
  if (adoption.candidateId === null) {
    watch.markMissing('no-account');
    return undefined;
  }
  if (!adoption.eligible) {
    watch.markMissing('history');
    return undefined;
  }
  if (adoption.adopted) {
    logger.info(
      `Order mail owner bound to user ${adoption.candidateId}, adopted from ORDER_MAIL_OWNER`,
    );
    return adoption.candidateId;
  }
  // Eligible but another boot's statement bound first: whatever it bound.
  const winner = await storedOrderMailOwner(db);
  if (!winner) throw new Error('order_mail_owner lost its row mid-boot');
  return storedOwner(winner, ownerEmail, watch, logger);
}

function storedOwner(
  { userId, email }: StoredOrderMailOwner,
  ownerEmail: string,
  watch: OrderMailOwnerWatch,
  logger: Logger,
): number | undefined {
  if (userId === null) {
    watch.markMissing('deleted');
    return undefined;
  }
  // The address is never logged, only that the key no longer names the owner.
  if (email !== ownerEmail) {
    logger.warn(
      `ORDER_MAIL_OWNER is no longer the email of the order mail's owner, user ${userId}: the owner stays that account; \`npm run order-mail:bind-owner -- --confirm\` moves it to the account the key names (docs/operations.md#health)`,
    );
  }
  return userId;
}
