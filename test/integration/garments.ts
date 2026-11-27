import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { expect } from 'vitest';
import { file, garment } from '../../src/db/schema';
import { multipart, TestApp } from './harness';

/**
 * The two requests the garment pages issue (src/web/wardrobe: the form,
 * then the photo form on the garment page): create the row, then attach the
 * photo. Shared by the wardrobe, mask-edit and share specs.
 */

export function jpegPhoto(width = 1200, height = 800): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: '#4a6' },
  })
    .jpeg()
    .toBuffer();
}

/** A cutout as the mask editor would upload it: PNG with transparency. */
export function pngCutout(width = 600, height = 400): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 200, g: 30, b: 30, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
}

export interface GarmentRequest {
  name: string;
  category?: string;
  brand?: string;
  cookie?: string;
  ownerId?: number;
  /** The product fields' price (posted with their `product` marker). */
  price?: string;
  notes?: string;
}

/** POST /wardrobe; resolves the new garment's id from the redirect. */
export async function createGarment(
  t: TestApp,
  {
    name,
    category = 'shirt',
    brand,
    cookie,
    ownerId,
    price,
    notes,
  }: GarmentRequest,
): Promise<number> {
  const res = await t.inject({
    method: 'POST',
    url: ownerId ? `/wardrobe?ownerId=${ownerId}` : '/wardrobe',
    payload: {
      name,
      category,
      brand,
      notes,
      ...(price !== undefined && { product: '1', price, sourceUrl: '' }),
    },
    headers: cookie ? { cookie } : {},
  });
  expect(res.statusCode).toBe(302);
  const match = /^\/wardrobe\/(\d+)\?/.exec(res.headers.location as string);
  if (!match) {
    throw new Error(`Unexpected create redirect: ${res.headers.location}`);
  }
  return Number(match[1]);
}

export interface WishlistRequest extends GarmentRequest {
  /** The garment it would replace. */
  replaces?: number;
  price?: string;
  sourceUrl?: string;
}

/**
 * POST /wardrobe as the wishlist's form posts it (`to=wishlist` with the
 * wishlist marker and the product fields); resolves the new item's id.
 */
export async function createWishlistItem(
  t: TestApp,
  {
    name,
    category = 'tops',
    brand,
    cookie,
    ownerId,
    replaces,
    price = '',
    sourceUrl = '',
  }: WishlistRequest,
): Promise<number> {
  const res = await t.inject({
    method: 'POST',
    url: ownerId ? `/wardrobe?ownerId=${ownerId}` : '/wardrobe',
    payload: {
      name,
      category,
      brand,
      to: 'wishlist',
      wishlist: '1',
      replaces: replaces === undefined ? '' : String(replaces),
      product: '1',
      price,
      sourceUrl,
    },
    headers: cookie ? { cookie } : {},
  });
  expect(res.statusCode).toBe(302);
  const match = /^\/wardrobe\/(\d+)\?/.exec(res.headers.location as string);
  if (!match) {
    throw new Error(`Unexpected create redirect: ${res.headers.location}`);
  }
  return Number(match[1]);
}

/** POST /wardrobe/:id/photo with a multipart `photo` part. */
export async function uploadPhoto(
  t: TestApp,
  garmentId: number,
  photo: Buffer,
  cookie?: string,
): Promise<void> {
  const body = await multipart(
    {},
    {
      photo: { data: photo, filename: 'photo.jpg', contentType: 'image/jpeg' },
    },
  );
  const res = await t.inject({
    method: 'POST',
    url: `/wardrobe/${garmentId}/photo`,
    payload: body.payload,
    headers: { ...body.headers, ...(cookie ? { cookie } : {}) },
  });
  // The photo sheet's native post lands on the garment, its photo saved.
  expect(res.statusCode).toBe(303);
  expect(res.headers.location).toBe(`/wardrobe/${garmentId}?photoSaved=1`);
}

/** The `file` row of a stored photo, undefined when there is none. */
export function photoRow(t: TestApp, fileName: string) {
  return t.db.query.file.findFirst({ where: eq(file.fileName, fileName) });
}

/** `file` rows, all of them or one user's. */
export function photoRowCount(t: TestApp, createdById?: number) {
  return t.db.$count(
    file,
    createdById === undefined ? undefined : eq(file.createdById, createdById),
  );
}

/** The garment's row with its photo's `file` row (null without a photo); undefined when gone. */
export function garmentRow(t: TestApp, id: number) {
  return t.db.query.garment.findFirst({
    where: eq(garment.id, id),
    with: { photo: true },
  });
}

/** The stored name of the garment's photo (the test fails without one). */
export async function photoFileName(t: TestApp, id: number): Promise<string> {
  const row = await garmentRow(t, id);
  if (!row?.photo) throw new Error(`Garment ${id} has no photo`);
  return row.photo.fileName;
}

/** Garments with this name, in every wardrobe. */
export function garmentsNamed(t: TestApp, name: string) {
  return t.db.$count(garment, eq(garment.name, name));
}
