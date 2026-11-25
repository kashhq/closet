import { sql } from 'drizzle-orm';
import { readdir } from 'node:fs/promises';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import sharp from 'sharp';
import { variantFileName } from '../../src/web/files/image-variant';
import { MAX_INPUT_PIXELS } from '../../src/web/files/photos';
import {
  createGarment,
  garmentRow,
  jpegPhoto,
  photoFileName,
  photoRow,
  photoRowCount,
  uploadPhoto,
} from './garments';
import { createTestApp, multipart, TestApp } from './harness';

/**
 * Write correctness: a photo's bytes, its File row and the garment that
 * points at it either all exist or none of them do.
 */
describe('garment writes', () => {
  let t: TestApp;

  /** Everything under DATA_PATH except the app log. */
  const storedFiles = async () =>
    (await readdir(t.dataPath)).filter((name) => name.endsWith('.webp'));

  const photoUpload = async () =>
    multipart(
      {},
      {
        photo: {
          data: await jpegPhoto(),
          filename: 'photo.jpg',
          contentType: 'image/jpeg',
        },
      },
    );

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  afterEach(() => vi.restoreAllMocks());

  it('a rolled-back photo update leaves no File row and no files behind', async () => {
    const garmentId = await createGarment(t, { name: 'Blue shirt' });
    const filesBefore = await storedFiles();
    const rowsBefore = await photoRowCount(t);

    // The route's transaction does all its work (the File row inserted, the
    // garment pointed at it) and then fails at COMMIT: a deferred constraint
    // trigger on the garment runs only then.
    await t.db.execute(sql`
      create function fail_commit() returns trigger language plpgsql as $$
      begin raise exception 'simulated commit failure'; end $$`);
    await t.db.execute(sql`
      create constraint trigger fail_commit after update on garment
      deferrable initially deferred for each row execute function fail_commit()`);
    const body = await photoUpload();
    const res = await t
      .inject({
        method: 'POST',
        url: `/wardrobe/${garmentId}/photo`,
        payload: body.payload,
        headers: body.headers,
      })
      .finally(async () => {
        await t.db.execute(sql`drop trigger fail_commit on garment`);
        await t.db.execute(sql`drop function fail_commit()`);
      });
    expect(res.statusCode).toBe(500);

    expect(await photoRowCount(t)).toBe(rowsBefore);
    expect(await storedFiles()).toEqual(filesBefore);
    expect((await garmentRow(t, garmentId))?.photo).toBeNull();
  });

  it('replacing a photo removes the previous File row and its variants', async () => {
    const garmentId = await createGarment(t, { name: 'Red shirt' });
    await uploadPhoto(t, garmentId, await jpegPhoto());
    const first = await photoFileName(t, garmentId);

    await uploadPhoto(t, garmentId, await jpegPhoto(300, 300));
    const second = await photoFileName(t, garmentId);
    expect(second).not.toBe(first);

    expect(await photoRow(t, first)).toBeUndefined();
    expect(await photoRow(t, second)).toBeDefined();
    const files = await storedFiles();
    expect(files).not.toContain(first);
    expect(files).not.toContain(variantFileName(first, 'thumb'));
    expect(files).toContain(second);
    expect(files).toContain(variantFileName(second, 'thumb'));
  });

  it('deleting a garment removes its File row and every variant file', async () => {
    const garmentId = await createGarment(t, { name: 'Green shirt' });
    await uploadPhoto(t, garmentId, await jpegPhoto());
    const fileName = await photoFileName(t, garmentId);
    expect(await storedFiles()).toEqual(
      expect.arrayContaining([fileName, variantFileName(fileName, 'thumb')]),
    );

    const res = await t.inject({
      method: 'DELETE',
      url: `/wardrobe/${garmentId}`,
    });
    expect(res.statusCode).toBe(200);

    expect(await garmentRow(t, garmentId)).toBeUndefined();
    expect(await photoRow(t, fileName)).toBeUndefined();
    const files = await storedFiles();
    expect(files).not.toContain(fileName);
    expect(files).not.toContain(variantFileName(fileName, 'thumb'));
    expect(files).not.toContain(variantFileName(fileName, 'nobg'));
  });

  it('a corrupted upload is a 400 and leaves no partial file on disk', async () => {
    const garmentId = await createGarment(t, { name: 'Corrupt' });
    const filesBefore = await storedFiles();
    const rowsBefore = await photoRowCount(t);

    const body = await multipart(
      {},
      {
        photo: {
          data: Buffer.from('definitely not a jpeg'),
          filename: 'photo.jpg',
          contentType: 'image/jpeg',
        },
      },
    );
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/${garmentId}/photo`,
      payload: body.payload,
      headers: body.headers,
    });
    expect(res.statusCode).toBe(400);

    expect(await storedFiles()).toEqual(filesBefore);
    expect(await photoRowCount(t)).toBe(rowsBefore);
  });

  // A decompression bomb: a few KB of PNG that decodes to 81 MP. sharp's
  // limitInputPixels (MAX_INPUT_PIXELS) refuses it from the header.
  it('an image over the pixel limit is a 400, stores nothing, and the app keeps serving', async () => {
    const garmentId = await createGarment(t, { name: 'Bomb' });
    const filesBefore = await storedFiles();
    const rowsBefore = await photoRowCount(t);
    const side = Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 1000;
    const bomb = await sharp({
      create: { width: side, height: side, channels: 3, background: '#000' },
      limitInputPixels: false,
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(bomb.length).toBeLessThan(1024 * 1024);

    const body = await multipart(
      {},
      { photo: { data: bomb, filename: 'bomb.png', contentType: 'image/png' } },
    );
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/${garmentId}/photo`,
      payload: body.payload,
      headers: body.headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Image too large');

    expect(await storedFiles()).toEqual(filesBefore);
    expect(await photoRowCount(t)).toBe(rowsBefore);
    const next = await t.inject({
      method: 'GET',
      url: `/wardrobe/${garmentId}`,
    });
    expect(next.statusCode).toBe(200);
  }, 30_000);

  it('cloning a garment with a photo commits the copied File row with the clone', async () => {
    const sourceId = await createGarment(t, { name: 'Source' });
    await uploadPhoto(t, sourceId, await jpegPhoto());

    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/${sourceId}/clone`,
      payload: { name: 'Copy', category: 'shirt' },
    });
    expect(res.statusCode).toBe(302);
    const cloneId = Number(
      /^\/wardrobe\/(\d+)$/.exec(res.headers.location as string)![1],
    );

    const clone = (await garmentRow(t, cloneId))!;
    expect(await storedFiles()).toContain(clone.photo!.fileName);
  });
});
