import type { MultipartFile } from '@fastify/multipart';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyCutoutEvent,
  type CutoutRow,
  lockCutoutRow,
} from '../../cutout/queries';
import { transition } from '../../cutout/state';
import type { Db } from '../../db/client';
import { HttpError } from '../errors';
import {
  HeicDecodeError,
  type HeicDecoding,
  type HeicPixels,
} from './heic-decoder';
import { captureLogs } from '../../../test/support/log-capture';
import { unkeyedPhoto, variantFileName } from './image-variant';
import { MAX_INPUT_PIXELS, Photos } from './photos';
import { findPhotoByShareableId, findVariantKey } from './queries';
import { PhotoStorage } from './storage';

// The HEIC decoder's thread is heic-decoder.spec.ts's: here a fake reads
// the part as the real one does and answers what `heicAnswer` says, so the
// decode branch is about what goes in and what comes out, not the codec.
const heicAnswer =
  vi.fn<(container: Buffer, maxPixels: number) => Promise<HeicPixels>>();
const heic: HeicDecoding = {
  decode: async (read, maxPixels) => heicAnswer(await read(), maxPixels),
  close: () => Promise.resolve(),
};
const heicPixels = (width: number, height: number) =>
  Promise.resolve({
    width,
    height,
    pixels: Buffer.alloc(width * height * 4, 200),
  });

// The row queries Photos makes; the integration tier runs them for real.
vi.mock('./queries', () => ({
  findPhotoByShareableId: vi.fn(),
  findVariantKey: vi.fn(),
  readPhotoRef: (photo: unknown) => photo,
}));
vi.mock('../../cutout/queries', () => ({
  lockCutoutRow: vi.fn(),
  applyCutoutEvent: vi.fn(),
}));
const findByShareMock = vi.mocked(findPhotoByShareableId);
const findKeyMock = vi.mocked(findVariantKey);
const lockMock = vi.mocked(lockCutoutRow);
const applyMock = vi.mocked(applyCutoutEvent);

// A transaction is the same fake: the cutout queries above are mocked.
// `transactionFails` makes the next one throw after its work, as a COMMIT
// that fails (or whose answer is lost) does.
const tx = {};
let transactionFails: Error | undefined;
const db = {
  transaction: async (work: (tx: object) => Promise<unknown>) => {
    const result = await work(tx);
    if (transactionFails) throw transactionFails;
    return result;
  },
} as unknown as Db;

const A = unkeyedPhoto('a.webp');

const cutoutRow = (overrides: Partial<CutoutRow> = {}): CutoutRow => ({
  id: 1,
  fileName: 'a.webp',
  status: 'ready',
  version: 1,
  attempts: 1,
  jobVersion: null,
  worker: null,
  variantKey: null,
  lockedOwner: null,
  ...overrides,
});

/** applyCutoutEvent as the real one decides, minus the row write. */
const applyAsTheMachine = () =>
  applyMock.mockImplementation((_tx, row, event) =>
    Promise.resolve(transition(row, event)),
  );

/** The variant key the event applyCutoutEvent was last given carries. */
const writtenKey = (): string => {
  const event = applyMock.mock.lastCall?.[2];
  if (event?.type !== 'edit' && event?.type !== 'succeed') {
    throw new Error('No cutout event was applied');
  }
  // Photos always stores a cutout under a fresh key (newVariantKey).
  if (event.variantKey === null) throw new Error('An unkeyed cutout event');
  return event.variantKey;
};

const MAX_HEIC_BYTES = 1024;

const png = (size: number) =>
  sharp({
    create: { width: size, height: size, channels: 4, background: '#fff' },
  })
    .png()
    .toBuffer();

/**
 * A transparent `size` square cutout: an opaque `block` where given, and a
 * `haze` alpha everywhere else (the soft background a model leaves).
 */
const cutout = (
  size: number,
  {
    block,
    haze = 0,
  }: {
    block?: { left: number; top: number; width: number; height: number };
    haze?: number;
  } = {},
) =>
  sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 90, g: 90, b: 90, alpha: haze / 255 },
    },
  })
    .composite(
      block
        ? [
            {
              input: {
                create: {
                  width: block.width,
                  height: block.height,
                  channels: 4,
                  background: { r: 20, g: 40, b: 90, alpha: 1 },
                },
              },
              left: block.left,
              top: block.top,
            },
          ]
        : [],
    )
    .png()
    .toBuffer();

