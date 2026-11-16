import { addDays, type IsoDate } from '../calendar-date';
import type { Logger } from '../logger';
import { parseStoredName } from '../web/files/image-variant';
import type { PhotoStorage, TrashedSet } from '../web/files/storage';

/**
 * How long reconciliation's quarantine (#649) keeps a photo set before the
 * nightly run deletes it: long enough to notice, after a database restore,
 * that garments added since the dump have lost their photos.
 */
const TRASH_RETENTION_DAYS = 30;

/**
 * Deletes the day directories of `.trash` older than TRASH_RETENTION_DAYS
 * before `today`, and returns how many sets they held (a dry run deletes
 * nothing and counts the same). A day that cannot be deleted is a warning
 * and stays for the next run: the purge never stops reconciliation.
 */
export async function purgeTrash(
  storage: PhotoStorage,
  today: IsoDate,
  logger: Logger,
  dryRun: boolean,
): Promise<number> {
  const keepFrom = addDays(today, -TRASH_RETENTION_DAYS);
  let days: IsoDate[];
  let sets: TrashedSet[];
  try {
    days = (await storage.trashDays()).filter((day) => day < keepFrom);
    if (days.length === 0) return 0;
    sets = await storage.trash();
  } catch (error) {
    logger.warn({ err: error }, 'Trash purge skipped: .trash unreadable');
    return 0;
  }
  let purged = 0;
  for (const day of days) {
    const held = sets.filter((set) => set.day === day).length;
    try {
      if (!dryRun) await storage.removeTrashDay(day);
      logger.info(
        `${dryRun ? 'Would purge' : 'Purged'} quarantine of ${day}: ${held} photo sets`,
      );
      purged += held;
    } catch (error) {
      logger.warn({ err: error }, `Trash purge of ${day} failed; kept`);
    }
  }
  return purged;
}

export type RestoreOutcome = { restored: TrashedSet[] } | { refused: string };

/**
 * `maintenance:reconcile -- --restore-from-trash <name>`: moves a
 * quarantined set back into DATA_PATH, where list() (and reconciliation)
 * finds it. `name` is the set's base name (`<uuid>.webp`): every trash
 * entry holding its files is restored together, since a quarantine that
 * failed mid-set leaves one set in several entries. When two entries hold
 * the same file (a set quarantined twice), `name` must be `<day>/<entry>`.
 * Refused when nothing matches, or when storage already holds a live file
 * of that set: the trash never overwrites a photo. Whole or nothing
 * (PhotoStorage.restore): a failed link rolls back and rejects.
 *
 * Restores the bytes only, stamped `now` so the next nightly run leaves
 * them a day's grace; with no `file` row they are an orphan again after
 * it, quarantined unless the row is restored too.
 */
export async function restoreFromTrash(
  storage: PhotoStorage,
  name: string,
  logger: Logger,
  now: Date = new Date(),
): Promise<RestoreOutcome> {
  const trash = await storage.trash();
  const matches = name.includes('/')
    ? trash.filter((set) => `${set.day}/${set.entry}` === name)
    : trash.filter((set) => setBaseName(set) === name);
  if (matches.length === 0) {
    return { refused: `no quarantined photo set named ${name}` };
  }
  const files = matches.flatMap((set) => set.files);
  if (new Set(files).size < files.length) {
    const names = matches.map(entryName).join(', ');
    return {
      refused: `${name} was quarantined more than once; name one: ${names}`,
    };
  }
  const baseNames = new Set(matches.map(setBaseName));
  for await (const object of storage.list()) {
    const baseName = parseStoredName(object.name)?.baseName;
    if (baseName && baseNames.has(baseName)) {
      return {
        refused: `storage already holds a photo set named ${baseName}`,
      };
    }
  }
  try {
    await storage.restore(matches, now);
  } catch (error) {
    logger.warn(
      { err: error },
      `Restore of ${matches.map(entryName).join(', ')} failed; rolled back, the trash keeps it`,
    );
    throw error;
  }
  logger.info(
    `Restored ${matches.map(entryName).join(', ')} from the trash: ${files.join(', ')}`,
  );
  return { restored: matches };
}

function entryName(set: TrashedSet): string {
  return `${set.day}/${set.entry}`;
}

// The set's base name from its first photo file; the entry's name alone
// may carry a `~<hex>` suffix.
function setBaseName(set: TrashedSet): string | undefined {
  for (const file of set.files) {
    const parsed = parseStoredName(file);
    if (parsed) return parsed.baseName;
  }
  return undefined;
}
