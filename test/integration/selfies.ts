import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { expect } from 'vitest';
import { file, outfitCalendar, selfie } from '../../src/db/schema';
import type { IsoDate } from '../../src/calendar-date';
import { multipart, type TestApp } from './harness';

/**
 * Outfit selfies (#19) for the integration specs, through the requests the
 * pages make: an outfit planned on a day (POST /calendar), a photo taken
 * for its entry (POST /calendar/:id/selfie, multipart).
 */

/** A portrait "mirror photo": opaque, as a phone's camera takes it. */
export function mirrorPhoto(width = 600, height = 800): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: '#b8a48c' },
  })
    .jpeg()
    .toBuffer();
}

/** The outfit planned on `day` as the plan page posts it; the entry's id. */
export async function planEntry(
  t: TestApp,
  outfitId: number,
  day: IsoDate,
  cookie?: string,
): Promise<number> {
  const res = await t.inject({
    method: 'POST',
    url: '/calendar',
    payload: { date: day, outfitId: String(outfitId) },
    headers: cookie ? { cookie } : {},
  });
  expect(res.statusCode).toBe(302);
  const [entry] = await t.db
    .select({ id: outfitCalendar.id })
    .from(outfitCalendar)
    .where(
      and(eq(outfitCalendar.outfitId, outfitId), eq(outfitCalendar.day, day)),
    );
  return entry.id;
}

/** POST /calendar/:id/selfie with a multipart `photo`, as the camera button posts it. */
export async function postSelfie(
  t: TestApp,
  entryId: number,
  photo: { data: Buffer; filename?: string; contentType?: string },
  { cookie, returnTo }: { cookie?: string; returnTo?: string } = {},
) {
  const body = await multipart(
    {},
    {
      photo: {
        data: photo.data,
        filename: photo.filename ?? 'selfie.jpg',
        contentType: photo.contentType ?? 'image/jpeg',
      },
    },
  );
  const query = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : '';
  return t.inject({
    method: 'POST',
    url: `/calendar/${entryId}/selfie${query}`,
    payload: body.payload,
    headers: { ...body.headers, ...(cookie ? { cookie } : {}) },
  });
}

/** postSelfie that must succeed; the entry's selfie as stored. */
export async function takeSelfie(
  t: TestApp,
  entryId: number,
  cookie?: string,
): Promise<{ id: number; fileName: string }> {
  const res = await postSelfie(
    t,
    entryId,
    { data: await mirrorPhoto() },
    {
      cookie,
    },
  );
  expect(res.statusCode).toBe(303);
  const stored = await selfieOf(t, entryId);
  if (!stored) throw new Error(`No selfie for entry ${entryId}`);
  return stored;
}

/** The entry's selfie with its photo's names, undefined without one. */
export async function selfieOf(t: TestApp, entryId: number) {
  const [row] = await t.db
    .select({
      id: selfie.id,
      fileName: file.fileName,
    })
    .from(selfie)
    .innerJoin(file, eq(file.id, selfie.photoId))
    .where(eq(selfie.outfitCalendarId, entryId));
  return row;
}
