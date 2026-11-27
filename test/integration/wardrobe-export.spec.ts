import { randomUUID } from 'node:crypto';
import { and, eq, getTableColumns } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  file,
  garment,
  garmentRepair,
  optionGroup,
  wardrobeShare,
} from '../../src/db/schema';
import { AWAY_REASONS } from '../../src/wardrobe/availability';
import {
  CARE_BLEACH,
  CARE_DRY,
  CARE_DRY_CLEAN,
  CARE_IRON,
  CARE_WASH,
} from '../../src/wardrobe/care';
import {
  ALL_GARMENT_TYPES,
  CONDITIONS,
  FITS,
  LENGTHS,
  MATERIALS,
  PATTERNS,
  SLEEVES,
} from '../../src/wardrobe/properties';
import {
  EXPORT_PAGE_SIZE,
  OMITTED_COLUMNS,
} from '../../src/web/wardrobe/export';
import { imageUrl } from '../../src/web/files/image-url';
import { readPhotoRef } from '../../src/web/files/queries';
import { createGarment, jpegPhoto, uploadPhoto } from './garments';
import { createTestApp, type TestApp, userIdOf, asFixture } from './harness';

/**
 * The wardrobe export (#200; docs/plans/2026-09-28-multi-add-and-export.md):
 * every garment column but the owner and the photo row id, in CSV and
 * JSON, compared field by field with the row read back from the database.
 */

type GarmentRow = typeof garment.$inferSelect;

/** Every exported column: database name by row key. */
const COLUMNS = Object.entries(getTableColumns(garment))
  .filter(([key]) => !OMITTED_COLUMNS.has(key))
  .map(([key, column]) => ({
    key: key as keyof GarmentRow,
    name: column.name,
  }));

/** RFC 4180, as a spreadsheet reads it (CRLF rows, quoted cells). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && text[index + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      index += 1;
    } else {
      cell += char;
    }
  }
  expect(cell).toBe('');
  expect(row).toEqual([]);
  return rows;
}

/** A cell as the value it stands for: the formula guard's `'` removed. */
const unguard = (cell: string) =>
  /^'[=+\-@\t\r]/.test(cell) ? cell.slice(1) : cell;

