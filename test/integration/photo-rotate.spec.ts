import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { file } from '../../src/db/schema';
import {
  parseStoredName,
  variantFileName,
} from '../../src/web/files/image-variant';
import { alphaAt, fakeRunner, storedCutout, variantPath } from './cutouts';
import {
  createGarment,
  garmentRow,
  photoFileName,
  photoRow,
  uploadPhoto,
} from './garments';
import {
  createTestApp,
  multipart,
  type TestApp,
  unescapeHtml,
  TEST_PASSWORD,
} from './harness';
import { expectNativePostForms } from './pages';

/**
 * Rotating a garment's photo (#199): a turned copy of the stored original
 * replaces it as an upload does, the cutout queued again (or, when a mask
 * was edited, turned with it), and nothing is left on disk that no row
 * explains.
 */
describe('POST /wardrobe/:id/photo/rotate', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.cutouts.stop();
  });

  afterAll(() => t?.cleanup());

  /** 1200x800, red on the left half and blue on the right. */
  const twoTone = () =>
    sharp({
      create: { width: 1200, height: 800, channels: 3, background: '#00f' },
    })
      .composite([
        {
          input: {
            create: {
              width: 600,
              height: 800,
              channels: 3,
              background: '#f00',
            },
          },
          left: 0,
          top: 0,
        },
      ])
      .jpeg()
      .toBuffer();

  const rotate = (id: number, direction: string, cookie?: string, q = '') =>
    t.inject({
      method: 'POST',
      url: `/wardrobe/${id}/photo/rotate${q}`,
      payload: { direction },
      headers: cookie ? { cookie } : {},
    });

  /** POST /wardrobe/:id/nobg, as the mask editor saves: an opaque width x height PNG. */
  const saveMask = async (id: number, width: number, height: number) => {
    const mask = await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 200, g: 30, b: 30, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const body = await multipart(
      {},
      {
        nobgPhoto: {
          data: mask,
          filename: 'cutout.png',
          contentType: 'image/png',
        },
      },
    );
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/${id}/nobg`,
      payload: body.payload,
      headers: body.headers,
    });
    expect(res.statusCode).toBe(200);
  };

  const dimensions = async (path: string) => {
    const { width, height } = await sharp(await readFile(path)).metadata();
    return [width, height];
  };

  /** Red (255, 0, 0) or blue at x, y of a stored image, to the nearest. */
  const colourAt = async (path: string, x: number, y: number) => {
    const { data, info } = await sharp(await readFile(path))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const offset = (y * info.width + x) * info.channels;
    return data[offset] > data[offset + 2] ? 'red' : 'blue';
  };

  const original = (fileName: string) => join(t.dataPath, fileName);

  /**
   * Every photo file on disk belongs to a `file` row, under no key but the
   * row's own: the replaced photo's set and a refused turn's copy are gone.
   */
  const expectNoOrphans = async () => {
    const rows = await t.db
      .select({ fileName: file.fileName, variantKey: file.variantKey })
      .from(file);
    const keys = new Map(rows.map((row) => [row.fileName, row.variantKey]));
    const stored = (await readdir(t.dataPath)).flatMap((name) => {
      const parsed = parseStoredName(name);
      return parsed ? [{ name, ...parsed }] : [];
    });
    const orphans = stored.filter(
      ({ baseName, variantKey }) =>
        !keys.has(baseName) ||
        (variantKey !== null && variantKey !== keys.get(baseName)),
    );
    expect(orphans.map(({ name }) => name)).toEqual([]);
    for (const { fileName } of rows) {
      expect(stored.map(({ name }) => name)).toContain(fileName);
    }
  };

  it('replaces the photo with a turned copy, queues its cutout and leaves no orphan', async () => {
    const id = await createGarment(t, { name: 'Sideways shirt' });
    await uploadPhoto(t, id, await twoTone());
    const before = await photoFileName(t, id);
    t.cutouts.start(fakeRunner());
    await t.cutouts.whenIdle();
    expect(await photoRow(t, before)).toMatchObject({ cutoutStatus: 'ready' });
    await t.cutouts.stop();
    expect(await dimensions(original(before))).toEqual([1080, 720]);

    const res = await rotate(id, 'right');
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/wardrobe/${id}?photoRotated=1`);

    const after = await photoFileName(t, id);
    expect(after).not.toBe(before);
    // The replaced photo's row and every file of its set are gone.
    expect(await photoRow(t, before)).toBeUndefined();
    expect(
      (await readdir(t.dataPath)).filter((name) =>
        name.startsWith(before.replace('.webp', '')),
      ),
    ).toEqual([]);
    // Turned clockwise: the left (red) is now the top.
    expect(await dimensions(original(after))).toEqual([720, 1080]);
    expect(await colourAt(original(after), 360, 100)).toBe('red');
    expect(await colourAt(original(after), 360, 980)).toBe('blue');
    expect(
      await dimensions(join(t.dataPath, variantFileName(after, 'thumb'))),
    ).toEqual([267, 400]);
    // Queued again, as a new upload is.
    expect(await photoRow(t, after)).toMatchObject({
      cutoutStatus: 'pending',
      variantKey: null,
    });
    expect(await storedCutout(t, after)).toBeUndefined();
    expect(t.logs.messages('info', 'Web')).toContain(
      `Garment ${id} photo rotated right by user ${t.owner.id}`,
    );

    // The cutout is of the turned photo: the 720-wide original centred on
    // the 1080 square, its right half (the fake mask's garment) opaque.
    t.cutouts.start(fakeRunner());
    await t.cutouts.whenIdle();
    expect(await photoRow(t, after)).toMatchObject({ cutoutStatus: 'ready' });
    const cutout = (await storedCutout(t, after))!;
    expect(await sharp(cutout).metadata()).toMatchObject({
      width: 1080,
      height: 1080,
    });
    expect(await alphaAt(cutout, 100, 540)).toBe(0);
    expect(await alphaAt(cutout, 700, 50)).toBe(255);
    await expectNoOrphans();
  });

  it('turns counter-clockwise for left', async () => {
    const id = await createGarment(t, { name: 'Left turn shirt' });
    await uploadPhoto(t, id, await twoTone());
    expect((await rotate(id, 'left')).statusCode).toBe(303);
    const after = await photoFileName(t, id);
    // The left (red) is now the bottom.
    expect(await colourAt(original(after), 360, 100)).toBe('blue');
    expect(await colourAt(original(after), 360, 980)).toBe('red');
    await expectNoOrphans();
  });

  it('turns an edited cutout with the photo and keeps it edited, queueing nothing', async () => {
    const id = await createGarment(t, { name: 'Masked shirt' });
    await uploadPhoto(t, id, await twoTone());
    const before = await photoFileName(t, id);
    // A 600x400 mask edit: its turn is 400x600.
    await saveMask(id, 600, 400);
    expect(await photoRow(t, before)).toMatchObject({ cutoutStatus: 'edited' });

    expect((await rotate(id, 'right')).statusCode).toBe(303);
    const after = await photoFileName(t, id);
    expect(await photoRow(t, after)).toMatchObject({
      cutoutStatus: 'edited',
      cutoutRequestedAt: null,
      variantKey: null,
    });
    expect(await dimensions(original(after))).toEqual([720, 1080]);
    expect(await dimensions(await variantPath(t, after, 'nobg'))).toEqual([
      400, 600,
    ]);
    // The thumb comes from the turned cutout: squared (cutoutThumb), where
    // the original's would be 267x400.
    expect(await dimensions(await variantPath(t, after, 'thumb'))).toEqual([
      400, 400,
    ]);
    expect(t.logs.messages('info', 'Web')).toContain(
      `Garment ${id} photo rotated right by user ${t.owner.id}, its edited cutout with it`,
    );
    expect(t.logs.messages('info', 'Web')).not.toContain(
      `Garment ${id} photo ${after} queued for background removal`,
    );
    await expectNoOrphans();
  });

  it('refuses with a 409 when a second mask is saved while the first is turned, and keeps the second', async () => {
    const id = await createGarment(t, { name: 'Two masks shirt' });
    await uploadPhoto(t, id, await twoTone());
    const fileName = await photoFileName(t, id);
    await saveMask(id, 600, 400); // mask A
    const maskA = await photoRow(t, fileName);
    expect(maskA).toMatchObject({ cutoutStatus: 'edited' });

    // The interleaving, in order: the rotate reads its source and turns
    // mask A; mask B is saved and commits (still `edited`, a new key);
    // only then does the rotate's swap run.
    const rotateStored = t.photos.rotateStored.bind(t.photos);
    let turned: string | undefined;
    const spy = vi
      .spyOn(t.photos, 'rotateStored')
      .mockImplementation(async (...args) => {
        const result = await rotateStored(...args);
        turned = result.row.fileName;
        expect(result.cutoutKept).toBe(true);
        await saveMask(id, 500, 400); // mask B
        return result;
      });
    try {
      const res = await rotate(id, 'right');
      expect(res.statusCode).toBe(409);
      expect(res.body).toContain('The photo changed meanwhile');
    } finally {
      spy.mockRestore();
    }

    // Mask B is the photo's, on the row and on disk; the turned copy of
    // mask A is gone.
    expect(await photoFileName(t, id)).toBe(fileName);
    const maskB = await photoRow(t, fileName);
    expect(maskB).toMatchObject({
      cutoutStatus: 'edited',
      version: maskA!.version + 1,
    });
    expect(maskB!.variantKey).not.toBe(maskA!.variantKey);
    expect(await dimensions(await variantPath(t, fileName, 'nobg'))).toEqual([
      500, 400,
    ]);
    expect(turned).toBeDefined();
    expect(await photoRow(t, turned!)).toBeUndefined();
    expect(
      (await readdir(t.dataPath)).filter((name) =>
        name.startsWith(turned!.replace('.webp', '')),
      ),
    ).toEqual([]);
    await expectNoOrphans();
  });

  it('turns a photo whose cutout landed while it was turned, and requeues it (#248)', async () => {
    const id = await createGarment(t, { name: 'Double tap shirt' });
    await uploadPhoto(t, id, await twoTone());
    const before = await photoFileName(t, id);
    expect(await photoRow(t, before)).toMatchObject({
      cutoutStatus: 'pending',
    });

    // The cutout job finishes between the rotate's read and its swap, as
    // a second tap during a pending cutout meets it.
    const rotateStored = t.photos.rotateStored.bind(t.photos);
    const spy = vi
      .spyOn(t.photos, 'rotateStored')
      .mockImplementation(async (...args) => {
        const result = await rotateStored(...args);
        t.cutouts.start(fakeRunner());
        await t.cutouts.whenIdle();
        await t.cutouts.stop();
        expect(await photoRow(t, before)).toMatchObject({
          cutoutStatus: 'ready',
        });
        return result;
      });
    try {
      const res = await rotate(id, 'right');
      expect(res.statusCode).toBe(303);
    } finally {
      spy.mockRestore();
    }

    // The turned photo replaced it, queued for its own cutout; the old
    // photo's set went, the cutout that just landed included.
    const after = await photoFileName(t, id);
    expect(after).not.toBe(before);
    expect(await photoRow(t, before)).toBeUndefined();
    expect(await photoRow(t, after)).toMatchObject({
      cutoutStatus: 'pending',
      variantKey: null,
    });
    expect(await dimensions(original(after))).toEqual([720, 1080]);
    await expectNoOrphans();
  });

  it('refuses with a 409 when a mask is saved while an unedited photo is turned, and keeps the mask', async () => {
    const id = await createGarment(t, { name: 'Late mask shirt' });
    await uploadPhoto(t, id, await twoTone());
    const fileName = await photoFileName(t, id);

    const rotateStored = t.photos.rotateStored.bind(t.photos);
    let turned: string | undefined;
    const spy = vi
      .spyOn(t.photos, 'rotateStored')
      .mockImplementation(async (...args) => {
        const result = await rotateStored(...args);
        turned = result.row.fileName;
        expect(result.cutoutKept).toBe(false);
        await saveMask(id, 500, 400);
        return result;
      });
    try {
      const res = await rotate(id, 'right');
      expect(res.statusCode).toBe(409);
    } finally {
      spy.mockRestore();
    }

    // The mask is the photo's; the turned copy, which lacked it, is gone.
    expect(await photoFileName(t, id)).toBe(fileName);
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'edited',
    });
    expect(turned).toBeDefined();
    expect(await photoRow(t, turned!)).toBeUndefined();
    await expectNoOrphans();
  });

  it('turns once per tap that lands: two at once never turn a stale photo, and leave nothing behind', async () => {
    const id = await createGarment(t, { name: 'Double tap shirt' });
    await uploadPhoto(t, id, await twoTone());
    const results = await Promise.all([
      rotate(id, 'right'),
      rotate(id, 'right'),
    ]);
    const statuses = results.map((res) => res.statusCode).sort();
    expect([
      [303, 303],
      [303, 409],
    ]).toContainEqual(statuses);
    const after = await photoFileName(t, id);
    const turns = statuses.filter((status) => status === 303).length;
    // One quarter turn: portrait, red on top. Two: landscape, red right.
    if (turns === 1) {
      expect(await dimensions(original(after))).toEqual([720, 1080]);
      expect(await colourAt(original(after), 360, 100)).toBe('red');
    } else {
      expect(await dimensions(original(after))).toEqual([1080, 720]);
      expect(await colourAt(original(after), 1000, 360)).toBe('red');
    }
    const refused = results.find((res) => res.statusCode === 409);
    if (refused) expect(refused.body).toContain('The photo changed meanwhile');
    await expectNoOrphans();
  });

  it('refuses a garment without a photo and an unknown direction with a 400', async () => {
    const id = await createGarment(t, { name: 'No photo shirt' });
    const none = await rotate(id, 'right');
    expect(none.statusCode).toBe(400);
    expect(none.body).toContain('Garment has no photo');

    await uploadPhoto(t, id, await twoTone());
    const before = await photoFileName(t, id);
    expect((await rotate(id, 'up')).statusCode).toBe(400);
    expect(await photoFileName(t, id)).toBe(before);
  });

  it('offers ↺ and ↻ in the photo sheet, as one native post', async () => {
    const id = await createGarment(t, { name: 'Sheet shirt' });
    const empty = await t.inject({ method: 'GET', url: `/wardrobe/${id}` });
    expect(empty.body).not.toContain('/photo/rotate');

    await uploadPhoto(t, id, await twoTone());
    const res = await t.inject({ method: 'GET', url: `/wardrobe/${id}` });
    const html = unescapeHtml(res.body);
    expect(html).toContain(
      `<form method="post" action="/wardrobe/${id}/photo/rotate" class="group/rotate flex flex-col gap-3" hx-boost="false" data-needs-network="" data-submit-once="">`,
    );
    expect(html).toMatch(/name="direction" value="left"[^>]*>.*Rotate left/s);
    expect(html).toMatch(/name="direction" value="right"[^>]*>.*Rotate right/s);
    expectNativePostForms(res);
    const reopen =
      /<dialog id="garment-photo-sheet"[^>]*data-page-module="open-sheet"/;
    expect(res.body).not.toMatch(reopen);

    // Where a rotate lands: the sheet opens again for the next turn
    // (page-mount.ts), and the marker is stripped from the address.
    const landed = await t.inject({
      method: 'GET',
      url: `/wardrobe/${id}?photoRotated=1`,
    });
    const body = unescapeHtml(landed.body);
    expect(body).toMatch(reopen);
    expect(body).toMatch(/data-strip-flags="[^"]*\bphotoRotated\b/);
  });

  describe('wardrobe shares', () => {
    let manager: string;
    let viewer: string;
    let stranger: string;
    let id: number;

    const share = async (cookie: string, permission: 'VIEW' | 'MANAGE') => {
      const invite = await t.inject({
        method: 'POST',
        url: '/wardrobe-share/create-invite-link',
        payload: { permission, currentPassword: TEST_PASSWORD },
        headers: { 'hx-request': 'true' },
      });
      const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
        invite.body,
      )![1];
      await t.inject({
        method: 'POST',
        url: `/wardrobe-share/invite/${token}/accept`,
        headers: { cookie },
      });
    };

    beforeAll(async () => {
      manager = await t.register('rotate-manager@example.com');
      viewer = await t.register('rotate-viewer@example.com');
      stranger = await t.register('rotate-stranger@example.com');
      await share(manager, 'MANAGE');
      await share(viewer, 'VIEW');
      id = await createGarment(t, { name: 'Shared shirt' });
      await uploadPhoto(t, id, await twoTone());
    });

    it.each([
      ['a VIEW grantee', () => viewer, 403],
      ['a stranger', () => stranger, 404],
    ] as const)(
      "%s may not rotate the owner's photo, and nothing is stored",
      async (_who, cookie, status) => {
        const before = await photoFileName(t, id);
        const files = await readdir(t.dataPath);
        const res = await rotate(
          id,
          'right',
          cookie(),
          `?ownerId=${t.owner.id}`,
        );
        expect(res.statusCode).toBe(status);
        expect(await photoFileName(t, id)).toBe(before);
        expect(await readdir(t.dataPath)).toEqual(files);
      },
    );

    it("a MANAGE grantee rotates the owner's photo, which stays the owner's", async () => {
      const res = await rotate(id, 'right', manager, `?ownerId=${t.owner.id}`);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(
        `/wardrobe/${id}?photoRotated=1&ownerId=${t.owner.id}`,
      );
      expect(await garmentRow(t, id)).toMatchObject({
        photo: { createdById: t.owner.id, cutoutStatus: 'pending' },
      });
      await expectNoOrphans();
    });
  });
});
