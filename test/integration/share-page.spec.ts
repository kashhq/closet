import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment, outfit, user, wardrobeShare } from '../../src/db/schema';
import { t as translate } from '../../src/web/i18n';
import { setPublicShare } from '../../src/web/share/queries';
import { createInvite } from '../../src/web/sharing/queries';
import { createGarment } from './garments';
import {
  createTestApp,
  OWNER_EMAIL,
  TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import { interleave } from './interleave';
import { createPageFixture, expectFullPage, PageFixture } from './pages';

/**
 * GET /share: the public landing page of a share link and the Open Graph
 * tags link-preview crawlers read from it; and the link as a state (#669):
 * none until Share is tapped, gone with its watermark after Stop sharing,
 * a new one after sharing again. Rendering of both types is also covered
 * by pages.spec.ts; this pins what the preview says.
 */
describe('share page', () => {
  let t: TestApp;
  let f: PageFixture;

  const meta = (html: string, property: string) =>
    new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)"`).exec(
      unescapeHtml(html),
    )?.[1];

  const open = (url: string) =>
    t.inject({ method: 'GET', url, anonymous: true });

  const shareUrl = (shareableId: string, type: string) =>
    `/share?shareableId=${shareableId}&type=${type}`;

  const post = (url: string, cookie?: string) =>
    t.inject({
      method: 'POST',
      url,
      ...(cookie ? { headers: { cookie } } : {}),
    });

  const garmentShareId = async (id: number) =>
    (
      await t.db
        .select({ shareableId: garment.shareableId })
        .from(garment)
        .where(eq(garment.id, id))
    )[0].shareableId;

  const outfitShareId = async (id: number) =>
    (
      await t.db
        .select({ shareableId: outfit.shareableId })
        .from(outfit)
        .where(eq(outfit.id, id))
    )[0].shareableId;

  /** The /share page found nothing: the empty page, a 404. */
  const expectGone = async (url: string) => {
    const res = await open(url);
    expect(res.statusCode, url).toBe(404);
    expectFullPage(res);
    expect(res.body).not.toContain('Shared by');
    return res;
  };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createPageFixture(t);
  });

  afterAll(() => t?.cleanup());

  it("previews a garment with its name and watermarked photo, never its owner's email", async () => {
    const url = shareUrl(f.garmentShareableId, 'garment');
    const res = await open(url);
    expect(res.statusCode).toBe(200);
    expectFullPage(res);
    expect(res.body).toContain('Black Linen Blazer');
    // The owner set no first name: the page names nobody.
    expect(res.body).not.toContain(OWNER_EMAIL);
    expect(res.body).not.toContain('Shared by');
    expect(meta(res.body, 'og:title')).toBe('Black Linen Blazer');
    expect(meta(res.body, 'og:description')).toBe(translate('APP_DESCRIPTION'));
    expect(meta(res.body, 'og:url')).toBe(`http://localhost${url}`);
    // The image is addressed by the garment's own share id, not its photo's.
    expect(meta(res.body, 'og:image')).toBe(
      `http://localhost/file/watermark/${f.garmentShareableId}`,
    );

    const image = await open(`/file/watermark/${f.garmentShareableId}`);
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/jpeg');
    // Short-lived, so a stopped image leaves a browser's or proxy's cache soon.
    expect(image.headers['cache-control']).toBe('public, max-age=300');
  });

  it("previews an outfit with its first garment's photo, by the outfit's id", async () => {
    const res = await open(shareUrl(f.outfitShareableId, 'outfit'));
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(OWNER_EMAIL);
    expect(res.body).toContain('Office look');
    expect(res.body).toContain('/file/thumb/');
    // The owner's selfie of it (#19) is theirs alone: not on the public page.
    expect(res.body).not.toContain(f.selfieFileName);
    expect(res.body).not.toContain('/selfies/');
    expect(meta(res.body, 'og:title')).toBe('Office look');
    expect(meta(res.body, 'og:image')).toBe(
      `http://localhost/file/watermark/${f.outfitShareableId}`,
    );
    expect(
      (await open(`/file/watermark/${f.outfitShareableId}`)).statusCode,
    ).toBe(200);
  });

  it('names the owner by first name when they set one, page and preview alike', async () => {
    await t.db
      .update(user)
      .set({ firstName: ' Ada ' })
      .where(eq(user.id, t.owner.id));
    try {
      for (const url of [
        shareUrl(f.garmentShareableId, 'garment'),
        shareUrl(f.outfitShareableId, 'outfit'),
      ]) {
        const res = await open(url);
        expect(res.body).toContain('Shared by Ada</p>');
        expect(meta(res.body, 'og:description')).toBe('Shared by Ada');
        expect(meta(res.body, 'twitter:description')).toBe('Shared by Ada');
        expect(res.body).not.toContain(OWNER_EMAIL);
      }
    } finally {
      await t.db
        .update(user)
        .set({ firstName: null })
        .where(eq(user.id, t.owner.id));
    }
  });

  it('falls back to the app icon for a garment without a photo, and serves no watermark', async () => {
    const garmentId = await createGarment(t, { name: 'Plain scarf' });
    expect((await post(`/wardrobe/${garmentId}/share`)).statusCode).toBe(200);
    const shareableId = (await garmentShareId(garmentId))!;
    const res = await open(shareUrl(shareableId, 'garment'));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Plain scarf');
    expect(meta(res.body, 'og:image')).toBe('http://localhost/assets/icon.png');
    expect((await open(`/file/watermark/${shareableId}`)).statusCode).toBe(404);
  });

  it('a new garment has no public link until Share is tapped; Stop ends the link and its image, and sharing again mints another', async () => {
    const garmentId = await createGarment(t, { name: 'Quiet coat' });
    expect(await garmentShareId(garmentId)).toBeNull();
    const before = await t.inject({
      method: 'GET',
      url: `/wardrobe/${garmentId}`,
    });
    expect(before.body).not.toContain('data-public-share');

    const shared = await post(`/wardrobe/${garmentId}/share`);
    expect(shared.statusCode).toBe(200);
    expect(JSON.parse(shared.headers['hx-location'] as string).path).toBe(
      `/wardrobe/${garmentId}`,
    );
    const first = (await garmentShareId(garmentId))!;
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect((await open(shareUrl(first, 'garment'))).statusCode).toBe(200);
    const page = unescapeHtml(
      (await t.inject({ method: 'GET', url: `/wardrobe/${garmentId}` })).body,
    );
    expect(page).toContain('data-public-share');
    expect(page).toContain(`/share?shareableId=${first}&type=garment`);
    expect(page).toContain(`hx-post="/wardrobe/${garmentId}/share/stop"`);
    // A second tap keeps the link it made.
    await post(`/wardrobe/${garmentId}/share`);
    expect(await garmentShareId(garmentId)).toBe(first);

    expect((await post(`/wardrobe/${garmentId}/share/stop`)).statusCode).toBe(
      200,
    );
    expect(await garmentShareId(garmentId)).toBeNull();
    await expectGone(shareUrl(first, 'garment'));

    await post(`/wardrobe/${garmentId}/share`);
    const second = (await garmentShareId(garmentId))!;
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
    await expectGone(shareUrl(first, 'garment'));
    expect(t.logs.ops('garment.share.set')).toContainEqual(
      expect.objectContaining({ garmentId, shared: false }),
    );
  });

  // The last test of the fixture's garment link: it is stopped for good.
  it("Stop on the fixture's garment ends its watermark too, and leaves the outfit holding it shared", async () => {
    expect(await garmentShareId(f.garmentId)).toBe(f.garmentShareableId);
    await post(`/wardrobe/${f.garmentId}/share/stop`);
    await expectGone(shareUrl(f.garmentShareableId, 'garment'));
    expect(
      (await open(`/file/watermark/${f.garmentShareableId}`)).statusCode,
    ).toBe(404);
    // The outfit is shared on its own: its page and image stay, the
    // image still its first garment's photo.
    expect(
      (await open(shareUrl(f.outfitShareableId, 'outfit'))).statusCode,
    ).toBe(200);
    expect(
      (await open(`/file/watermark/${f.outfitShareableId}`)).statusCode,
    ).toBe(200);
  });

  it('an outfit starts unshared and is shared and stopped by its owner alone', async () => {
    const garmentId = await createGarment(t, { name: 'Lone tee' });
    const created = await t.inject({
      method: 'POST',
      url: '/outfits',
      payload: {
        name: 'Lone outfit',
        category: 'shirt',
        garmentId: String(garmentId),
      },
    });
    expect(created.statusCode).toBe(302);
    const outfitId = Number(
      /^\/outfits\/(\d+)$/.exec(created.headers.location as string)?.[1],
    );
    expect(await outfitShareId(outfitId)).toBeNull();
    await post(`/outfits/${outfitId}/share`);
    const id = (await outfitShareId(outfitId))!;
    expect((await open(shareUrl(id, 'outfit'))).statusCode).toBe(200);
    await post(`/outfits/${outfitId}/share/stop`);
    await expectGone(shareUrl(id, 'outfit'));
    expect((await open(`/file/watermark/${id}`)).statusCode).toBe(404);
  });

  it('two Shares racing on the owner lock answer one id', async () => {
    const garmentId = await createGarment(t, { name: 'Raced tee' });
    const [first, second] = await interleave(
      t.db,
      (tx) => setPublicShare(tx, 'garment', garmentId, t.owner.id, true),
      () => setPublicShare(t.db, 'garment', garmentId, t.owner.id, true),
    );
    expect(first?.shareableId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second?.shareableId).toBe(first?.shareableId);
  });

  it("a MANAGE grantee's link outlives their share, shown on the owner's page with Stop", async () => {
    const email = `share-grantee-${randomUUID().slice(0, 8)}@example.com`;
    const cookie = await t.register(email);
    const granteeId = await userIdOf(t, email);
    const { inviteToken } = await createInvite(t.db, t.owner.id, 'MANAGE');
    expect(
      (await post(`/wardrobe-share/invite/${inviteToken}/accept`, cookie))
        .statusCode,
    ).toBe(302);
    const garmentId = await createGarment(t, { name: 'Lent jacket' });
    expect(
      (await post(`/wardrobe/${garmentId}/share?ownerId=${t.owner.id}`, cookie))
        .statusCode,
    ).toBe(200);
    const minted = (await garmentShareId(garmentId))!;

    const [share] = await t.db
      .select({ id: wardrobeShare.id })
      .from(wardrobeShare)
      .where(eq(wardrobeShare.granteeId, granteeId));
    expect(
      (await post(`/wardrobe-share/${share.id}/remove`)).statusCode,
    ).toBeLessThan(400);

    expect((await open(shareUrl(minted, 'garment'))).statusCode).toBe(200);
    const page = unescapeHtml(
      (await t.inject({ method: 'GET', url: `/wardrobe/${garmentId}` })).body,
    );
    expect(page).toContain(translate('publicShare.SHARED_PUBLICLY'));
    expect(page).toContain(`/share?shareableId=${minted}&type=garment`);
    expect(page).toContain(`hx-post="/wardrobe/${garmentId}/share/stop"`);
    // The former grantee can no longer stop it, or reach the garment.
    expect(
      (
        await post(
          `/wardrobe/${garmentId}/share/stop?ownerId=${t.owner.id}`,
          cookie,
        )
      ).statusCode,
    ).toBe(404);
  });

  it.each([
    '/share?shareableId=nothing&type=garment',
    '/share?shareableId=nothing&type=file',
    // A stopped row's id is NULL: neither spelling of it finds one.
    '/share?shareableId=null&type=garment',
    '/share?shareableId=null&type=outfit',
    '/share?shareableId=&type=garment',
    '/share?type=outfit',
    '/share',
  ])('%s is the empty page, a 404', async (url) => {
    await expectGone(url);
  });

  it.each(['nothing', 'null'])('/file/watermark/%s is a 404', async (id) => {
    expect((await open(`/file/watermark/${id}`)).statusCode).toBe(404);
  });
});