/** A cutout an opaque original's thumb cannot be mistaken for: a band across its top. */
const strip = () =>
  cutout(300, { block: { left: 0, top: 0, width: 300, height: 100 } });

/** The size of a WebP and the box of its pixels at least half opaque. */
const opaqueBox = async (image: Buffer) => {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] >= 128) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  return {
    width: info.width,
    height: info.height,
    box: {
      left: Math.min(...xs),
      top: Math.min(...ys),
      right: Math.max(...xs) + 1,
      bottom: Math.max(...ys) + 1,
    },
  };
};

const collect = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const { logger, logs: logCapture } = captureLogs();
/** Every message logged since the spec file started. */
const logs = () => logCapture.records.map((record) => record.msg);

// Photos over real disk storage in a temp directory, so the variant logic
// (thumb derivation, fallbacks, atomic writes) runs end to end; `stores`
// records every name written.
let dataPath: string;
let stores: string[];

const build = ({ watermarkEnabled = false } = {}) => {
  const storage = new PhotoStorage(dataPath, logger);
  storage.prepare();
  const store = storage.store.bind(storage);
  vi.spyOn(storage, 'store').mockImplementation((name, stream) => {
    stores.push(name);
    return store(name, stream);
  });
  const photos = new Photos(
    storage,
    db,
    logger,
    {
      maxHeicBytes: MAX_HEIC_BYTES,
      watermarkIconPath: join(dataPath, 'icon.png'),
      watermarkEnabled,
    },
    heic,
  );
  return photos;
};

const put = (name: string, bytes: Buffer) =>
  writeFile(join(dataPath, name), bytes);
const stored = (name: string) => readFile(join(dataPath, name));
const has = (name: string) => existsSync(join(dataPath, name));
/** Every photo file in storage, whatever its name. */
const photoFiles = () =>
  readdirSync(dataPath).filter((name) => name.endsWith('.webp'));

beforeEach(async () => {
  dataPath = await mkdtemp(join(tmpdir(), 'closet-photos-'));
  stores = [];
  transactionFails = undefined;
  findByShareMock.mockReset();
  findKeyMock.mockReset();
  lockMock.mockReset();
  applyMock.mockReset();
});

afterEach(async () => {
  await rm(dataPath, { recursive: true, force: true });
});

