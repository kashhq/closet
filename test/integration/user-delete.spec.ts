import { loginUrl } from '../../src/web/auth/return-to';
import { eq, inArray, type SQL } from 'drizzle-orm';
import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { file, garment, inspiration, selfie, user } from '../../src/db/schema';
import { insertPhotoRow } from '../../src/web/files/queries';
import { variantFileName } from '../../src/web/files/image-variant';
import {
  createGarment,
  jpegPhoto,
  photoFileName,
  photoRow,
  photoRowCount,
  uploadPhoto,
} from './garments';
import {
  asFixture,
  createTestApp,
  multipart,
  TEST_PASSWORD,
  TestApp,
  userIdOf,
} from './harness';

/**
 * Deleting an account removes the user's photos from storage, not only the
 * rows the database cascade drops.
 */
describe('account deletion', () => {
  let t: TestApp;
  const email = 'carol@example.com';
  const bystanderEmail = 'dave@example.com';

  const accounts = (where: SQL) => t.db.$count(user, where);

  const storedFiles = async () =>
    (await readdir(t.dataPath)).filter((name) => name.endsWith('.webp'));

  const deleteAccount = (cookie: string, payload: Record<string, string>) =>
    t.inject({
      method: 'POST',
      url: '/auth/delete-account',
      headers: { cookie },
      payload,
    });

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  it('removes the user, their garments, their File rows and every stored variant', async () => {
    const cookie = await t.register(email);
    const bystanderCookie = await t.register(bystanderEmail);
    const garmentId = await createGarment(t, { name: 'Coat', cookie });
    await uploadPhoto(t, garmentId, await jpegPhoto(), cookie);
    const bystanderGarment = await createGarment(t, {
      name: 'Hat',
      cookie: bystanderCookie,
    });
    await uploadPhoto(t, bystanderGarment, await jpegPhoto(), bystanderCookie);

    const userId = await userIdOf(t, email);
    const fileName = await photoFileName(t, garmentId);
    const bystanderFile = await photoFileName(t, bystanderGarment);
    expect(await storedFiles()).toEqual(
      expect.arrayContaining([fileName, variantFileName(fileName, 'thumb')]),
    );

    // The confirmation must be this account's own credentials.
    const wrongPassword = await deleteAccount(cookie, {
      email,
      password: 'not-the-password',
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongPassword.headers.location).toBeUndefined();
    const someoneElse = await deleteAccount(cookie, {
      email: bystanderEmail,
      password: TEST_PASSWORD,
    });
    expect(someoneElse.statusCode).toBe(401);
    expect(someoneElse.headers.location).toBeUndefined();
    const malformed = await deleteAccount(cookie, { email });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.headers.location).toBeUndefined();
    expect(await accounts(eq(user.id, userId))).toBe(1);
    expect(await accounts(eq(user.email, bystanderEmail))).toBe(1);

    const res = await deleteAccount(cookie, { email, password: TEST_PASSWORD });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const cleared = res.cookies.find((c) => c.name === 'access_token');
    expect(cleared?.value).toBe('');

    expect(await accounts(eq(user.id, userId))).toBe(0);
    expect(await t.db.$count(garment, eq(garment.ownerId, userId))).toBe(0);
    expect(await photoRowCount(t, userId)).toBe(0);
    expect(await photoRow(t, fileName)).toBeUndefined();
    const files = await storedFiles();
    expect(files).not.toContain(fileName);
    expect(files).not.toContain(variantFileName(fileName, 'thumb'));
    expect(files).not.toContain(variantFileName(fileName, 'nobg'));

    // The other household member is untouched.
    expect(await photoRow(t, bystanderFile)).toBeDefined();
    expect(files).toContain(bystanderFile);

    // The old session is dead.
    const profile = await t.inject({
      method: 'GET',
      url: '/auth/profile',
      headers: { cookie },
    });
    expect(profile.statusCode).toBe(302);
    expect(profile.headers.location).toBe(loginUrl('/auth/profile'));
  });

  // Before #40 a MANAGE grantee's upload made a file row of the grantee's,
  // and their account deletion emptied the owner's garment and unlinked
  // its bytes. The upload is the owner's row, and the photo foreign key
  // pairs photo_id with owner_id, so it can never be otherwise (#703).
  it("a MANAGE grantee's deletion keeps the photo they uploaded into the owner's wardrobe", async () => {
    const granteeEmail = 'grantee-uploader@example.com';
    const granteeCookie = await t.register(granteeEmail);
    const grantee = await userIdOf(t, granteeEmail);
    const invite = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission: 'MANAGE', currentPassword: TEST_PASSWORD },
      headers: { 'hx-request': 'true' },
    });
    const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
      invite.body,
    )![1];
    await t.inject({
      method: 'POST',
      url: `/wardrobe-share/invite/${token}/accept`,
      headers: { cookie: granteeCookie },
    });
    const owner = t.owner.id;
    const coat = await createGarment(t, { name: 'Shared coat' });
    const body = await multipart(
      {},
      {
        photo: {
          data: await jpegPhoto(),
          filename: 'photo.jpg',
          contentType: 'image/jpeg',
        },
      },
    );
    const upload = await t.inject({
      method: 'POST',
      url: `/wardrobe/${coat}/photo?ownerId=${owner}`,
      payload: body.payload,
      headers: { ...body.headers, cookie: granteeCookie },
    });
    expect(upload.statusCode).toBe(303);
    const fileName = await photoFileName(t, coat);
    expect(await photoRow(t, fileName)).toMatchObject({ createdById: owner });

    const res = await deleteAccount(granteeCookie, {
      email: granteeEmail,
      password: TEST_PASSWORD,
    });
    expect(res.statusCode).toBe(302);
    expect(await accounts(eq(user.id, grantee))).toBe(0);
    expect(await photoFileName(t, coat)).toBe(fileName);
    expect(await storedFiles()).toContain(fileName);
  });

  // The pair's delete actions (#703): a garment's photo going empties the
  // garment and keeps its owner (SET NULL on photo_id alone, hand-written
  // in drizzle/0065); a selfie or a look goes with its photo.
  it('deleting a photo row empties its garment and takes its selfie or look', async () => {
    const owner = t.owner.id;
    const shirt = await createGarment(t, { name: 'Photo shirt' });
    const ids = await asFixture(t.db, async (tx) => {
      const photo = () =>
        insertPhotoRow(tx, {
          fileName: `${randomUUID()}.webp`,
          createdOn: new Date().toISOString(),
          createdById: owner,
        });
      const shirtPhoto = await photo();
      await tx
        .update(garment)
        .set({ photoId: shirtPhoto })
        .where(eq(garment.id, shirt));
      const selfiePhoto = await photo();
      const [{ id: selfieId }] = await tx
        .insert(selfie)
        .values({ ownerId: owner, day: t.today(), photoId: selfiePhoto })
        .returning({ id: selfie.id });
      const lookPhoto = await photo();
      const [{ id: lookId }] = await tx
        .insert(inspiration)
        .values({ ownerId: owner, photoId: lookPhoto })
        .returning({ id: inspiration.id });
      return { shirtPhoto, selfiePhoto, lookPhoto, selfieId, lookId };
    });

    await asFixture(t.db, (tx) =>
      tx
        .delete(file)
        .where(
          inArray(file.id, [ids.shirtPhoto, ids.selfiePhoto, ids.lookPhoto]),
        ),
    );
    const [shirtRow] = await t.db
      .select({ photoId: garment.photoId, ownerId: garment.ownerId })
      .from(garment)
      .where(eq(garment.id, shirt));
    expect(shirtRow).toEqual({ photoId: null, ownerId: owner });
    expect(await t.db.$count(selfie, eq(selfie.id, ids.selfieId))).toBe(0);
    expect(await t.db.$count(inspiration, eq(inspiration.id, ids.lookId))).toBe(
      0,
    );
  });
});
