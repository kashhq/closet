import { eq } from 'drizzle-orm';
import { readdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { garment, pendingPhoto } from '../../src/db/schema';
import { reconcileStorage } from '../../src/maintenance/reconcile';
import {
  parseStoredName,
  variantFileName,
} from '../../src/web/files/image-variant';
import { MAX_INPUT_PIXELS } from '../../src/web/files/photos';
import { MAX_PENDING_PER_USER } from '../../src/web/files/pending-photos';
import { t as text } from '../../src/web/i18n';
import { fakeRunner, storedCutout } from './cutouts';
import { garmentRow, jpegPhoto, photoRow, photoRowCount } from './garments';
import {
  createTestApp,
  type MultipartFile,
  multipart,
  TEST_PASSWORD,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import { silentLogger } from './logger';
import { expectNativePostForms, expectNoRawI18nKeys } from './pages';

/**
 * Adding a garment from a photo (#97): the add sheet's camera and library
 * post the photo to POST /wardrobe/new/photo, which stores it through the
 * garment photo path as the uploader's pending photo and redirects to the
 * new garment form holding it; the form's save claims it (the `file` row,
 * queued for its cutout, and the garment in one transaction). Nothing
 * reaches `garment` or `file` before the save, and an upload nobody saves
 * is a pending photo like an abandoned link import: capped per user and
 * removed by reconciliation a day later.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_HEIC_BYTES = 2048;

describe('adding a garment from a photo', () => {
  let t: TestApp;

  const storedOriginals = async () =>
    (await readdir(t.dataPath))
      .filter((name) => parseStoredName(name)?.variant === 'original')
      .sort();
  const garmentCount = () => t.db.$count(garment);
  const pendingOf = async (userId: number) =>
    (
      await t.db
        .select({ fileName: pendingPhoto.fileName })
        .from(pendingPhoto)
        .where(eq(pendingPhoto.userId, userId))
    ).map((row) => row.fileName);
  const linkPhotoIn = (body: string) =>
    /name="linkPhoto" value="([^"]+)"/.exec(body)?.[1];

  const jpegFile = async (data?: Buffer): Promise<MultipartFile> => ({
    data: data ?? (await jpegPhoto()),
    filename: 'IMG_0001.jpg',
    contentType: 'image/jpeg',
  });

  /** POST /wardrobe/new/photo with `file` as its `photo` part. */
  const upload = async (
    file: MultipartFile | undefined,
    {
      cookie,
      ownerId,
      anonymous,
    }: { cookie?: string; ownerId?: number; anonymous?: boolean } = {},
  ) => {
    const body = await multipart({}, file ? { photo: file } : {});
    return t.inject({
      method: 'POST',
      url: `/wardrobe/new/photo${ownerId ? `?ownerId=${ownerId}` : ''}`,
      payload: body.payload,
      headers: { ...body.headers, ...(cookie ? { cookie } : {}) },
      anonymous,
    });
  };

  /** Uploads a photo and returns the pending photo's name from the redirect. */
  const uploadPhoto = async (
    options: { cookie?: string; ownerId?: number } = {},
    file?: MultipartFile,
  ): Promise<string> => {
    const res = await upload(file ?? (await jpegFile()), options);
    expect(res.statusCode).toBe(303);
    const location = new URL(res.headers.location!, 'http://localhost');
    expect(location.pathname).toBe('/wardrobe/new');
    return location.searchParams.get('photo')!;
  };

  const save = (
    fields: Record<string, string>,
    { cookie, ownerId }: { cookie?: string; ownerId?: number } = {},
  ) =>
    t.inject({
      method: 'POST',
      url: `/wardrobe${ownerId ? `?ownerId=${ownerId}` : ''}`,
      payload: { category: 'tops', ...fields },
      headers: cookie ? { cookie } : {},
    });

  const signUp = async (email: string) => {
    const cookie = await t.register(email);
    return { cookie, id: await userIdOf(t, email) };
  };

  /** Runs `work` and asserts it stored nothing: no bytes, rows or pending rows. */
  const expectNothingStored = async (work: () => Promise<unknown>) => {
    const before = {
      originals: await storedOriginals(),
      garments: await garmentCount(),
      files: await photoRowCount(t),
      pending: await t.db.$count(pendingPhoto),
    };
    await work();
    expect({
      originals: await storedOriginals(),
      garments: await garmentCount(),
      files: await photoRowCount(t),
      pending: await t.db.$count(pendingPhoto),
    }).toEqual(before);
  };

  beforeAll(async () => {
    t = await createTestApp({ MAX_HEIC_BYTES: String(MAX_HEIC_BYTES) });
  });

  afterEach(async () => {
    await t.cutouts.stop();
  });

  afterAll(() => t?.cleanup());

  describe('the add sheet', () => {
    it('offers the camera and the library, each posting natively to the upload', async () => {
      const res = await t.inject({ method: 'GET', url: '/wardrobe' });
      expect(res.statusCode).toBe(200);
      const html = unescapeHtml(res.body);
      const sheet = html.slice(html.indexOf('id="add-sheet"'));

      expect(sheet).toMatch(
        /data-photo-source="camera"[^]*?<input type="file" name="photo" form="add-photo-camera" accept="[^"]*image\/heic[^"]*" capture="environment"/,
      );
      expect(sheet).toMatch(
        /data-photo-source="library"[^]*?<input type="file" name="photo" form="add-photo-library" accept="[^"]*"/,
      );
      expect(sheet).not.toMatch(/form="add-photo-library"[^>]*capture=/);
      for (const source of ['camera', 'library']) {
        expect(sheet).toContain(
          `<form id="add-photo-${source}" method="post" action="/wardrobe/new/photo" enctype="multipart/form-data" hx-boost="false" data-needs-network="" data-submit-once="">`,
        );
      }
      expect(sheet).toContain("import('photo-input')");
      expect(sheet).toContain(text('garment.PHOTO_CAMERA'));
      expect(sheet).toContain(text('garment.PHOTO_LIBRARY'));
      // Link import and "Enter details" are still there.
      expect(sheet).toContain('href="/wardrobe/new/from-link"');
      expect(sheet).toContain('href="/wardrobe/new"');
      expectNativePostForms(res);
      expectNoRawI18nKeys(res);
    });
  });

  describe('uploading', () => {
    it('stores a pending photo and opens the new garment form with it, writing no garment or file row', async () => {
      const { cookie, id } = await signUp('camera@example.com');
      const [garments, files] = [await garmentCount(), await photoRowCount(t)];
      const photo = await uploadPhoto({ cookie });

      expect(await garmentCount()).toBe(garments);
      expect(await photoRowCount(t)).toBe(files);
      expect(await pendingOf(id)).toEqual([photo]);
      const stored = await readdir(t.dataPath);
      expect(stored).toContain(photo);
      expect(stored).toContain(variantFileName(photo, 'thumb'));
      expect(stored).not.toContain(variantFileName(photo, 'nobg'));
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        expect.stringMatching(
          new RegExp(`Photo ${photo} uploaded by user ${id}, pending`),
        ),
      );

      const form = await t.inject({
        method: 'GET',
        url: `/wardrobe/new?photo=${photo}`,
        headers: { cookie },
      });
      expect(form.statusCode).toBe(200);
      expect(linkPhotoIn(form.body)).toBe(photo);
      const html = unescapeHtml(form.body);
      expect(html).toContain(`src="/file/thumb/${photo}`);
      expect(html).toContain(text('add.PHOTO_CUTOUT_HINT'));
      expect(html).toContain('action="/wardrobe"');
      expectNativePostForms(form);
      expectNoRawI18nKeys(form);
    });

    it('strips the EXIF (location, names) and keeps the photo upright', async () => {
      const tagged = await sharp({
        create: { width: 1200, height: 800, channels: 3, background: '#4a6' },
      })
        .withMetadata({ orientation: 6 })
        .withExifMerge({ IFD0: { Artist: 'Private Person' } })
        .jpeg()
        .toBuffer();
      const sent = await sharp(tagged).metadata();
      expect(sent.orientation).toBe(6);
      expect(sent.exif?.includes('Private Person')).toBe(true);

      const photo = await uploadPhoto({}, await jpegFile(tagged));

      for (const variant of ['original', 'thumb'] as const) {
        const bytes = await sharp(
          join(t.dataPath, variantFileName(photo, variant)),
        ).toBuffer();
        const meta = await sharp(bytes).metadata();
        expect(meta.format).toBe('webp');
        expect(meta.exif).toBeUndefined();
        expect(meta.orientation).toBeUndefined();
        expect(bytes.includes('Private Person')).toBe(false);
      }
      // Rotated by its orientation before the tag went: portrait now.
      const original = await sharp(join(t.dataPath, photo)).metadata();
      expect([original.width, original.height]).toEqual([720, 1080]);
    });
  });

  describe('saving', () => {
    it('claims the photo: the garment and its file row commit together, the cutout queued and made', async () => {
      const { cookie, id } = await signUp('saver@example.com');
      const photo = await uploadPhoto({ cookie });

      const res = await save(
        { name: 'Linen shirt', linkPhoto: photo },
        { cookie },
      );
      expect(res.statusCode).toBe(302);
      const garmentId = Number(
        /^\/wardrobe\/(\d+)\?created=1$/.exec(res.headers.location!)?.[1],
      );
      expect(await garmentRow(t, garmentId)).toMatchObject({
        ownerId: id,
        name: 'Linen shirt',
        photo: { fileName: photo, createdById: id, cutoutStatus: 'pending' },
      });
      expect(await pendingOf(id)).toEqual([]);
      expect(t.logs.messages('info', 'Web')).toContain(
        `Garment ${garmentId} photo ${photo} (a pending photo) queued for background removal`,
      );

      // The garment's page, where the save lands: its cutout under way.
      const page = await t.inject({
        method: 'GET',
        url: res.headers.location!,
        headers: { cookie },
      });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('Cutting out the background…');
      expect(page.body).toContain('hx-trigger="every 2s"');

      t.cutouts.start(fakeRunner());
      await t.cutouts.whenIdle();
      expect(await photoRow(t, photo)).toMatchObject({
        cutoutStatus: 'ready',
        cutoutAttempts: 1,
      });
      expect(await storedCutout(t, photo)).toBeDefined();

      // Back to the form after saving: the photo is the garment's now.
      const back = await t.inject({
        method: 'GET',
        url: `/wardrobe/new?photo=${photo}`,
        headers: { cookie },
      });
      expect(back.statusCode).toBe(200);
      expect(linkPhotoIn(back.body)).toBeUndefined();
      expect(unescapeHtml(back.body)).toContain(text('add.PHOTO_GONE'));
    });

    it('keeps the photo when the form itself is refused', async () => {
      const photo = await uploadPhoto();
      const res = await save({
        name: 'No category',
        category: '',
        linkPhoto: photo,
      });
      expect(res.statusCode).toBe(400);
      expect(linkPhotoIn(res.body)).toBe(photo);
    });
  });

  describe('refusals', () => {
    it.each<
      [
        string,
        () => MultipartFile | undefined | Promise<MultipartFile>,
        number,
        string,
      ]
    >([
      [
        'not an image',
        () => ({
          data: Buffer.from('plain words'),
          filename: 'notes.txt',
          contentType: 'text/plain',
        }),
        400,
        'Wrong filetype',
      ],
      [
        'bytes that do not decode',
        () => ({
          data: Buffer.from('not a jpeg at all'),
          filename: 'broken.jpg',
          contentType: 'image/jpeg',
        }),
        400,
        'Unreadable image',
      ],
      [
        'an image over the pixel limit',
        async () => ({
          data: await sharp({
            create: {
              width: Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 1000,
              height: Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 1000,
              channels: 3,
              background: '#000',
            },
            limitInputPixels: false,
          })
            .png({ compressionLevel: 9 })
            .toBuffer(),
          filename: 'bomb.png',
          contentType: 'image/png',
        }),
        400,
        'Image too large',
      ],
      [
        'a HEIC over MAX_HEIC_BYTES',
        () => ({
          data: Buffer.alloc(MAX_HEIC_BYTES + 1, 1),
          filename: 'huge.heic',
          contentType: 'image/heic',
        }),
        413,
        '',
      ],
      ['no photo at all', () => undefined, 400, 'No file uploaded'],
    ])(
      '%s: refused, nothing stored',
      async (_case, file, status, message) => {
        const sent = await file();
        await expectNothingStored(async () => {
          const res = await upload(sent);
          expect(res.statusCode).toBe(status);
          if (message) expect(res.body).toContain(message);
        });
      },
      30_000,
    );

    it('refuses a post from another site (CSRF), before reading it', async () => {
      const body = await multipart({}, { photo: await jpegFile() });
      await expectNothingStored(async () => {
        const res = await t.inject({
          method: 'POST',
          url: '/wardrobe/new/photo',
          payload: body.payload,
          headers: { ...body.headers, origin: 'https://evil.example' },
        });
        expect(res.statusCode).toBe(403);
      });
    });

    it('refuses an upload cut off before its closing boundary (multipart 10 raises, no longer ends the form quietly), storing nothing', async () => {
      const body = await multipart({}, { photo: await jpegFile() });
      const whole = Buffer.from(body.payload);
      await expectNothingStored(async () => {
        const res = await t.inject({
          method: 'POST',
          url: '/wardrobe/new/photo',
          payload: whole.subarray(0, whole.length - 200),
          headers: { ...body.headers },
        });
        expect(res.statusCode).toBe(400);
        expect(res.headers['content-type']).toContain('text/html');
      });
    });

    it('sends a signed-out visitor to log in, storing nothing', async () => {
      await expectNothingStored(async () => {
        const res = await upload(await jpegFile(), { anonymous: true });
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('/auth/login');
      });
    });

    it("never shows another user's pending photo on the form", async () => {
      const other = await signUp('other@example.com');
      const theirs = await uploadPhoto({ cookie: other.cookie });
      const form = await t.inject({
        method: 'GET',
        url: `/wardrobe/new?photo=${theirs}`,
      });
      expect(form.statusCode).toBe(200);
      expect(linkPhotoIn(form.body)).toBeUndefined();
      expect(form.body).not.toContain(theirs);
      expect(unescapeHtml(form.body)).toContain(text('add.PHOTO_GONE'));
      // Nor claims it: the pending row is the capability, not the name.
      const claim = await save({ name: 'Not mine', linkPhoto: theirs });
      expect(claim.statusCode).toBe(400);
      expect(await pendingOf(other.id)).toEqual([theirs]);
    });
  });

  describe('wardrobe shares', () => {
    let manager: { cookie: string; id: number };
    let viewer: string;
    let stranger: string;

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
      manager = await signUp('manager@example.com');
      viewer = await t.register('viewer@example.com');
      stranger = await t.register('stranger@example.com');
      await share(manager.cookie, 'MANAGE');
      await share(viewer, 'VIEW');
    });

    it("a MANAGE grantee adds from a photo to the owner's wardrobe; the photo is the owner's once saved", async () => {
      const ownerId = t.owner.id;
      const photo = await uploadPhoto({ cookie: manager.cookie, ownerId });
      expect(await pendingOf(manager.id)).toEqual([photo]);

      const form = await t.inject({
        method: 'GET',
        url: `/wardrobe/new?photo=${photo}&ownerId=${ownerId}`,
        headers: { cookie: manager.cookie },
      });
      expect(linkPhotoIn(form.body)).toBe(photo);
      expect(unescapeHtml(form.body)).toContain(
        `action="/wardrobe?ownerId=${ownerId}"`,
      );

      const res = await save(
        { name: 'From the grantee', linkPhoto: photo },
        { cookie: manager.cookie, ownerId },
      );
      expect(res.statusCode).toBe(302);
      const id = Number(/^\/wardrobe\/(\d+)/.exec(res.headers.location!)?.[1]);
      expect(await garmentRow(t, id)).toMatchObject({
        ownerId,
        photo: {
          fileName: photo,
          createdById: ownerId,
          cutoutStatus: 'pending',
        },
      });
    });

    it.each([
      ['a VIEW grantee', () => viewer, 403],
      ['a stranger', () => stranger, 404],
    ] as const)(
      "%s may not upload into the owner's wardrobe, and nothing is stored",
      async (_who, cookie, status) => {
        await expectNothingStored(async () => {
          const res = await upload(await jpegFile(), {
            cookie: cookie(),
            ownerId: t.owner.id,
          });
          expect(res.statusCode).toBe(status);
        });
      },
    );

    it("a VIEW grantee's add sheet has no camera or library", async () => {
      const res = await t.inject({
        method: 'GET',
        url: `/wardrobe?ownerId=${t.owner.id}`,
        headers: { cookie: viewer },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('/wardrobe/new/photo');
      expect(res.body).not.toContain('data-photo-source');
    });
  });

  describe('abandoned uploads', () => {
    it(`are at most ${MAX_PENDING_PER_USER} a user: another evicts the oldest, bytes included`, async () => {
      const hoarder = await signUp('hoarder@example.com');
      const photos: string[] = [];
      for (let i = 0; i <= MAX_PENDING_PER_USER; i++) {
        photos.push(await uploadPhoto({ cookie: hoarder.cookie }));
      }
      const [oldest, ...kept] = photos;
      expect((await pendingOf(hoarder.id)).sort()).toEqual([...kept].sort());
      const stored = await storedOriginals();
      expect(stored).not.toContain(oldest);
      for (const photo of kept) expect(stored).toContain(photo);
      expect(t.logs.messages('info', 'Web').join('\n')).toContain(
        `evicted ${oldest}`,
      );
      // Nothing of them in the grid: an upload is not a garment.
      const grid = await t.inject({
        method: 'GET',
        url: '/wardrobe',
        headers: { cookie: hoarder.cookie },
      });
      for (const photo of kept) expect(grid.body).not.toContain(photo);
    });

    it('are removed by reconciliation a day later, rows and bytes, outside its guard', async () => {
      const { cookie, id } = await signUp('abandoner@example.com');
      const young = await uploadPhoto({ cookie });
      const old = await uploadPhoto({ cookie });
      const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS);
      await t.db
        .update(pendingPhoto)
        .set({ createdAt: twoDaysAgo })
        .where(eq(pendingPhoto.fileName, old));
      for (const variant of ['original', 'thumb'] as const) {
        const path = join(t.dataPath, variantFileName(old, variant));
        await utimes(path, twoDaysAgo, twoDaysAgo);
      }

      const report = await reconcileStorage({
        db: t.db,
        photos: t.photos,
        timeZone: t.timeZone,
        logger: silentLogger,
      });
      expect(report.refused).toBeUndefined();
      expect(report.pendingPhotosDeleted).toBe(1);
      expect(report.orphanedSetsQuarantined).toBe(0);
      const stored = await readdir(t.dataPath);
      expect(stored.some((name) => name.startsWith(old.slice(0, 36)))).toBe(
        false,
      );
      expect(stored).toContain(young);
      expect(await pendingOf(id)).toEqual([young]);
    });

    it("go with their user's account", async () => {
      const email = 'leaving@example.com';
      const leaving = await signUp(email);
      const photo = await uploadPhoto({ cookie: leaving.cookie });
      const res = await t.inject({
        method: 'POST',
        url: '/auth/delete-account',
        payload: { email, password: TEST_PASSWORD },
        headers: { cookie: leaving.cookie },
      });
      expect(res.statusCode).toBe(302);
      const stored = await readdir(t.dataPath);
      expect(stored.some((name) => name.startsWith(photo.slice(0, 36)))).toBe(
        false,
      );
      expect(await pendingOf(leaving.id)).toEqual([]);
    });
  });
});
