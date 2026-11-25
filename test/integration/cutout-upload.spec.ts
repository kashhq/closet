import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { file } from '../../src/db/schema';
import { imageUrl } from '../../src/web/files/image-url';
import { readPhotoRef } from '../../src/web/files/queries';
import { ModelDownloadError } from '../../src/cutout/model';
import { eventually, fakeRunner, halfMask, storedCutout } from './cutouts';
import {
  createGarment,
  garmentRow,
  jpegPhoto,
  photoFileName,
  photoRow,
  pngCutout,
  uploadPhoto,
} from './garments';
import {
  createTestApp,
  multipart,
  type TestApp,
  unescapeHtml,
  asFixture,
} from './harness';
import {
  expectFragment,
  expectNativePostForms,
  expectNoRawI18nKeys,
  HX_FRAGMENT,
} from './pages';

/**
 * The garment photo flow: the upload is queued, the page shows the cutout
 * pending and polls a fragment that swaps it in, a failure offers a
 * native-post "Try again". The browser never removes a background.
 */
describe('cutouts: upload, page and polling', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.cutouts.stop();
  });

  afterAll(() => t?.cleanup());

  const page = async (id: number) =>
    t.inject({ method: 'GET', url: `/wardrobe/${id}` });
  const fragment = async (id: number) =>
    t.inject({
      method: 'GET',
      url: `/wardrobe/${id}/cutout`,
      headers: HX_FRAGMENT,
    });

  it('queues an uploaded photo and shows it pending, polling', async () => {
    const id = await createGarment(t, { name: 'Pending shirt' });
    await uploadPhoto(t, id, await jpegPhoto());
    const fileName = await photoFileName(t, id);

    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'pending',
      cutoutAttempts: 0,
      cutoutJobVersion: null,
      version: 1,
    });
    expect((await photoRow(t, fileName))!.cutoutRequestedAt).toBeInstanceOf(
      Date,
    );
    expect(await storedCutout(t, fileName)).toBeUndefined();
    expect(t.logs.messages('info', 'Web')).toContain(
      `Garment ${id} photo ${fileName} queued for background removal`,
    );

    const res = await page(id);
    expect(res.statusCode).toBe(200);
    const html = unescapeHtml(res.body);
    expect(html).toMatch(
      new RegExp(
        `<div id="garment-photo" hx-get="/wardrobe/${id}/cutout\\?poll=1" hx-trigger="every 2s" hx-swap="outerHTML" hx-indicator="#garment-photo-status">`,
      ),
    );
    expect(html).toContain('Cutting out the background…');
    // Nothing to edit yet; the photo sheet posts the photo alone, prepared
    // on the phone first.
    expect(html).not.toContain('id="editMaskBtn"');
    expect(html).not.toContain('name="nobgPhoto"');
    expect(html).toContain('data-photo-pick=""');
    expectNativePostForms(res);
    expectNoRawI18nKeys(res);
  });

  // #1069: the edit form's subject is the page's photo view in the form's
  // place, which keeps its place across the polls and never draws the
  // page's tools: the form has no photo sheet or mask editor, and a retry
  // would leave what was typed. A new garment has no subject.
  it("shows the edit form's photo as its subject, pending and polling in the form's place, without the page's tools", async () => {
    const id = await createGarment(t, { name: 'Form shirt' });
    await uploadPhoto(t, id, await jpegPhoto());

    const form = await t.inject({ method: 'GET', url: `/wardrobe/${id}/edit` });
    expect(form.statusCode).toBe(200);
    const html = unescapeHtml(form.body);
    expect(html).toMatch(
      /<main class="page-shell w-full mx-auto" data-layout="split" data-subject="lg">\s*<section id="form-aside" class="page-aside">/,
    );
    expect(html).toContain(
      `<div id="garment-photo" hx-get="/wardrobe/${id}/cutout?poll=1&place=form" hx-trigger="every 2s"`,
    );
    expect(html).toContain('Cutting out the background…');
    expect(html).toMatch(
      /<img src="\/file\/[^"]+" alt="Form shirt" class="object-contain w-full h-full" loading="lazy"\/?>/,
    );

    t.cutouts.start(
      fakeRunner(() => {
        throw new Error('model exploded');
      }),
    );
    await t.cutouts.whenIdle();
    const failed = unescapeHtml(
      (
        await t.inject({
          method: 'GET',
          url: `/wardrobe/${id}/cutout?poll=3&place=form`,
          headers: HX_FRAGMENT,
        })
      ).body,
    );
    expect(failed).toContain('The background could not be removed.');
    expect(failed).not.toContain('/cutout/retry');
    expect(failed).not.toContain('id="editMaskBtn"');

    const add = unescapeHtml(
      (await t.inject({ method: 'GET', url: '/wardrobe/new' })).body,
    );
    expect(add).toContain('data-layout="single"');
    expect(add).not.toContain('id="garment-photo"');
  });

  // Every route that draws a garment's form hands it its subject: the
  // clone form, and the refused edit and clone, whose 400 re-renders the
  // form (garment-routes.tsx), and the refused repair-log entry, which draws
  // the edit page (repair-routes.tsx); a route that stopped passing it would
  // drop the photo from that page alone.
  it('keeps the photo subject on the clone form and on a refused edit or clone', async () => {
    const id = await createGarment(t, { name: 'Refused shirt' });
    await uploadPhoto(t, id, await jpegPhoto());
    const refused = new URLSearchParams({
      name: 'Refused shirt',
      category: '',
    });
    const post = (url: string) =>
      t.inject({
        method: 'POST',
        url,
        payload: refused.toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });

    const refusedRepair = await t.inject({
      method: 'POST',
      url: `/wardrobe/${id}/repairs`,
      payload: new URLSearchParams({ kind: 'repair', note: ' ' }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    for (const [res, status] of [
      [await t.inject({ method: 'GET', url: `/wardrobe/${id}/clone` }), 200],
      [await post(`/wardrobe/${id}`), 400],
      [await post(`/wardrobe/${id}/clone`), 400],
      [refusedRepair, 400],
    ] as const) {
      expect(res.statusCode).toBe(status);
      expect(unescapeHtml(res.body)).toMatch(
        /<section id="form-aside" [^>]*>\s*<div id="garment-photo"[^>]*>\s*<figure /,
      );
    }
  });

  // #689: a queue that cannot run its model leaves the photo pending for
  // as long as that lasts; an open page must not poll it every 2 s forever.
  // A busy but working queue (a bulk upload) must keep polling, so the
  // cutout still lands on the page.
  describe('the pending poll', () => {
    const pollOf = (id: number) => async (n: number) => {
      const res = await t.inject({
        method: 'GET',
        url: `/wardrobe/${id}/cutout?poll=${n}`,
        headers: HX_FRAGMENT,
      });
      expectFragment(res);
      return unescapeHtml(res.body);
    };
    const polls = (id: number, n: number, every: string) =>
      `hx-get="/wardrobe/${id}/cutout?poll=${n + 1}" hx-trigger="every ${every}"`;

    it('backs off from 2 s to 10 s, then stops at 2 min with the queued line while the model is unavailable, and never refuses a poll count', async () => {
      const id = await createGarment(t, { name: 'Waiting shirt' });
      await uploadPhoto(t, id, await jpegPhoto());
      const runner = fakeRunner();
      runner.ready = () =>
        Promise.reject(new ModelDownloadError('Model download failed'));
      t.cutouts.start(runner);
      await eventually('the queue to wait for the model', () =>
        Promise.resolve(t.cutouts.state.name === 'waiting-for-model'),
      );
      const poll = pollOf(id);

      // 15 polls 2 s apart (30 s), then 9 polls 10 s apart (to 120 s).
      for (const [n, every] of [
        [14, '2s'],
        [15, '10s'],
        [23, '10s'],
      ] as const) {
        const html = await poll(n);
        expect(html).toContain(polls(id, n, every));
        expect(html).toContain('Cutting out the background…');
      }
      const capped = await poll(24);
      expect(capped).toContain('<div id="garment-photo">');
      expect(capped).not.toContain('hx-trigger');
      expect(capped).toContain(
        'Background removal is queued and will finish later.',
      );
      expect(capped).not.toContain('Cutting out the background…');
      // URL state is a fallback, never a 400: a count past the clamp (a page
      // left open for hours) or one no fragment writes still answers.
      // A count past the clamp is still capped (no further poll while the
      // model is unavailable); one that is not digits starts the backoff
      // over, every 2 s from poll 1.
      for (const [odd, restarts] of [
        ['1001', false],
        ['99999999999999999999', false],
        ['soon', true],
        ['-1', true],
      ] as const) {
        const res = await t.inject({
          method: 'GET',
          url: `/wardrobe/${id}/cutout?poll=${odd}`,
          headers: HX_FRAGMENT,
        });
        expectFragment(res);
        const html = unescapeHtml(res.body);
        if (restarts) expect(html, odd).toContain(polls(id, 0, '2s'));
        else expect(html, odd).not.toContain('hx-trigger');
      }
    });

    it('keeps polling every 10 s past 2 min while the queue runs, busy with a job', async () => {
      const id = await createGarment(t, { name: 'Busy shirt' });
      await uploadPhoto(t, id, await jpegPhoto());
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let running = false;
      t.cutouts.start(
        fakeRunner(async () => {
          running = true;
          await released;
          return halfMask();
        }),
      );
      await eventually('a job to run', () => Promise.resolve(running));
      expect(t.cutouts.state).toEqual({ name: 'running' });

      for (const n of [24, 40]) {
        const html = await pollOf(id)(n);
        expect(html).toContain(polls(id, n, '10s'));
        expect(html).toContain('Cutting out the background…');
        expect(html).not.toContain('will finish later');
      }
      release();
      await t.cutouts.whenIdle();
    });
  });

  it('answers a refused photo with the error page, storing nothing', async () => {
    const id = await createGarment(t, { name: 'Refused photo shirt' });
    const body = await multipart(
      {},
      {
        photo: {
          data: Buffer.from('plain words'),
          filename: 'notes.txt',
          contentType: 'text/plain',
        },
      },
    );
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/${id}/photo`,
      payload: body.payload,
      headers: body.headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.body).toContain('Wrong filetype');
    expect((await garmentRow(t, id))!.photoId).toBeNull();
  });

  it('swaps the cutout in once the queue has made it, and stops polling', async () => {
    const id = await createGarment(t, { name: 'Ready shirt' });
    await uploadPhoto(t, id, await jpegPhoto());
    const fileName = await photoFileName(t, id);
    expect(unescapeHtml((await fragment(id)).body)).toContain(
      'hx-trigger="every 2s"',
    );

    t.cutouts.start(fakeRunner());
    await t.cutouts.whenIdle();

    const res = await fragment(id);
    expectFragment(res);
    const html = unescapeHtml(res.body);
    expect(html).toMatch(/^<div id="garment-photo">/);
    expect(html).not.toContain('hx-trigger');
    // The new set's URL: version 2 under the key the job stored it as.
    const row = await photoRow(t, fileName);
    const nobgUrl = imageUrl(
      readPhotoRef({ fileName, version: 2, variantKey: row!.variantKey }),
      'nobg',
    );
    expect(row!.variantKey).toMatch(/^[0-9a-f]{12}$/);
    expect(html).toContain(`src="${nobgUrl}"`);
    expect(html).toContain(`data-nobg-url="${nobgUrl}"`);
    expect(html).toContain(`data-save-url="/wardrobe/${id}/nobg"`);
    expect(await storedCutout(t, fileName)).toBeDefined();
  });

  it("runs each cutout as a job of its own, naming the upload's request as its parent", async () => {
    const id = await createGarment(t, { name: 'Traced shirt' });
    await uploadPhoto(t, id, await jpegPhoto());
    const fileName = await photoFileName(t, id);
    const queued = t.logs.records.find(
      (record) =>
        record.msg ===
        `Garment ${id} photo ${fileName} queued for background removal`,
    );
    const requestId = queued?.request_id;
    expect(requestId).toMatch(/^[0-9a-f]{12}$/);
    expect((await photoRow(t, fileName))!.cutoutRequestId).toBe(requestId);

    t.cutouts.start(fakeRunner());
    await t.cutouts.whenIdle();

    const job = t.logs.records.filter(
      (record) =>
        record.logger === 'Cutout' &&
        record.msg.includes(`(${fileName.slice(0, 8)})`),
    );
    expect(job.map((record) => record.msg)).toEqual([
      expect.stringMatching(/^Cutout started: /),
      expect.stringMatching(/^Cutout ready: /),
    ]);
    const [started, ready] = job;
    expect(started.job_id).toMatch(/^cutout-[0-9a-f]{12}$/);
    expect(ready).toMatchObject({
      job_id: started.job_id,
      parent_request_id: requestId,
    });
    expect(ready).not.toHaveProperty('request_id');
  });

  it('shows a failed cutout with a native-post "Try again" that requeues it', async () => {
    const id = await createGarment(t, { name: 'Failed shirt' });
    await uploadPhoto(t, id, await jpegPhoto());
    const fileName = await photoFileName(t, id);
    t.cutouts.start(
      fakeRunner((call) => {
        if (call === 1) throw new Error('model exploded');
        return halfMask();
      }),
    );
    await t.cutouts.whenIdle();

    const failed = await fragment(id);
    const html = unescapeHtml(failed.body);
    expect(html).not.toContain('hx-trigger');
    expect(html).toContain('The background could not be removed.');
    expect(html).toContain(
      `<form method="post" action="/wardrobe/${id}/cutout/retry" hx-boost="false" data-needs-network="" data-submit-once="">`,
    );
    // The original shows, and the user may still clear it by hand.
    expect(html).toContain('id="editMaskBtn"');
    expectNativePostForms(await page(id));

    const retry = await t.inject({
      method: 'POST',
      url: `/wardrobe/${id}/cutout/retry`,
    });
    expect(retry.statusCode).toBe(303);
    expect(retry.headers.location).toBe(`/wardrobe/${id}`);
    await t.cutouts.whenIdle();
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'ready',
      cutoutAttempts: 2,
    });

    // A retry of a ready cutout changes nothing.
    await t.inject({ method: 'POST', url: `/wardrobe/${id}/cutout/retry` });
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'ready',
    });
  });

  // Pages an installed PWA cached before background removal moved to the
  // server post the browser's cutout with the photo, in either order.
  it.each([
    ['after', ['photo', 'nobgPhoto']],
    ['before', ['nobgPhoto', 'photo']],
  ] as const)(
    'ignores a cutout sent %s the photo by a page cached before the server made them, and queues its own',
    async (_order, fields) => {
      const id = await createGarment(t, { name: `Old page shirt ${_order}` });
      const parts = {
        photo: {
          data: await jpegPhoto(),
          filename: 'photo.jpg',
          contentType: 'image/jpeg',
        },
        nobgPhoto: {
          data: await pngCutout(),
          filename: 'nobg.webp',
          contentType: 'image/webp',
        },
      };
      const body = await multipart(
        {},
        Object.fromEntries(fields.map((field) => [field, parts[field]])),
      );
      // Those pages hx-post, and wait for the HX-Redirect.
      const res = await t.inject({
        method: 'POST',
        url: `/wardrobe/${id}/photo`,
        payload: body.payload,
        headers: { ...body.headers, ...HX_FRAGMENT },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['hx-redirect']).toBe(`/wardrobe/${id}?photoSaved=1`);
      const fileName = await photoFileName(t, id);
      expect(await photoRow(t, fileName)).toMatchObject({
        cutoutStatus: 'pending',
      });
      expect(await storedCutout(t, fileName)).toBeUndefined();
      expect(t.logs.messages('info', 'Photos')).toContainEqual(
        expect.stringMatching(/ignored the browser's cutout/),
      );
    },
  );

  it('refuses a cutout without its photo, storing nothing', async () => {
    const id = await createGarment(t, { name: 'Lone cutout shirt' });
    const body = await multipart(
      {},
      {
        nobgPhoto: {
          data: await pngCutout(),
          filename: 'nobg.webp',
          contentType: 'image/webp',
        },
      },
    );
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/${id}/photo`,
      payload: body.payload,
      headers: body.headers,
    });
    expect(res.statusCode).toBe(400);
    expect((await garmentRow(t, id))?.photo).toBeNull();
  });

  it('shows a photo stored before server-side removal as it is: no polling, the pencil', async () => {
    const id = await createGarment(t, { name: 'Legacy shirt' });
    await uploadPhoto(t, id, await jpegPhoto());
    const fileName = await photoFileName(t, id);
    await asFixture(t.db, (tx) =>
      tx
        .update(file)
        .set({ cutoutStatus: 'none', cutoutRequestedAt: null })
        .where(eq(file.fileName, fileName)),
    );

    const html = unescapeHtml((await page(id)).body);
    expect(html).toContain('<div id="garment-photo">');
    expect(html).not.toContain('hx-trigger="every 2s"');
    expect(html).toContain('id="editMaskBtn"');
  });

  it('queues the copy of a pending photo when the garment is cloned', async () => {
    const id = await createGarment(t, { name: 'Cloned shirt' });
    await uploadPhoto(t, id, await jpegPhoto());
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/${id}/clone`,
      payload: { name: 'Cloned shirt copy', category: 'shirt' },
    });
    expect(res.statusCode).toBe(302);
    const cloneId = Number(/\/wardrobe\/(\d+)/.exec(res.headers.location!)![1]);
    const clone = await garmentRow(t, cloneId);
    expect(clone?.photo).toMatchObject({
      cutoutStatus: 'pending',
      cutoutAttempts: 0,
    });
  });

  it('answers the fragment for a garment the requester cannot see with a 404', async () => {
    const id = await createGarment(t, { name: 'Private shirt' });
    const stranger = await t.register('stranger@example.com');
    const res = await t.inject({
      method: 'GET',
      url: `/wardrobe/${id}/cutout`,
      headers: { ...HX_FRAGMENT, cookie: stranger },
    });
    expect(res.statusCode).toBe(404);
  });
});