/** A stored value as the CSV writes it: the spec's own statement of the format. */
function asCsvText(value: GarmentRow[keyof GarmentRow]): string {
  if (value === null) return '';
  if (Array.isArray(value)) return value.join(', ');
  // An instant as ISO 8601, never Date's local-time String().
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

describe('the wardrobe export', () => {
  let t: TestApp;
  let fullId: number;
  let needId: number;
  let plainId: number;
  let fullPhoto: {
    fileName: string;
    version: number;
    variantKey: string | null;
  };

  const rowsOf = (ownerId: number) =>
    t.db
      .select()
      .from(garment)
      .where(eq(garment.ownerId, ownerId))
      .orderBy(garment.id);

  const exportAs = (format: 'csv' | 'json', cookie?: string, query = '') =>
    t.inject({
      method: 'GET',
      url: `/wardrobe/export.${format}${query}`,
      headers: cookie ? { cookie } : {},
    });

  beforeAll(async () => {
    t = await createTestApp();
    plainId = await createGarment(t, { name: 'Plain tee' });
    fullId = await createGarment(t, { name: 'Full' });
    await uploadPhoto(t, fullId, await jpegPhoto(300, 400));
    // Its public link (#669): none until shared.
    const shared = await t.inject({
      method: 'POST',
      url: `/wardrobe/${fullId}/share`,
    });
    expect(shared.statusCode).toBe(200);
    // Its agent need (#333): a name a spreadsheet would run, defused too.
    [{ id: needId }] = await t.db
      .insert(optionGroup)
      .values({
        ownerId: t.owner.id,
        name: '=Rain jacket',
        budget: '150',
        note: 'For the wet months',
      })
      .returning({ id: optionGroup.id });
    // Every column set: the round trip below proves each one.
    await asFixture(t.db, (tx) =>
      tx
        .update(garment)
        .set({
          name: '=HYPERLINK("https://evil.example","click")',
          category: 'tops',
          brand: '@Brand, "quoted"',
          size: '-M',
          notes: 'Line one\nLine two, with a comma',
          colors: ['black', 'white'],
          acquiredOn: '2025-03-14',
          washingDetails: '+cold wash',
          status: 'closet',
          replacesGarmentId: plainId,
          type: ALL_GARMENT_TYPES[0],
          warmth: 3,
          formality: 2,
          materials: [MATERIALS[0], MATERIALS[1]],
          pattern: PATTERNS[1],
          fit: FITS[0],
          sleeve: SLEEVES[0],
          length: LENGTHS[0],
          fabricWeight: 203,
          waterResistant: true,
          sourceUrl: 'https://shop.example/tee?a=1&b=2',
          price: '24.90',
          quantity: 3,
          washAfterWears: 2,
          lastWashedOn: '2026-09-01',
          washedAt: new Date('2026-09-01T13:00:00.000Z'),
          away: AWAY_REASONS[0],
          awayNote: 'With Sam',
          condition: CONDITIONS[1],
          conditionNote: 'Frayed hem',
          careWash: CARE_WASH[0],
          careBleach: CARE_BLEACH[2],
          careDry: CARE_DRY[0],
          careIron: CARE_IRON[3],
          careDryClean: CARE_DRY_CLEAN[1],
          // A suggestion bought, then returned (#333).
          suggestedAt: new Date('2026-10-01T09:30:00.000Z'),
          suggestionGroupId: needId,
          suggestionNote: 'Goes with the raw jeans',
          suggestionRank: 2,
          dismissedAt: new Date('2026-10-04T18:00:00.000Z'),
          dismissedReason: 'returned',
          dismissedNote: 'Too short',
          boughtAt: new Date('2026-10-03T12:00:00.000Z'),
        })
        .where(eq(garment.id, fullId)),
    );
    const [photo] = await asFixture(t.db, (tx) =>
      tx
        .update(file)
        .set({ cutoutStatus: 'none' })
        .from(garment)
        .where(and(eq(garment.id, fullId), eq(file.id, garment.photoId)))
        .returning({
          fileName: file.fileName,
          version: file.version,
          variantKey: file.variantKey,
        }),
    );
    fullPhoto = photo!;
    // An owner-only record that is no garment field: never exported.
    await asFixture(t.db, (tx) =>
      tx.insert(garmentRepair).values({
        garmentId: fullId,
        day: '2026-08-01',
        kind: 'repair',
        note: 'Mended',
        cost: '77.77',
      }),
    );
  });

  afterAll(() => t?.cleanup());

  it('fills every column in its fixture', async () => {
    const [full] = (await rowsOf(t.owner.id)).filter(
      (row) => row.id === fullId,
    );
    for (const { key } of COLUMNS) expect(full?.[key], key).not.toBeNull();
  });

  it('round-trips every garment field through the JSON bundle', async () => {
    const res = await exportAs('json');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="closet-${t.today()}.json"`,
    );
    expect(res.headers['cache-control']).toBe('no-store');

    const bundle = JSON.parse(res.body) as {
      exportedAt: string;
      garments: Record<string, unknown>[];
      optionGroups: Record<string, unknown>[];
    };
    // The needs, without whose they are or their token.
    expect(bundle.optionGroups).toEqual([
      expect.objectContaining({
        id: needId,
        name: '=Rain jacket',
        budget: '150.00',
        note: 'For the wet months',
        status: 'open',
      }),
    ]);
    for (const omitted of ['owner_id', 'suggested_by_token_id']) {
      expect(bundle.optionGroups[0]).not.toHaveProperty(omitted);
    }
    expect(Number.isNaN(Date.parse(bundle.exportedAt))).toBe(false);
    const rows = await rowsOf(t.owner.id);
    expect(bundle.garments.map((row) => row.id)).toEqual(
      rows.map((row) => row.id),
    );
    for (const [index, row] of rows.entries()) {
      const exported = bundle.garments[index];
      expect(Object.keys(exported)).toEqual([
        ...COLUMNS.map((column) => column.name),
        'photo',
      ]);
      for (const { key, name } of COLUMNS) {
        // As JSON writes it: an instant is its ISO string.
        expect(exported[name], name).toEqual(
          JSON.parse(JSON.stringify(row[key])),
        );
      }
    }

    const full = bundle.garments.find((row) => row.id === fullId)!;
    const photo = full.photo as Record<string, string>;
    const path = (url: string) => {
      const parsed = new URL(url);
      return parsed.pathname + parsed.search;
    };
    // The URLs a page renders (signed: served without a statement, #162).
    expect(path(photo.original)).toBe(
      imageUrl(readPhotoRef(fullPhoto), 'original'),
    );
    expect(path(photo.cutout)).toBe(imageUrl(readPhotoRef(fullPhoto), 'nobg'));
    expect(path(photo.thumb)).toBe(imageUrl(readPhotoRef(fullPhoto), 'thumb'));
    expect(path(photo.thumb)).toMatch(
      new RegExp(
        `^/file/thumb/${fullPhoto.fileName}\\?v=${fullPhoto.version}&`,
      ),
    );
    expect(bundle.garments.find((row) => row.id === plainId)?.photo).toBeNull();
    expect(res.body).not.toContain('77.77');
  });

  it('round-trips every garment field through the CSV, formulas defused', async () => {
    const res = await exportAs('csv');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="closet-${t.today()}.csv"`,
    );
    expect(res.body.startsWith('﻿')).toBe(true);

    const [header, ...lines] = parseCsv(res.body.slice(1));
    expect(header).toEqual([
      ...COLUMNS.map((column) => column.name),
      'option_group',
      'photo_url',
      'cutout_url',
      'thumb_url',
    ]);
    const rows = await rowsOf(t.owner.id);
    expect(lines).toHaveLength(rows.length);
    for (const [index, row] of rows.entries()) {
      const cells = lines[index];
      for (const [position, { key, name }] of COLUMNS.entries()) {
        expect(unguard(cells[position]), name).toBe(asCsvText(row[key]));
      }
    }

    // No cell a spreadsheet would run: each formula start is quoted text.
    const full = lines[rows.findIndex((row) => row.id === fullId)];
    const cell = (name: string) => full[header.indexOf(name)];
    expect(cell('name')).toBe(`'=HYPERLINK("https://evil.example","click")`);
    expect(cell('brand')).toBe(`'@Brand, "quoted"`);
    expect(cell('size')).toBe(`'-M`);
    expect(cell('washing_details')).toBe(`'+cold wash`);
    expect(cell('option_group')).toBe(`'=Rain jacket`);
    for (const line of lines) {
      for (const value of line) expect(value).not.toMatch(/^[=+\-@\t\r]/);
    }
    expect(res.body).toContain(
      `"'=HYPERLINK(""https://evil.example"",""click"")"`,
    );
    expect(new URL(cell('photo_url')).pathname).toBe(
      `/file/${fullPhoto.fileName}`,
    );
    expect(new URL(cell('cutout_url')).pathname).toBe(
      `/file/nobg/${fullPhoto.fileName}`,
    );
    expect(res.body).not.toContain('77.77');
  });

  it(`streams past a page of ${EXPORT_PAGE_SIZE}, every garment once, every status`, async () => {
    const cookie = await t.register('big-closet@example.com');
    const ownerId = await userIdOf(t, 'big-closet@example.com');
    const count = EXPORT_PAGE_SIZE * 2 + 5;
    await asFixture(t.db, (tx) =>
      tx.insert(garment).values(
        Array.from({ length: count }, (_, index) => ({
          shareableId: randomUUID(),
          ownerId,
          category: 'tops',
          name: `Tee ${index}`,
          status:
            index % 10 === 0 ? ('wishlist' as const) : ('closet' as const),
        })),
      ),
    );
    const ids = (await rowsOf(ownerId)).map((row) => row.id);

    const json = JSON.parse((await exportAs('json', cookie)).body) as {
      garments: { id: number }[];
    };
    expect(json.garments.map((row) => row.id)).toEqual(ids);
    const csv = parseCsv((await exportAs('csv', cookie)).body.slice(1));
    expect(csv.slice(1).map((line) => Number(line[0]))).toEqual(ids);
    expect(t.logs.messages('info', 'Web')).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^Export \\(csv\\) of wardrobe ${ownerId}: ${count} garments in \\d+ms$`,
        ),
      ),
    );
  });

  it("exports only the requester's own wardrobe: a MANAGE grantee is refused the owner's", async () => {
    const cookie = await t.register('export-manager@example.com');
    await t.db.insert(wardrobeShare).values({
      grantorId: t.owner.id,
      granteeId: await userIdOf(t, 'export-manager@example.com'),
      permission: 'MANAGE',
      inviteToken: randomUUID(),
      createdAt: new Date(),
      acceptedAt: new Date(),
    });
    for (const format of ['csv', 'json'] as const) {
      const refused = await exportAs(format, cookie, `?ownerId=${t.owner.id}`);
      expect(refused.statusCode).toBe(403);
      expect(refused.body).not.toContain('Plain tee');
      const own = await exportAs(format, cookie);
      expect(own.statusCode).toBe(200);
      expect(own.body).not.toContain('Plain tee');
    }
  });
});
