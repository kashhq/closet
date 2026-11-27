import { Readable } from 'node:stream';
import { and, asc, eq, getTableColumns, gt } from 'drizzle-orm';
import { showsCutout } from '../../cutout/state';
import type { Db } from '../../db/client';
import { file, garment, optionGroup } from '../../db/schema';
import type { Logger } from '../../logger';
import { imageUrl } from '../files/image-url';
import { photoWithCutoutJson } from '../files/queries';

/**
 * The wardrobe export (#200; docs/plans/2026-09-28-multi-add-and-export.md):
 * every garment of one owner, as CSV for spreadsheets or JSON with photo
 * URLs. A garment list, not a backup (#654): no outfits, calendar, wears,
 * washes, capsules, trips, sizes, style profile, selfies or saved looks, and
 * the photo URLs are signed links to this server, so they die with it.
 * Backups are the operator's database dump plus the photo share
 * (docs/operations.md). Owner-only (export-routes.ts). Streamed a page of
 * garments at a time, so a closet of any size holds one page in memory.
 */

export const EXPORT_FORMATS = ['csv', 'json'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Garments per statement. */
export const EXPORT_PAGE_SIZE = 200;

/**
 * The garment columns left out: whose it is (always the requester), the
 * internal photo row id (the photo is exported as its URLs), and a
 * The agent token's id (a credential's row the export does not hold; its
 * need's id is exported, the JSON bundle's `optionGroups` holds the needs,
 * and the CSV names each garment's need in OPTION_GROUP_COLUMN), and the
 * sync's bookkeeping (#196a: the owner's revision and a client's create id,
 * meaningless outside this database; updated_at is exported).
 */
export const OMITTED_COLUMNS: ReadonlySet<string> = new Set([
  'ownerId',
  'photoId',
  'addedByTokenId',
  'revision',
  'clientId',
]);

/**
 * The option_group columns the JSON bundle leaves out of each need (the agent,
 * #333): whose it is and its token.
 */
const OMITTED_GROUP_COLUMNS: ReadonlySet<string> = new Set([
  'ownerId',
  'suggestedByTokenId',
]);

type GroupRow = typeof optionGroup.$inferSelect;

/** Every other option_group column, under its database name, like EXPORT_COLUMNS. */
const EXPORT_GROUP_COLUMNS: readonly {
  key: keyof GroupRow;
  name: string;
}[] = Object.entries(getTableColumns(optionGroup))
  .filter(([key]) => !OMITTED_GROUP_COLUMNS.has(key))
  .map(([key, column]) => ({
    key: key as keyof GroupRow,
    name: column.name,
  }));

/** The CSV's column naming a suggestion's need, after the garment's own. */
const OPTION_GROUP_COLUMN = 'option_group';

type GarmentRow = typeof garment.$inferSelect;

/**
 * Every other garment column, in the table's order, under its database
 * name in both formats. Read from the schema, so a column added later is
 * exported without a second list; wardrobe-export.spec.ts compares the
 * two.
 */
const EXPORT_COLUMNS: readonly {
  key: keyof GarmentRow;
  name: string;
}[] = Object.entries(getTableColumns(garment))
  .filter(([key]) => !OMITTED_COLUMNS.has(key))
  .map(([key, column]) => ({
    key: key as keyof GarmentRow,
    name: column.name,
  }));

/** The photo's columns after the garment's, in the CSV. */
const PHOTO_COLUMNS = ['photo_url', 'cutout_url', 'thumb_url'] as const;

/** A garment's photo as absolute URLs; `cutout` only when it is shown. */
interface ExportedPhoto {
  original: string;
  cutout: string | null;
  thumb: string;
}

interface ExportRow {
  garment: GarmentRow;
  photo: ExportedPhoto | null;
  /** Its need's name, a suggestion's (the CSV's OPTION_GROUP_COLUMN); null for none. */
  need: string | null;
}

/**
 * `ownerId`'s garments, every status, oldest first, a keyset page per
 * statement with the photo joined.
 */
async function* exportPages(
  db: Db,
  ownerId: number,
  origin: string,
): AsyncGenerator<ExportRow[]> {
  let after = 0;
  for (;;) {
    const rows = await db
      .select({
        garment,
        photo: photoWithCutoutJson,
        need: optionGroup.name,
      })
      .from(garment)
      .leftJoin(file, eq(file.id, garment.photoId))
      .leftJoin(optionGroup, eq(optionGroup.id, garment.suggestionGroupId))
      .where(and(eq(garment.ownerId, ownerId), gt(garment.id, after)))
      .orderBy(asc(garment.id))
      .limit(EXPORT_PAGE_SIZE);
    yield rows.map((row) => ({
      garment: row.garment,
      need: row.need,
      photo: row.photo && {
        original: origin + imageUrl(row.photo, 'original'),
        cutout: showsCutout(row.photo.cutoutStatus)
          ? origin + imageUrl(row.photo, 'nobg')
          : null,
        thumb: origin + imageUrl(row.photo, 'thumb'),
      },
    }));
    const last = rows.at(-1);
    if (!last || rows.length < EXPORT_PAGE_SIZE) return;
    after = last.garment.id;
  }
}

/** Sets in a CSV cell: no set value holds a comma. */
const SET_SEPARATOR = ', ';

/**
 * A stored value as CSV text: null is empty (the form never stores ''), an
 * instant (a suggestion's times) ISO 8601 as the JSON bundle writes it.
 */
export function csvValue(value: GarmentRow[keyof GarmentRow]): string {
  if (value === null) return '';
  if (Array.isArray(value)) return value.join(SET_SEPARATOR);
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

// What a spreadsheet reads as a formula (or a cell that becomes one):
// OWASP's CSV injection list.
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell: a formula-looking text is prefixed with `'` (so a garment
 * named `=HYPERLINK(...)` stays text in every spreadsheet), then RFC 4180
 * quoting for commas, quotes and line breaks.
 */
export function csvCell(text: string): string {
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

const CRLF = '\r\n';

function csvLine(cells: readonly string[]): string {
  return cells.map(csvCell).join(',') + CRLF;
}

async function* csvChunks(pages: AsyncGenerator<ExportRow[]>) {
  // The BOM tells spreadsheet apps the file is UTF-8.
  yield '﻿' +
    csvLine([
      ...EXPORT_COLUMNS.map((column) => column.name),
      OPTION_GROUP_COLUMN,
      ...PHOTO_COLUMNS,
    ]);
  for await (const page of pages) {
    if (page.length === 0) continue;
    yield page
      .map(({ garment: row, photo, need }) =>
        csvLine([
          ...EXPORT_COLUMNS.map((column) => csvValue(row[column.key])),
          need ?? '',
          photo?.original ?? '',
          photo?.cutout ?? '',
          photo?.thumb ?? '',
        ]),
      )
      .join('');
  }
}

/** A garment as the JSON bundle holds it: the columns' own types, and its photo. */
function jsonGarment({ garment: row, photo }: ExportRow): object {
  return {
    ...Object.fromEntries(
      EXPORT_COLUMNS.map((column) => [column.name, row[column.key]]),
    ),
    photo,
  };
}

/**
 * `ownerId`'s the agent needs (#333), oldest first, as the JSON bundle holds
 * them: a handful, so one statement after the garments.
 */
async function exportGroups(db: Db, ownerId: number): Promise<object[]> {
  const rows = await db
    .select()
    .from(optionGroup)
    .where(eq(optionGroup.ownerId, ownerId))
    .orderBy(asc(optionGroup.id));
  return rows.map((row) =>
    Object.fromEntries(
      EXPORT_GROUP_COLUMNS.map((column) => [column.name, row[column.key]]),
    ),
  );
}

async function* jsonChunks(
  pages: AsyncGenerator<ExportRow[]>,
  groups: () => Promise<object[]>,
  exportedAt: Date,
) {
  yield `{"exportedAt":${JSON.stringify(exportedAt)},"garments":[`;
  let first = true;
  for await (const page of pages) {
    if (page.length === 0) continue;
    yield (first ? '' : ',') +
      page.map((row) => JSON.stringify(jsonGarment(row))).join(',');
    first = false;
  }
  yield `],"optionGroups":${JSON.stringify(await groups())}}\n`;
}

/**
 * `ownerId`'s wardrobe as a stream of `format`, photo URLs on `origin`.
 * Logs how many garments went out and how long it took, or the failure (the
 * headers are gone by then: the browser reports a failed download).
 */
export function wardrobeExport(
  db: Db,
  logger: Logger,
  {
    ownerId,
    format,
    origin,
  }: { ownerId: number; format: ExportFormat; origin: string },
): Readable {
  const started = performance.now();
  let garments = 0;
  async function* counted() {
    for await (const page of exportPages(db, ownerId, origin)) {
      garments += page.length;
      yield page;
    }
  }
  async function* logged() {
    try {
      yield* format === 'csv'
        ? csvChunks(counted())
        : jsonChunks(counted(), () => exportGroups(db, ownerId), new Date());
      logger.info(
        `Export (${format}) of wardrobe ${ownerId}: ${garments} garments in ${(performance.now() - started).toFixed(0)}ms`,
      );
    } catch (error) {
      logger.error(
        { err: error },
        `Export (${format}) of wardrobe ${ownerId} failed after ${garments} garments`,
      );
      throw error;
    }
  }
  return Readable.from(logged());
}
