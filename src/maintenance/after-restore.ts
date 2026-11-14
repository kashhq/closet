import { and, asc, eq, isNotNull, lt, sql } from 'drizzle-orm';
import type { TokenKind } from '../credential-names';
import { recordCutoutEvent } from '../cutout/queries';
import { CUTOUT_TIMEOUT_MS } from '../cutout/runner';
import type { Db } from '../db/client';
import { file, garment } from '../db/schema';
import { bumpSyncEpoch } from '../db/sync-epoch';
import type { Logger } from '../logger';
import { revokeEveryonesTokens } from '../web/auth/personal-tokens';
import type { Photos } from '../web/files/photos';
import { reconcileStorage, type ReconciliationReport } from './reconcile';
import { revokeAllPushDevices } from './revoke-push';

/**
 * A lease older than this is held by no live job (#653): the runner kills
 * the model at CUTOUT_TIMEOUT_MS and the cutout's write takes seconds, so a
 * lease twice that old is a dead process's (one a restored dump brought
 * back). Short of CUTOUT_LEASE_MS, after which a claim takes the row over
 * anyway: releasing frees the photo now, and a running server's own live
 * job keeps its lease.
 */
export const DEAD_LEASE_MS = 2 * CUTOUT_TIMEOUT_MS;

export interface AfterRestoreDeps {
  db: Db;
  photos: Photos;
  logger: Logger;
  /** APP_TIMEZONE, for reconciliation's household days. */
  timeZone: string;
}

/** A garment whose photo's original reconciliation did not find. */
export interface MissingOriginalGarment {
  garmentId: number;
  name: string | null;
  ownerId: number;
  photo: string;
}

export interface AfterRestoreReport {
  /**
   * The database's new epoch: every device re-syncs in full, and every
   * session cookie issued before it is ended (restoreEpochSql).
   */
  syncEpoch: string;
  /** Personal access tokens revoked, by kind: re-issued by their owners. */
  accessTokensRevoked: Record<TokenKind, number>;
  pushDevicesRevoked: number;
  cutoutLeasesReleased: number;
  /** A dry run: what the next reconciliation would do. */
  reconciliation: ReconciliationReport;
  /** From the plan (reconciliation's missing originals), not the column. */
  missingOriginals: MissingOriginalGarment[];
}

/**
 * `npm run maintenance:after-restore` (#653): the one command an operator
 * runs after restoring the database from a dump, beside the running server
 * (`docker exec closet ...`). In order:
 *
 * 1. bumpSyncEpoch: every device's cursor answered before is a 410, so each
 *    re-syncs in full (the dump's revisions and ids would be read as the
 *    history it already has), and every session cookie issued before it no
 *    longer opens a session (its `sep`, #908): the household signs in again.
 * 2. Every personal access token, agent and device, revoked through the
 *    statement a new password uses (revokeTokensStatement), and every
 *    push subscription (#908): a restore brings back what was revoked after
 *    the dump (a lost phone's token), and nothing outside the database
 *    remembers it. Owners re-issue their tokens; each device turns
 *    notifications on again.
 * 3. Cutout leases older than DEAD_LEASE_MS released, each through the state
 *    machine (`release` naming the row's own worker, under the owner and
 *    row locks), so their photos run again at once.
 * 4. Reconciliation as a dry run: nothing deleted, quarantined, purged or
 *    marked (the next real run does that), and the garments whose original
 *    it did not find listed for the operator.
 *
 * Every step is safe to repeat: a second run bumps the epoch again (one
 * more full re-sync, everyone signed out again) and finds nothing to revoke
 * or release. The epoch and the revocations run even when reconciliation
 * refuses: the database was restored either way. Never migrates (runCli's schema check).
 */