describe('Photos.getVariant', () => {
  it('serves the original as-is', async () => {
    const photos = build();
    await put('a.webp', await png(8));
    const out = await collect(await photos.getVariant(A, 'original'));
    expect(out.equals(await stored('a.webp'))).toBe(true);
  });

  it('falls back to the original when the cutout is missing', async () => {
    const photos = build();
    await put('a.webp', await png(8));
    const out = await collect(await photos.getVariant(A, 'nobg'));
    expect(out.equals(await stored('a.webp'))).toBe(true);
  });

  it('prefers the cutout when present', async () => {
    const photos = build();
    await put('a.webp', await png(8));
    await put('a-nobg.webp', await png(9));
    const out = await collect(await photos.getVariant(A, 'nobg'));
    expect(out.equals(await stored('a-nobg.webp'))).toBe(true);
  });

  it('generates a <=400px webp thumb on first request and reuses it after', async () => {
    const photos = build();
    await put('a.webp', await png(1000));

    const first = await collect(await photos.getVariant(A, 'thumb'));
    const meta = await sharp(first).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBeLessThanOrEqual(400);
    expect(meta.height).toBeLessThanOrEqual(400);
    expect(stores).toEqual(['a-thumb.webp']);

    await collect(await photos.getVariant(A, 'thumb'));
    expect(stores).toEqual(['a-thumb.webp']);
  });

  it('single-flights concurrent first requests for the same thumb', async () => {
    const photos = build();
    await put('a.webp', await png(1000));
    const streams = await Promise.all([
      photos.getVariant(A, 'thumb'),
      photos.getVariant(A, 'thumb'),
      photos.getVariant(A, 'thumb'),
    ]);
    await Promise.all(streams.map(collect));
    expect(stores).toEqual(['a-thumb.webp']);
  });

  it('derives the thumb from the cutout when one exists', async () => {
    const photos = build();
    await put('a.webp', await png(1000));
    await put('a-nobg.webp', await strip());
    const out = await collect(await photos.getVariant(A, 'thumb'));
    // The cutout's transparency, which the opaque original has none of.
    expect((await opaqueBox(out)).box.top).toBeGreaterThan(0);
  });

  it('is a 404 when the original is missing', async () => {
    const photos = build();
    await expect(photos.getVariant(A, 'thumb')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('Photos.saveEditedCutout', () => {
  it('stores the cutout and its thumb under a new key before the row points at them', async () => {
    const photos = build();
    await put('a.webp', await png(1000));
    lockMock.mockResolvedValue(cutoutRow({ status: 'none', version: 1 }));
    applyMock.mockImplementation((_tx, row, event) => {
      // No storage I/O inside the transaction: both files are already there.
      expect(event).toMatchObject({ type: 'edit' });
      const key = (event as { variantKey: string }).variantKey;
      expect(stores).toEqual([
        variantFileName('a.webp', 'nobg', key),
        variantFileName('a.webp', 'thumb', key),
      ]);
      return Promise.resolve(transition(row, event));
    });

    await expect(
      photos.saveEditedCutout(Readable.from(await strip()), 'a.webp'),
    ).resolves.toMatchObject({
      fileName: 'a.webp',
      version: 2,
      cutoutStatus: 'edited',
    });
    const key = writtenKey();
    expect(key).toMatch(/^[0-9a-f]{12}$/);
    // From the cutout: transparent above the strip, as the original is not.
    const thumb = await opaqueBox(
      await stored(variantFileName('a.webp', 'thumb', key)),
    );
    expect(thumb.box.top).toBeGreaterThan(0);
    expect(stores).toHaveLength(2);
  });

  it('deletes the set the new cutout replaced, after the swap', async () => {
    const photos = build();
    const old = { fileName: 'a.webp', variantKey: '0123456789ab' };
    await put('a.webp', await png(1000));
    await put(
      variantFileName('a.webp', 'nobg', old.variantKey),
      await png(600),
    );
    await put(
      variantFileName('a.webp', 'thumb', old.variantKey),
      await png(400),
    );
    // A thumb backfilled for a request that raced an earlier swap.
    await put('a-thumb.webp', await png(400));
    lockMock.mockResolvedValue(
      cutoutRow({ status: 'ready', variantKey: old.variantKey }),
    );
    applyAsTheMachine();

    await expect(
      photos.saveEditedCutout(Readable.from(await png(300)), 'a.webp'),
    ).resolves.toMatchObject({ fileName: 'a.webp', version: 2 });
    const key = writtenKey();
    expect(photoFiles().sort()).toEqual(
      [
        'a.webp',
        'a-thumb.webp',
        variantFileName('a.webp', 'nobg', key),
        variantFileName('a.webp', 'thumb', key),
      ].sort(),
    );
  });

  it('deletes its files when the row is gone', async () => {
    const photos = build();
    lockMock.mockResolvedValue(undefined);
    await expect(
      photos.saveEditedCutout(Readable.from(await png(300)), 'a.webp'),
    ).resolves.toBeUndefined();
    expect(applyMock).not.toHaveBeenCalled();
    expect(stores).toHaveLength(2);
    expect(photoFiles()).toEqual([]);
  });

  it('deletes its files when the machine refuses the event', async () => {
    const photos = build();
    await put('a.webp', await png(1000));
    await put('a-nobg.webp', await png(600));
    lockMock.mockResolvedValue(cutoutRow({ status: 'unwanted' }));
    applyAsTheMachine();
    await expect(
      photos.saveEditedCutout(Readable.from(await png(300)), 'a.webp'),
    ).resolves.toBeUndefined();
    expect(photoFiles().sort()).toEqual(['a-nobg.webp', 'a.webp']);
    expect(logs()).toContainEqual(
      expect.stringMatching(
        /Deleted a-nobg-[0-9a-f]{12}\.webp and a-thumb-[0-9a-f]{12}\.webp: edit refused \(not-allowed\)/,
      ),
    );
  });

  it('deletes its files and rethrows when the swap rolls back', async () => {
    const photos = build();
    await put('a.webp', await png(1000));
    await put('a-nobg.webp', await png(600));
    lockMock.mockResolvedValue(cutoutRow({ status: 'none' }));
    applyAsTheMachine();
    transactionFails = new Error('idle-in-transaction timeout');
    findKeyMock.mockResolvedValue(null);

    await expect(
      photos.saveEditedCutout(Readable.from(await png(300)), 'a.webp'),
    ).rejects.toBe(transactionFails);
    // The served set is untouched and nothing new is left behind.
    expect(photoFiles().sort()).toEqual(['a-nobg.webp', 'a.webp']);
    expect(logs()).toContainEqual(
      expect.stringMatching(/swap to key [0-9a-f]{12} rolled back/),
    );
  });

  it('keeps its files, and deletes the set it replaced, when the swap committed although its transaction failed', async () => {
    const photos = build();
    const old = variantFileName('a.webp', 'nobg', '0123456789ab');
    const oldThumb = variantFileName('a.webp', 'thumb', '0123456789ab');
    await put('a.webp', await png(1000));
    await put(old, await png(600));
    await put(oldThumb, await png(400));
    lockMock.mockResolvedValue(
      cutoutRow({ status: 'ready', variantKey: '0123456789ab' }),
    );
    applyAsTheMachine();
    transactionFails = new Error('Connection terminated unexpectedly');
    findKeyMock.mockImplementation(() => Promise.resolve(writtenKey()));

    await expect(
      photos.saveEditedCutout(Readable.from(await png(300)), 'a.webp'),
    ).resolves.toMatchObject({ fileName: 'a.webp', version: 2 });
    const key = writtenKey();
    expect(photoFiles().sort()).toEqual(
      [
        'a.webp',
        variantFileName('a.webp', 'nobg', key),
        variantFileName('a.webp', 'thumb', key),
      ].sort(),
    );
    expect(has(old)).toBe(false);
  });

  it('keeps its files when the row cannot be read after a failed swap', async () => {
    const photos = build();
    await put('a.webp', await png(1000));
    lockMock.mockResolvedValue(cutoutRow({ status: 'none' }));
    applyAsTheMachine();
    transactionFails = new Error('Connection terminated unexpectedly');
    findKeyMock.mockRejectedValue(new Error('database unreachable'));

    await expect(
      photos.saveEditedCutout(Readable.from(await png(300)), 'a.webp'),
    ).rejects.toBe(transactionFails);
    // Reconciliation's to judge a day later: never a row pointing at nothing.
    expect(photoFiles()).toHaveLength(3);
  });

  it('refuses undecodable bytes with a 400 before touching the row', async () => {
    const photos = build();
    await expect(
      photos.saveEditedCutout(Readable.from(Buffer.from('nope')), 'a.webp'),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Unreadable image' });
    expect(lockMock).not.toHaveBeenCalled();
    expect(stores).toEqual([]);
  });
});

describe('Photos.rederiveCutoutThumb', () => {
  // The retrim read key k1, then an edit swapped the row to k2 and deleted
  // k1's set: the photo is not missing a cutout.
  it('is a stale refusal, not a missing cutout, when a swap moved the key', async () => {
    const photos = build();
    findKeyMock.mockResolvedValue('0000000000b2');
    await expect(
      photos.rederiveCutoutThumb(
        { fileName: 'a.webp', variantKey: '0000000000a1' },
        { dryRun: false },
      ),
    ).resolves.toEqual({ result: 'refused', reason: 'stale' });
    findKeyMock.mockResolvedValue('0000000000a1');
    await expect(
      photos.rederiveCutoutThumb(
        { fileName: 'a.webp', variantKey: '0000000000a1' },
        { dryRun: false },
      ),
    ).resolves.toEqual({ result: 'no-cutout' });
    expect(stores).toEqual([]);
  });
});

describe('Photos.regenerateThumb', () => {
  /** The thumb regenerateThumb makes beside an original and this cutout. */
  const thumbOf = async (nobg: Buffer) => {
    const photos = build();
    await put('a.webp', await png(1000));
    await put('a-nobg.webp', nobg);
    const before = stores.length;
    await photos.regenerateThumb(A);
    expect(stores.slice(before)).toEqual(['a-thumb.webp']);
    return opaqueBox(await stored('a-thumb.webp'));
  };

  // A 200x300 garment low and left in a 1000 px frame: 5% of 300 around it
  // makes a 230x330 box, squared to 330 and scaled by 400/330.
  const garment = { left: 100, top: 600, width: 200, height: 300 };

  it("trims a cutout's thumb to the garment, centred on a square", async () => {
    const { width, height, box } = await thumbOf(
      await cutout(1000, { block: garment }),
    );
    expect([width, height]).toEqual([400, 400]);
    expect(box.bottom - box.top).toBeCloseTo((300 * 400) / 330, -1);
    expect(box.right - box.left).toBeCloseTo((200 * 400) / 330, -1);
    expect((box.left + box.right) / 2).toBeCloseTo(200, -1);
    expect((box.top + box.bottom) / 2).toBeCloseTo(200, -1);
  });

  it("ignores the model's faint haze when it finds the garment", async () => {
    const clean = await thumbOf(await cutout(1000, { block: garment }));
    const hazy = await thumbOf(
      await cutout(1000, { block: garment, haze: 20 }),
    );
    expect(hazy.box).toEqual(clean.box);
  });

  it('keeps the whole frame when the cutout shows (almost) nothing', async () => {
    // A 10 px speck is no garment: shown where it is, not blown up.
    const speck = await thumbOf(
      await cutout(1000, {
        block: { left: 500, top: 500, width: 10, height: 10 },
      }),
    );
    expect([speck.width, speck.height]).toEqual([400, 400]);
    expect(speck.box.left).toBeCloseTo(200, -1);
    expect(speck.box.right - speck.box.left).toBeLessThanOrEqual(6);
    // An empty mask: the whole, transparent frame.
    const empty = await thumbOf(await cutout(1000));
    expect([empty.width, empty.height]).toEqual([400, 400]);
  });

  it("makes an original's thumb whole, never trimmed or squared", async () => {
    const photos = build();
    await put(
      'a.webp',
      await sharp({
        create: { width: 1000, height: 600, channels: 3, background: '#fff' },
      })
        .webp()
        .toBuffer(),
    );
    await photos.regenerateThumb(A);
    expect(await sharp(await stored('a-thumb.webp')).metadata()).toMatchObject({
      width: 400,
      height: 240,
    });
  });
});

describe('Photos.deleteVariants', () => {
  it('removes every variant and tolerates missing ones', async () => {
    const photos = build();
    await put('a.webp', Buffer.from('x'));
    await put('a-thumb.webp', Buffer.from('x'));
    await photos.deleteVariants(A);
    expect(has('a.webp')).toBe(false);
    expect(has('a-thumb.webp')).toBe(false);
  });
});

describe('Photos.copy', () => {
  it('copies the original and the cutout under a new name, with a new thumb', async () => {
    const photos = build();
    await put('a.webp', await png(1000));
    await put('a-nobg.webp', await strip());

    const row = await photos.copy({ fileName: 'a.webp', variantKey: null }, 7);

    expect(row).toMatchObject({ createdById: 7 });
    expect(row!.fileName).toMatch(/^[0-9a-f-]{36}\.webp$/);
    const base = row!.fileName.replace('.webp', '');
    expect((await stored(row!.fileName)).equals(await stored('a.webp'))).toBe(
      true,
    );
    expect(
      (await stored(`${base}-nobg.webp`)).equals(await stored('a-nobg.webp')),
    ).toBe(true);
    // Made from the cutout: transparent above the strip.
    expect(
      (await opaqueBox(await stored(`${base}-thumb.webp`))).box.top,
    ).toBeGreaterThan(0);
  });

  it('copies the cutout the source row points at, unkeyed', async () => {
    const photos = build();
    await put('a.webp', await png(1000));
    await put('a-nobg.webp', await png(600));
    await put(
      variantFileName('a.webp', 'nobg', '0123456789ab'),
      await png(300),
    );

    const row = await photos.copy(
      { fileName: 'a.webp', variantKey: '0123456789ab' },
      7,
    );

    const base = row!.fileName.replace('.webp', '');
    expect(
      (await stored(`${base}-nobg.webp`)).equals(
        await stored(variantFileName('a.webp', 'nobg', '0123456789ab')),
      ),
    ).toBe(true);
    // The caller's row named the key: nothing read it again (#161).
    expect(findKeyMock).not.toHaveBeenCalled();
  });

  it('reads the cutout again when a swap deleted the one it was about to open', async () => {
    const photos = build();
    await put('a.webp', await png(1000));
    // The caller's row names a set a swap has deleted since.
    const swappedIn = variantFileName('a.webp', 'nobg', 'fedcba987654');
    await put(swappedIn, await png(300));
    findKeyMock.mockResolvedValue('fedcba987654');

    const row = await photos.copy(
      { fileName: 'a.webp', variantKey: '0123456789ab' },
      7,
    );

    const base = row!.fileName.replace('.webp', '');
    expect(
      (await stored(`${base}-nobg.webp`)).equals(await stored(swappedIn)),
    ).toBe(true);
  });

  it('copies no cutout when the row names none that exists', async () => {
    const photos = build();
    await put('a.webp', await png(1000));
    findKeyMock.mockResolvedValue('0123456789ab');

    const row = await photos.copy(
      { fileName: 'a.webp', variantKey: '0123456789ab' },
      7,
    );

    expect(has(`${row!.fileName.replace('.webp', '')}-nobg.webp`)).toBe(false);
    expect(findKeyMock).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when the source is gone', async () => {
    const photos = build();
    await expect(
      photos.copy({ fileName: 'a.webp', variantKey: null }, 7),
    ).resolves.toBeUndefined();
    expect(stores).toEqual([]);
  });
});

describe('Photos.storeUpload', () => {
  const part = (
    data: Buffer,
    mimetype: string,
    filename = 'photo.heic',
  ): MultipartFile =>
    ({
      file: Readable.from(data),
      mimetype,
      filename,
      fieldname: 'photo',
    }) as unknown as MultipartFile;

  // Braced: Vitest runs a function returned from beforeEach as its cleanup,
  // and mockReset() returns the mock itself.
  beforeEach(() => {
    heicAnswer.mockReset();
  });

  it('returns the row to insert, with a fresh share id, and stores original and thumb', async () => {
    const photos = build();
    const row = await photos.storeUpload(
      part(await png(1200), 'image/png', 'photo.png'),
      7,
    );
    expect(row).toEqual({
      fileName: expect.stringMatching(/^[0-9a-f-]{36}\.webp$/) as string,
      createdOn: expect.any(String) as string,
      createdById: 7,
    });
    expect(new Date(row.createdOn).toISOString()).toBe(row.createdOn);
    expect((await sharp(await stored(row.fileName)).metadata()).width).toBe(
      1080,
    );
    expect(has(row.fileName.replace('.webp', '-thumb.webp'))).toBe(true);
  });

  it('refuses a part that is not an image with a 400', async () => {
    const photos = build();
    await expect(
      photos.storeUpload(part(Buffer.from('x'), 'text/plain', 'a.txt'), 7),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Wrong filetype' });
    expect(stores).toEqual([]);
  });

  it('decodes image/heic to pixels and stores webp original and thumb', async () => {
    const photos = build();
    heicAnswer.mockReturnValue(heicPixels(600, 400));
    const bytes = Buffer.from('pretend heic container');

    const row = await photos.storeUpload(part(bytes, 'image/heic'), 7);

    expect(heicAnswer).toHaveBeenCalledWith(bytes, MAX_INPUT_PIXELS);
    const original = await sharp(await stored(row.fileName)).metadata();
    expect(original.format).toBe('webp');
    expect(original.width).toBe(600);
    expect(has(row.fileName.replace('.webp', '-thumb.webp'))).toBe(true);
  });

  it('recognises a .heic sent as application/octet-stream by its name', async () => {
    const photos = build();
    heicAnswer.mockReturnValue(heicPixels(60, 40));
    await photos.storeUpload(
      part(Buffer.from('x'), 'application/octet-stream', 'IMG_0001.HEIC'),
      7,
    );
    expect(heicAnswer).toHaveBeenCalledTimes(1);
  });

  it.each(['undecodable', 'crashed'] as const)(
    'answers a decode %s with the bad-photo 400 and stores nothing',
    async (reason) => {
      const photos = build();
      heicAnswer.mockRejectedValue(new HeicDecodeError(reason, 'the fake'));
      const refused = photos.storeUpload(
        part(Buffer.from('not heic'), 'image/heif'),
        7,
      );
      await expect(refused).rejects.toBeInstanceOf(HttpError);
      await expect(refused).rejects.toMatchObject({
        statusCode: 400,
        message: 'Unreadable image',
      });
      expect(photoFiles()).toEqual([]);
    },
  );

  it('rejects a HEIC part over MAX_HEIC_BYTES with a 413 without decoding', async () => {
    const photos = build();
    await expect(
      photos.storeUpload(
        part(Buffer.alloc(MAX_HEIC_BYTES + 1), 'image/heic'),
        7,
      ),
    ).rejects.toMatchObject({ statusCode: 413 });
    expect(heicAnswer).not.toHaveBeenCalled();
    expect(photoFiles()).toEqual([]);
  });

  it('refuses a HEIC declaring more pixels than MAX_INPUT_PIXELS with a 400', async () => {
    const photos = build();
    heicAnswer.mockRejectedValue(
      new HeicDecodeError('too-large', '10000x10000'),
    );
    await expect(
      photos.storeUpload(part(Buffer.from('x'), 'image/heic'), 7),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Image too large' });
    expect(photoFiles()).toEqual([]);
  });

  it('refuses any image over MAX_INPUT_PIXELS with a 400 before decoding it', async () => {
    const photos = build();
    // A real PNG of one colour: a few KB of file, 81 MP of pixels.
    const side = Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 1000;
    const bomb = await sharp({
      create: { width: side, height: side, channels: 3, background: '#000' },
      limitInputPixels: false,
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    await expect(
      photos.storeUpload(part(bomb, 'image/png', 'bomb.png'), 7),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Image too large' });
    expect(photoFiles()).toEqual([]);
  }, 30_000);

  it('rejects undecodable image bytes with a 400 and leaves no partial file', async () => {
    const photos = build();
    await expect(
      photos.storeUpload(
        part(Buffer.from('not a jpeg'), 'image/jpeg', 'p.jpg'),
        7,
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Unreadable image' });
    expect(photoFiles()).toEqual([]);
  });
});

describe('Photos.inputPixels', () => {
  const source = (data: Buffer, mimetype: string, filename = 'a photo') => ({
    stream: Readable.from([data]),
    mimetype,
    filename,
  });

  beforeEach(() => {
    heicAnswer.mockReset();
  });

  it("reads an image's pixel count from its header", async () => {
    const jpeg = await sharp({
      create: { width: 300, height: 200, channels: 3, background: '#123' },
    })
      .jpeg()
      .toBuffer();

    await expect(build().inputPixels(source(jpeg, 'image/jpeg'))).resolves.toBe(
      60_000,
    );
  });

  it('never hands a fetched HEIC to the decoder: an unreadable 400 (#699)', async () => {
    const photos = build();
    const heicSource = () => ({
      ...source(Buffer.from('....ftypheic'), 'image/heic', 'IMG_1.heic'),
      fetched: true as const,
    });

    await expect(photos.inputPixels(heicSource())).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(photos.preview(heicSource())).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(heicAnswer).not.toHaveBeenCalled();
  });

  it('refuses past MAX_INPUT_PIXELS as a decode would, from the header', async () => {
    const side = Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 1000;
    const bomb = await sharp({
      create: { width: side, height: side, channels: 3, background: '#000' },
      limitInputPixels: false,
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    await expect(
      build().inputPixels(source(bomb, 'image/png')),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Image too large' });
  }, 30_000);

  it.each([
    ['bytes that are no image', Buffer.from('not a jpeg'), 'image/jpeg'],
    ['a type that is no image', Buffer.from('<html>'), 'text/html'],
  ])('refuses %s with a 400', async (_label, data, mimetype) => {
    await expect(
      build().inputPixels(source(data, mimetype)),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('Photos.storeImage', () => {
  /** Decoded RGBA with a pixel reader. */
  const pixels = async (bytes: Buffer) => {
    const { data, info } = await sharp(bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => {
      const offset = (y * info.width + x) * info.channels;
      return [...data.subarray(offset, offset + 4)];
    };
    return { info, at };
  };

  /** A 300x400 transparent canvas with an opaque 100x200 block in it. */
  const art = () =>
    sharp({
      create: {
        width: 300,
        height: 400,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        {
          input: {
            create: {
              width: 100,
              height: 200,
              channels: 4,
              background: { r: 20, g: 40, b: 90, alpha: 1 },
            },
          },
          left: 100,
          top: 100,
        },
      ])
      .png()
      .toBuffer();

  const source = async () => ({
    stream: Readable.from(await art()),
    mimetype: 'image/png',
    filename: 'tee.png',
  });

  it('stores original and thumb only, by default (the cutout is queued)', async () => {
    const photos = build();
    const row = await photos.storeImage(await source(), 7);
    expect(stores).toEqual([
      row.fileName,
      row.fileName.replace('.webp', '-thumb.webp'),
    ]);
  });

  it('with alphaIsCutout, stores the art on white and its transparency as the padded-square cutout', async () => {
    const photos = build();
    const row = await photos.storeImage(await source(), 7, {
      alphaIsCutout: true,
    });
    const nobgName = row.fileName.replace('.webp', '-nobg.webp');
    const thumbName = row.fileName.replace('.webp', '-thumb.webp');
    expect(stores).toEqual([row.fileName, nobgName, thumbName]);

    // The original is what a photo would be: opaque, white where the
    // canvas was transparent (the share preview is a JPEG of it).
    const original = await pixels(await stored(row.fileName));
    expect([original.info.width, original.info.height]).toEqual([300, 400]);
    expect(original.at(5, 5)).toEqual([255, 255, 255, 255]);
    const nobg = await pixels(await stored(nobgName));
    expect([nobg.info.width, nobg.info.height]).toEqual([400, 400]);
    // Transparent where the canvas was, opaque where the garment is.
    expect(nobg.at(5, 5)[3]).toBe(0);
    expect(nobg.at(200, 200)[3]).toBe(255);
    // The thumb comes from the cutout, so it is square too.
    expect(await sharp(await stored(thumbName)).metadata()).toMatchObject({
      width: 400,
      height: 400,
    });
  });

  it('with alphaIsCutout, honours the EXIF orientation as every other path does (#199)', async () => {
    // The 300x400 art tagged "rotate 90° clockwise to display" (6): shown
    // upright it is 400x300, the block 200 wide at x 100..300, y 100..200.
    const sideways = await sharp(await art())
      .withMetadata({ orientation: 6 })
      .png()
      .toBuffer();
    expect((await sharp(sideways).metadata()).orientation).toBe(6);
    const photos = build();
    const row = await photos.storeImage(
      { stream: Readable.from(sideways), mimetype: 'image/png', filename: 'x' },
      7,
      { alphaIsCutout: true },
    );

    const original = await pixels(await stored(row.fileName));
    expect([original.info.width, original.info.height]).toEqual([400, 300]);
    const nobg = await pixels(
      await stored(row.fileName.replace('.webp', '-nobg.webp')),
    );
    // Padded to 400x400, the upright art 50 px down: the block is at x
    // 100..300, y 150..250. Stored sideways it would be x 150..250, y
    // 100..300.
    expect(nobg.at(250, 200)[3]).toBe(255);
    expect(nobg.at(200, 120)[3]).toBe(0);
  });

  it('turns the image by `rotate` after its EXIF orientation', async () => {
    const photos = build();
    const row = await photos.storeImage(await source(), 7, { rotate: 90 });
    const original = await sharp(await stored(row.fileName)).metadata();
    expect([original.width, original.height]).toEqual([400, 300]);
  });
});

describe('Photos.watermarked', () => {
  beforeEach(async () => {
    // Red on the white photo, so a composite changes the output.
    await put(
      'icon.png',
      await sharp({
        create: { width: 64, height: 64, channels: 4, background: '#f00' },
      })
        .png()
        .toBuffer(),
    );
    // Larger than the 170px watermark: sharp composites only onto a
    // background at least the overlay's size.
    await put('a.webp', await png(400));
    findByShareMock.mockResolvedValue('a.webp');
  });

  it('serves the original as a JPEG without the icon when WATERMARK_ENABLED is false', async () => {
    const photos = build({ watermarkEnabled: false });
    const out = await collect(await photos.watermarked('share-1'));
    expect(findByShareMock).toHaveBeenCalledWith(db, 'share-1');
    expect((await sharp(out).metadata()).format).toBe('jpeg');
  });

  it('composites the icon when WATERMARK_ENABLED is true', async () => {
    const photos = build({ watermarkEnabled: true });
    const plain = await collect(
      await build({ watermarkEnabled: false }).watermarked('share-1'),
    );
    const out = await collect(await photos.watermarked('share-1'));
    expect((await sharp(out).metadata()).format).toBe('jpeg');
    expect(out.equals(plain)).toBe(false);
  });

  it('is a 404 for an unknown share id', async () => {
    findByShareMock.mockResolvedValue(undefined);
    await expect(build().watermarked('nope')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
