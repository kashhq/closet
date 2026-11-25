import { eq } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { file } from '../../src/db/schema';
import type { Readiness } from '../../src/web/health/checks';
import { variantFileName } from '../../src/web/files/image-variant';
import { deviceToken } from './api';
import { fakeRunner } from './cutouts';
import {
  createGarment,
  jpegPhoto,
  photoFileName,
  photoRow,
  uploadPhoto,
} from './garments';
import {
  asFixture,
  createTestApp,
  multipart,
  type TestApp,
  unescapeHtml,
} from './harness';
import { HX_FRAGMENT } from './pages';

/**
 * CUTOUT_ENABLED=false (#690): uploads start `none` (the original with the
 * mask editor's pencil), nothing is ever queued, and readiness calls the
 * queue disabled. That no model is fetched is boot.spec.ts's: the harness
 * never boots main.ts.
 */
describe('cutouts switched off', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ CUTOUT_ENABLED: 'false' });
  });

  afterAll(() => t?.cleanup());

  it('keeps an upload as taken: none, no job, the pencil and no polling', async () => {
    const id = await createGarment(t, { name: 'Plain shirt' });
    await uploadPhoto(t, id, await jpegPhoto());
    const fileName = await photoFileName(t, id);

    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'none',
      cutoutAttempts: 0,
      cutoutRequestedAt: null,
    });
    const html = unescapeHtml(
      (await t.inject({ method: 'GET', url: `/wardrobe/${id}` })).body,
    );
    expect(html).toContain('id="editMaskBtn"');
    expect(html).not.toContain('Cutting out the background');
    expect(html).not.toContain(`/wardrobe/${id}/cutout?poll=`);
  });

  // Rows from before the switch: shown as none (no spinner, poll or retry),
  // never rewritten, and "Try again" posted by hand changes nothing.
  it.each(['pending', 'failed'] as const)(
    'shows a %s cutout as none and leaves its row alone',
    async (status) => {
      const id = await createGarment(t, { name: `Old ${status}` });
      await uploadPhoto(t, id, await jpegPhoto());
      const fileName = await photoFileName(t, id);
      await asFixture(t.db, (tx) =>
        tx
          .update(file)
          .set({
            cutoutStatus: status,
            cutoutRequestedAt: status === 'pending' ? new Date() : null,
          })
          .where(eq(file.fileName, fileName)),
      );

      for (const url of [`/wardrobe/${id}`, `/wardrobe/${id}/cutout`]) {
        const html = unescapeHtml(
          (await t.inject({ method: 'GET', url, headers: HX_FRAGMENT })).body,
        );
        expect(html).toContain('id="editMaskBtn"');
        expect(html).not.toContain('Cutting out the background');
        expect(html).not.toContain('/cutout?poll=');
        expect(html).not.toContain('/cutout/retry');
      }
      const retry = await t.inject({
        method: 'POST',
        url: `/wardrobe/${id}/cutout/retry`,
      });
      expect(retry.statusCode).toBe(303);
      expect(await photoRow(t, fileName)).toMatchObject({
        cutoutStatus: status,
      });
    },
  );

  // A cutout made while removal was on survives a turn: it is never
  // re-cut now, so dropping it would lose it for good.
  it('turns a ready cutout along with its photo, never downgrading it', async () => {
    const id = await createGarment(t, { name: 'Ready shirt' });
    await uploadPhoto(t, id, await jpegPhoto());
    const before = await photoFileName(t, id);
    const mask = await sharp({
      create: {
        width: 1080,
        height: 720,
        channels: 4,
        background: { r: 200, g: 30, b: 30, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const body = await multipart(
      {},
      {
        nobgPhoto: { data: mask, filename: 'c.png', contentType: 'image/png' },
      },
    );
    const saved = await t.inject({
      method: 'POST',
      url: `/wardrobe/${id}/nobg`,
      payload: body.payload,
      headers: body.headers,
    });
    expect(saved.statusCode).toBe(200);
    await asFixture(t.db, (tx) =>
      tx
        .update(file)
        .set({ cutoutStatus: 'ready' })
        .where(eq(file.fileName, before)),
    );

    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/${id}/photo/rotate`,
      payload: { direction: 'right' },
    });
    expect(res.statusCode).toBe(303);
    const after = await photoFileName(t, id);
    expect(after).not.toBe(before);
    expect(await photoRow(t, after)).toMatchObject({ cutoutStatus: 'edited' });
    expect(existsSync(join(t.dataPath, variantFileName(after, 'nobg')))).toBe(
      true,
    );
  });

  // The common case: an upload made while removal is off has no cutout
  // file, so the turn has nothing to carry and the photo stays `none`.
  it('turns a plain none photo and keeps it none', async () => {
    const id = await createGarment(t, { name: 'Plain turn' });
    await uploadPhoto(t, id, await jpegPhoto());
    const before = await photoFileName(t, id);
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/${id}/photo/rotate`,
      payload: { direction: 'left' },
    });
    expect(res.statusCode).toBe(303);
    const after = await photoFileName(t, id);
    expect(after).not.toBe(before);
    expect(await photoRow(t, after)).toMatchObject({ cutoutStatus: 'none' });
    expect(existsSync(join(t.dataPath, variantFileName(after, 'nobg')))).toBe(
      false,
    );
  });

  // The API and the changes feed agree with the page: nothing to poll for.
  it('answers none, never pending or failed, on the API and the feed', async () => {
    const { token } = await deviceToken(t);
    const ids: Record<string, number> = {};
    for (const status of ['pending', 'failed'] as const) {
      const id = await createGarment(t, { name: `Api ${status}` });
      await uploadPhoto(t, id, await jpegPhoto());
      const fileName = await photoFileName(t, id);
      await asFixture(t.db, (tx) =>
        tx
          .update(file)
          .set({
            cutoutStatus: status,
            cutoutRequestedAt: status === 'pending' ? new Date() : null,
          })
          .where(eq(file.fileName, fileName)),
      );
      ids[status] = id;
    }
    const one = await t.api(token, {
      method: 'GET',
      url: `/api/v1/garments/${ids.pending}`,
    });
    expect(
      one.json<{ photo: { cutoutStatus: string } }>().photo.cutoutStatus,
    ).toBe('none');
    const list = await t.api(token, { method: 'GET', url: '/api/v1/garments' });
    const listed = list.json<{
      data: { id: number; photo?: { cutoutStatus: string } }[];
    }>().data;
    for (const id of Object.values(ids)) {
      expect(listed.find((g) => g.id === id)?.photo?.cutoutStatus).toBe('none');
    }
    const feed = await t.api(token, {
      method: 'GET',
      url: '/api/v1/changes',
    });
    const changed = feed
      .json<{
        changes: {
          resource: string;
          id: number;
          data: { photo?: { cutoutStatus: string } };
        }[];
      }>()
      .changes.filter((c) => c.resource === 'garment');
    for (const id of Object.values(ids)) {
      expect(changed.find((c) => c.id === id)?.data.photo?.cutoutStatus).toBe(
        'none',
      );
    }
  });

  it('refuses a runner and reports the queue disabled, not down', async () => {
    expect(t.cutouts.enabled).toBe(false);
    expect(() => t.cutouts.start(fakeRunner())).toThrow(
      'The cutout queue cannot start while disabled',
    );
    const res = await t.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json<Readiness>().checks.cutout_queue).toEqual({
      status: 'up',
      required: false,
      disabled: true,
    });
  });
});