export async function afterRestore(
  deps: AfterRestoreDeps,
): Promise<AfterRestoreReport> {
  const { db, logger } = deps;
  logger.info('After-restore started');
  const syncEpoch = await bumpSyncEpoch(db);
  logger.info(
    `Sync epoch bumped to ${syncEpoch}: every device re-syncs and every session is signed out`,
  );
  const accessTokensRevoked = await revokeAllAccessTokens(db, logger);
  const { devices } = await revokeAllPushDevices(db, logger);
  const cutoutLeasesReleased = await releaseDeadLeases(db, logger);
  const reconciliation = await reconcileStorage(deps, { dryRun: true });
  const missingOriginals = await garmentsShowing(
    db,
    reconciliation.missingOriginalPhotos,
  );
  for (const missing of missingOriginals) {
    logger.warn(
      `Garment ${missing.garmentId} of user ${missing.ownerId} has no original in storage (${missing.photo})`,
    );
  }
  logger.info(
    `After-restore done: every session ended, ${accessTokensRevoked.mcp} MCP tokens, ` +
      `${accessTokensRevoked.device} device tokens and ${devices} push devices revoked, ` +
      `${cutoutLeasesReleased} cutout leases released, ` +
      `${missingOriginals.length} garments missing their original` +
      (reconciliation.refused
        ? `; reconciliation refused: ${reconciliation.refused}`
        : ''),
  );
  return {
    syncEpoch,
    accessTokensRevoked,
    pushDevicesRevoked: devices,
    cutoutLeasesReleased,
    reconciliation,
    missingOriginals,
  };
}

// Every agent and device token (revokeEveryonesTokens), counted by kind.
async function revokeAllAccessTokens(
  db: Db,
  logger: Logger,
): Promise<Record<TokenKind, number>> {
  const total: Record<TokenKind, number> = { mcp: 0, device: 0 };
  for (const { userId, kinds } of await revokeEveryonesTokens(db)) {
    for (const kind of kinds) total[kind] += 1;
    logger.info(`Access tokens revoked for user ${userId}: ${kinds.length}`);
  }
  return total;
}

async function releaseDeadLeases(db: Db, logger: Logger): Promise<number> {
  const leased = await db
    .select({ fileName: file.fileName, worker: file.cutoutWorker })
    .from(file)
    .where(
      and(
        isNotNull(file.cutoutWorker),
        lt(
          file.cutoutStartedAt,
          sql`now() - ${`${DEAD_LEASE_MS} milliseconds`}::interval`,
        ),
      ),
    )
    .orderBy(asc(file.id));
  let released = 0;
  for (const { fileName, worker } of leased) {
    if (worker === null) continue;
    // Stale when the worker's lease was taken over since the read: left.
    const outcome = await recordCutoutEvent(db, fileName, {
      type: 'release',
      worker,
    });
    if (!outcome.ok) continue;
    logger.info(`Released the cutout lease of ${worker} on ${fileName}`);
    released += 1;
  }
  return released;
}

// The garments showing these photos (a selfie's or a look's has none).
function garmentsShowing(
  db: Db,
  photos: readonly string[],
): Promise<MissingOriginalGarment[]> {
  if (photos.length === 0) return Promise.resolve([]);
  return garmentsShowingStatement(db, photos);
}

/**
 * garmentsShowing's statement, built apart so a spec can read its parameter
 * count: the names are bound once, as one array parameter (#916), as
 * missingMarksStatement binds its ids. inArray binds one parameter per
 * name, which passes Postgres' 65535 after a restore that lost the
 * originals of tens of thousands of photos.
 */
export function garmentsShowingStatement(db: Db, photos: readonly string[]) {
  return db
    .select({
      garmentId: garment.id,
      name: garment.name,
      ownerId: garment.ownerId,
      photo: file.fileName,
    })
    .from(garment)
    .innerJoin(file, eq(file.id, garment.photoId))
    .where(sql`${file.fileName} = any(${sql.param([...photos])}::text[])`)
    .orderBy(asc(garment.ownerId), asc(garment.id));
}
