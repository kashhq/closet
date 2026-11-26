import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment, pendingPhoto } from '../../src/db/schema';
import {
  GUARD_MAX_SETS,
  reconcileStorage,
} from '../../src/maintenance/reconcile';
import {
  parseStoredName,
  unkeyedPhoto,
  variantFileName,
} from '../../src/web/files/image-variant';
import { MAX_PENDING_PER_USER } from '../../src/web/files/pending-photos';
import { type StringKey, t as text } from '../../src/web/i18n';
import {
  createGarment,
  garmentRow,
  jpegPhoto,
  photoFileName,
  photoRowCount,
  uploadPhoto,
} from './garments';
import {
  createTestApp,
  multipart,
  TEST_PASSWORD,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import {
  html,
  INTRANET_HOST,
  jpeg,
  type LinkSites,
  productShot,
  startLinkSites,
  WWW_SHOP_HOST,
} from './link-sites';
import { silentLogger } from './logger';
import { expectFailureTrigger } from './pages';

/**
 * Adding a garment from a link (issue #6): the link page, the import that
 * answers the garment form prefilled, the photo choice, the save that
 * claims the fetched photo, and what happens to a photo nobody saves.
 * Pages and photos are served by a local "shop" (link-sites.ts) through the
 * real outbound fetcher; only its resolver and address policy are the
 * specs' own.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const PRODUCT_PAGE = (images: string[]) => `<!doctype html>
<html><head><title>Heavyweight Pocket Tee | Studio Knit</title>
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Heavyweight Pocket Tee',
  brand: { '@type': 'Brand', name: 'Studio Knit' },
  color: 'Navy',
  material: '100% cotton',
  description: 'A boxy 240 gsm tee with a chest pocket.',
  image: images,
  offers: { '@type': 'Offer', price: '48.00', priceCurrency: 'USD' },
})}</script></head><body><h1>Heavyweight Pocket Tee</h1></body></html>`;

describe('adding a garment from a link', () => {
  let t: TestApp;
  let sites: LinkSites;

  const storedOriginals = async () =>
    (await readdir(t.dataPath))
      .filter((name) => parseStoredName(name)?.variant === 'original')
      .sort();
  const garmentCount = () => t.db.$count(garment);
  const linkPhotoIn = (body: string) =>
    /name="linkPhoto" value="([^"]+)"/.exec(body)?.[1];
  const choicesIn = (body: string) =>
    [...unescapeHtml(body).matchAll(/name="url" value="(http[^"]+)"/g)].map(
      (match) => match[1],
    );
  const previewsIn = (body: string) =>
    body.match(/src="data:image\/webp;base64,/g)?.length ?? 0;

  const importLink = (
    url: string,
    { cookie, ownerId }: { cookie?: string; ownerId?: number } = {},
  ) =>
    t.inject({
      method: 'POST',
      url: `/wardrobe/new/from-link${ownerId ? `?ownerId=${ownerId}` : ''}`,
      payload: { url },
      headers: cookie ? { cookie } : {},
    });

  const choosePhoto = (url: string, linkPhoto?: string) =>
    t.inject({
      method: 'POST',
      url: '/wardrobe/new/from-link/photo',
      payload: { url, ...(linkPhoto ? { linkPhoto } : {}) },
      headers: { 'hx-request': 'true' },
    });

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

  /**
   * A signed-in user of their own: imports are rate limited per user
   * (LINK_IMPORT_LIMIT, 10 a minute), and the owner's share of this spec is
   * close to that, so the busier groups import as someone else.
   */
  const signUp = async (email: string) => {
    const cookie = await t.register(email);
    return { cookie, id: await userIdOf(t, email) };
  };

  /** Runs `work` and asserts it added no garment and no `file` row. */
  const expectNothingWritten = async (work: () => Promise<unknown>) => {
    const [garments, files] = [await garmentCount(), await photoRowCount(t)];
    await work();
    expect(await garmentCount()).toBe(garments);
    expect(await photoRowCount(t)).toBe(files);
  };

  beforeAll(async () => {
    sites = await startLinkSites();
    const [front, back] = await Promise.all([
      productShot('#223355'),
      productShot('#aa3333'),
    ]);
    sites.serve('/img/front.jpg', jpeg(front));
    sites.serve('/img/back.jpg', jpeg(back));
    sites.serve('/img/garbage.jpg', jpeg(Buffer.from('not a jpeg at all')));
    sites.serve(
      '/products/tee',
      html(
        PRODUCT_PAGE([
          sites.url('/img/front.jpg'),
          sites.url('/img/back.jpg'),
          // Not an image: dropped from the choices.
          sites.url('/products/tee'),
        ]),
      ),
    );
    sites.serve(
      '/products/crew',
      html(`<html><head>
        <meta property="og:title" content="Merino Crew Sweater">
        <meta property="og:image" content="/img/front.jpg">
        </head><body></body></html>`),
    );
    sites.serve(
      '/products/sek',
      html(
        `<script type="application/ld+json">${JSON.stringify({
          '@type': 'Product',
          name: 'Wool Overshirt',
          offers: { price: '1299', priceCurrency: 'SEK' },
        })}</script>`,
      ),
    );
    sites.serve(
      '/products/shell',
      html(
        `<title>The World's Most Comfortable Shoes</title><div id="root"></div>`,
      ),
    );
    // A removed product sent to the shop's home page, which has JSON-LD of its own.
    sites.serve('/products/gone', {
      status: 302,
      type: 'text/html',
      body: '',
      headers: { location: sites.url('/') },
    });
    sites.serve(
      '/',
      html(
        `<script type="application/ld+json">${JSON.stringify({
          '@type': 'Product',
          name: 'Shop Outdoor Clothing',
        })}</script>`,
      ),
    );
    sites.serve('/nothing', html('<html><body><p>Hello</p></body></html>'));
    // #347's refusals, as the shops answered them.
    sites.serve('/challenged', {
      status: 403,
      type: 'text/html',
      body: '<title>Just a moment...</title>',
      headers: { 'cf-mitigated': 'challenge' },
    });
    sites.serve('/products/limited', {
      status: 429,
      type: 'text/html',
      body: '<title>Too many requests</title>',
      headers: { 'retry-after': '60' },
    });
    // Asked of www.shop.test, it sends the shop's apex there, as darntough did.
    sites.serve('/www/products/limited', {
      status: 301,
      type: 'text/html',
      body: '',
      headers: { location: sites.url('/products/limited') },
    });
    sites.serve('/waf', {
      status: 202,
      type: 'text/html; charset=UTF-8',
      body: '<title></title><div id="challenge-container"></div>',
      headers: { 'x-amzn-waf-action': 'challenge' },
    });
    sites.serve('/to-the-router', {
      status: 302,
      type: 'text/plain',
      body: '',
      headers: { location: 'http://10.1.2.3/admin' },
    });
    t = await createTestApp({}, { outboundFetch: sites.outboundFetch });
  });

  afterAll(async () => {
    await t?.cleanup();
    await sites?.close();
  });

  describe('the link page', () => {
    it('is offered on the new garment form', async () => {
      const res = await t.inject({ method: 'GET', url: '/wardrobe/new' });
      expect(res.body).toContain('href="/wardrobe/new/from-link"');
      expect(res.body).toContain(text('linkImport.ADD_FROM_LINK'));
    });

    it('takes a shared link from `url` or from inside `text`, and fetches nothing', async () => {
      const link = sites.url('/products/tee');
      const hits = sites.hits.length;
      for (const query of [
        `url=${encodeURIComponent(link)}`,
        `title=Tee&text=${encodeURIComponent(`Look at this: ${link}.`)}`,
      ]) {
        const res = await t.inject({
          method: 'GET',
          url: `/wardrobe/new/from-link?${query}`,
        });
        expect(res.statusCode).toBe(200);
        expect(unescapeHtml(res.body)).toContain(`value="${link}"`);
        expect(res.body).not.toContain('role="alert"');
      }
      expect(sites.hits.length).toBe(hits);
    });

    it('lets shared text through the field: a text input for a URL keyboard, not type="url"', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/wardrobe/new/from-link',
      });
      const field = /<input[^>]*id="link-url"[^>]*>/.exec(res.body)?.[0];
      expect(field).toContain('type="text"');
      expect(field).toContain('inputmode="url"');

      // What such a field posts: the words and the link, which linkIn finds.
      const { cookie } = await signUp('sharer@example.com');
      const shared = await importLink(
        `Heavyweight Pocket Tee | Studio Knit ${sites.url('/products/tee')}`,
        { cookie },
      );
      expect(shared.statusCode).toBe(200);
      expect(shared.body).toContain('value="Heavyweight Pocket Tee"');
    });

    it('says so when the shared text holds no link', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/wardrobe/new/from-link?text=just%20some%20words',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(text('linkImport.NO_LINK'));
    });
  });

  describe('a product page', () => {
    it('loads over https, trusting the fixture only through the stand-in (#496a)', async () => {
      // Its own account: the default one's LINK_IMPORT_LIMIT is spent below.
      const { cookie } = await signUp('secure-shopper@example.com');
      const res = await importLink(sites.secureUrl('/products/tee'), {
        cookie,
      });

      expect(res.statusCode).toBe(200);
      expect(unescapeHtml(res.body)).toContain(
        'value="Heavyweight Pocket Tee"',
      );
      expect(
        sites.requests.find((r) => r.servername === 'shop.test')?.path,
      ).toBe('/products/tee');
    });

    it('with JSON-LD prefills the form and offers its photos, writing nothing', async () => {
      const link = sites.url('/products/tee');
      let res!: Awaited<ReturnType<typeof importLink>>;
      await expectNothingWritten(async () => {
        res = await importLink(link);
      });

      expect(res.statusCode).toBe(200);
      const body = unescapeHtml(res.body);
      expect(body).toContain('value="Heavyweight Pocket Tee"');
      expect(body).toContain('value="Studio Knit"');
      expect(body).toMatch(/name="category"[^>]*value="Tops"/);
      expect(body).toMatch(/name="color" value="blue"\s+checked/);
      expect(body).toMatch(/name="materials" value="cotton"[^>]*checked/);
      expect(body).toMatch(/name="fabricWeight"[^>]*value="240"/);
      expect(body).toMatch(/name="price"[^>]*value="48.00"/);
      expect(body).toContain(`value="${link}"`);
      expect(body).toContain(text('linkImport.FOUND_DETAILS'));
      // The form posts to the ordinary create route.
      expect(body).toContain('action="/wardrobe"');

      // Two readable photos: both offered, the first kept as the photo.
      expect(choicesIn(res.body)).toEqual([
        sites.url('/img/front.jpg'),
        sites.url('/img/back.jpg'),
      ]);
      expect(previewsIn(res.body)).toBe(2);
      const photo = linkPhotoIn(res.body);
      expect(await storedOriginals()).toContain(photo);
      expect(body).toContain(`/file/thumb/${photo}?v=1`);
    });

    it('with Open Graph only prefills its name and photo, without choices', async () => {
      const res = await importLink(sites.url('/products/crew'));
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('value="Merino Crew Sweater"');
      expect(linkPhotoIn(res.body)).toBeDefined();
      expect(previewsIn(res.body)).toBe(0);
    });

    it('with nothing to extract opens the form with the link kept and says so', async () => {
      const link = sites.url('/nothing');
      const before = await storedOriginals();
      const res = await importLink(link);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(text('linkImport.NOTHING_FOUND'));
      expect(unescapeHtml(res.body)).toMatch(
        new RegExp(`name="sourceUrl"[^>]*value="${link}"`),
      );
      expect(linkPhotoIn(res.body)).toBeUndefined();
      expect(await storedOriginals()).toEqual(before);
    });

    it.each(['/products/shell', '/products/gone'])(
      'that is title-only (%s) keeps the link, warns, and does not claim a fill-in',
      async (path) => {
        const link = sites.url(path);
        const { cookie } = await signUp(
          `title-only${path.replace(/\W/g, '')}@example.com`,
        );
        const before = await storedOriginals();
        const res = await importLink(link, { cookie });
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain(text('linkImport.TITLE_ONLY'));
        expect(res.body).not.toContain(text('linkImport.FOUND_DETAILS'));
        expect(res.body).toContain('alert-warning');
        expect(res.body).not.toContain('Comfortable Shoes');
        expect(res.body).not.toContain('Outdoor Clothing');
        expect(unescapeHtml(res.body)).toMatch(
          new RegExp(`name="sourceUrl"[^>]*value="${link}"`),
        );
        expect(linkPhotoIn(res.body)).toBeUndefined();
        expect(await storedOriginals()).toEqual(before);
      },
    );

    it('past 2 MB is read up to the cap, where its JSON-LD and photo are (#347)', async () => {
      // A Shopify page's shape: the product's metadata first, then a
      // size-chart app's JSON blob in the head that runs past the cap.
      const blob = 'x'.repeat(3 * 1024 * 1024);
      sites.serve(
        '/products/huge',
        html(
          PRODUCT_PAGE([sites.url('/img/front.jpg')]).replace(
            '</head>',
            `<script type="application/json">"${blob}"</script></head>`,
          ),
        ),
      );
      const { cookie } = await signUp('huge-page@example.com');
      const res = await importLink(sites.url('/products/huge'), { cookie });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('value="Heavyweight Pocket Tee"');
      expect(linkPhotoIn(res.body)).toBeDefined();
    });

    it('leaves a price in another currency for the person, and says why', async () => {
      const res = await importLink(sites.url('/products/sek'));
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/name="price"[^>]*value=""/);
      expect(unescapeHtml(res.body)).toContain(
        text('linkImport.PRICE_CURRENCY', { currency: 'SEK' }),
      );
      expect(res.body).toContain(text('linkImport.NO_PHOTO'));
    });
  });

  it('a direct image link opens the form with that photo and blank fields', async () => {
    const before = await storedOriginals();
    const res = await importLink(sites.url('/img/back.jpg'));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(text('linkImport.PHOTO_ONLY'));
    expect(res.body).toMatch(/name="name"[^>]*value=""/);
    expect(res.body).toMatch(/name="sourceUrl"[^>]*value=""/);
    const photo = linkPhotoIn(res.body)!;
    expect(await storedOriginals()).toEqual([...before, photo].sort());
  });

  describe('the photo choice', () => {
    it('stores the picked photo and deletes the one it replaces', async () => {
      const page = await importLink(sites.url('/products/tee'));
      const first = linkPhotoIn(page.body)!;
      const [, other] = choicesIn(page.body);

      let res!: Awaited<ReturnType<typeof choosePhoto>>;
      await expectNothingWritten(async () => {
        res = await choosePhoto(other, first);
      });
      expect(res.statusCode).toBe(200);
      const picked = linkPhotoIn(res.body)!;
      expect(picked).not.toBe(first);
      const stored = await storedOriginals();
      expect(stored).toContain(picked);
      expect(stored).not.toContain(first);

      // "No photo": the slot empties and the photo goes.
      const none = await choosePhoto('', picked);
      expect(none.statusCode).toBe(200);
      expect(linkPhotoIn(none.body)).toBeUndefined();
      expect(await storedOriginals()).not.toContain(picked);
    });

    it('keeps the current photo and says why when the pick cannot be fetched', async () => {
      const page = await importLink(sites.url('/img/front.jpg'));
      const current = linkPhotoIn(page.body)!;
      const res = await choosePhoto(sites.url('/img/missing.jpg'), current);
      expectFailureTrigger(res, 502, text('linkImport.HTTP_STATUS'));
      expect(await storedOriginals()).toContain(current);
    });

    it('queues the taps on the choice group, so each pick posts the photo the last one left', async () => {
      const { cookie } = await signUp('picker@example.com');
      const page = await importLink(sites.url('/products/tee'), { cookie });
      const buttons = page.body.match(/<button[^>]*name="url"[^>]*>/g) ?? [];
      // Two photos and "No photo".
      expect(buttons).toHaveLength(3);
      for (const button of buttons) {
        expect(button).toContain('hx-sync="#link-photo-choices:queue last"');
      }
      expect(page.body).toContain('id="link-photo-choices"');
    });

    it('refuses past the rate limit with the 429 trigger (the slot is left as it was)', async () => {
      const { cookie } = await signUp('choosy@example.com');
      const current = `${randomUUID()}.webp`;
      const choose = () =>
        t.inject({
          method: 'POST',
          url: '/wardrobe/new/from-link/photo',
          payload: { url: '', linkPhoto: current },
          headers: { cookie, 'hx-request': 'true' },
        });
      for (let i = 0; i < 10; i++) {
        expect((await choose()).statusCode).toBe(200);
      }

      const refused = await choose();
      expectFailureTrigger(refused, 429, /^Too many attempts\. Try again in /);
      expect(t.logs.messages('warn', 'Web').join('\n')).toMatch(
        /Rate limit reached: POST \/wardrobe\/new\/from-link\/photo for user \d+/,
      );
    });

    it('never deletes a photo that has a row', async () => {
      // Its own user: the owner's fetch budget is spent by the tests above.
      const { cookie } = await signUp('keeper@example.com');
      const id = await createGarment(t, { name: 'Kept photo', cookie });
      await uploadPhoto(t, id, await jpegPhoto(), cookie);
      const saved = await photoFileName(t, id);
      const res = await t.inject({
        method: 'POST',
        url: '/wardrobe/new/from-link/photo',
        payload: { url: '', linkPhoto: saved },
        headers: { cookie, 'hx-request': 'true' },
      });
      expect(res.statusCode).toBe(200);
      expect(await storedOriginals()).toContain(saved);
    });
  });

  describe('saving', () => {
    let saver: { cookie: string; id: number };

    beforeAll(async () => {
      saver = await signUp('saver@example.com');
    });

    it('claims the photo: the garment and its row commit together, queued for a cutout', async () => {
      const link = sites.url('/products/tee');
      const { cookie } = saver;
      const page = await importLink(link, { cookie });
      const photo = linkPhotoIn(page.body)!;

      const res = await save(
        {
          name: 'Heavyweight Pocket Tee',
          product: '1',
          sourceUrl: link,
          price: '48.00',
          linkPhoto: photo,
        },
        { cookie },
      );
      expect(res.statusCode).toBe(302);
      const id = Number(
        /^\/wardrobe\/(\d+)\?created=1$/.exec(res.headers.location!)?.[1],
      );
      const row = await garmentRow(t, id);
      expect(row).toMatchObject({
        ownerId: saver.id,
        sourceUrl: link,
        price: '48.00',
        photo: {
          fileName: photo,
          createdById: saver.id,
          cutoutStatus: 'pending',
        },
      });

      // The same form again (a double tap): the photo is taken, nothing written.
      let again!: Awaited<ReturnType<typeof save>>;
      await expectNothingWritten(async () => {
        again = await save({ name: 'Twice', linkPhoto: photo }, { cookie });
      });
      expect(again.statusCode).toBe(400);
      expect(again.body).toContain(text('add.PHOTO_GONE'));
      expect(linkPhotoIn(again.body)).toBeUndefined();
      expect(again.body).toContain('value="Twice"');
    });

    it("refuses a name that is not an unsaved link photo (someone's saved one included), and touches no bytes", async () => {
      const id = await createGarment(t, { name: 'Someone else' });
      await uploadPhoto(t, id, await jpegPhoto());
      const saved = await photoFileName(t, id);
      const { cookie } = saver;
      for (const linkPhoto of [
        saved,
        'app.log',
        `${saved.slice(0, -5)}x.webp`,
      ]) {
        await expectNothingWritten(async () => {
          const res = await save({ name: 'Borrowed', linkPhoto }, { cookie });
          expect(res.statusCode).toBe(400);
          expect(res.body).toContain(text('add.PHOTO_GONE'));
        });
      }
      expect(await storedOriginals()).toContain(saved);
      expect((await garmentRow(t, id))?.photo?.fileName).toBe(saved);
    });

    it('keeps the photo when the form itself is refused', async () => {
      const { cookie } = saver;
      const page = await importLink(sites.url('/img/front.jpg'), { cookie });
      const photo = linkPhotoIn(page.body)!;
      const res = await save(
        { name: 'No category', category: '', linkPhoto: photo },
        { cookie },
      );
      expect(res.statusCode).toBe(400);
      expect(linkPhotoIn(res.body)).toBe(photo);
    });
  });

  describe('pending photos', () => {
    const pendingOf = (userId: number) =>
      t.db
        .select({ fileName: pendingPhoto.fileName })
        .from(pendingPhoto)
        .where(eq(pendingPhoto.userId, userId));
    const importPhoto = async (cookie: string) =>
      linkPhotoIn(
        (await importLink(sites.url('/img/back.jpg'), { cookie })).body,
      )!;

    it('are bound to the user who fetched them: nobody else claims or discards one', async () => {
      const fetcher = await signUp('fetcher@example.com');
      const other = await signUp('other@example.com');
      const photo = await importPhoto(fetcher.cookie);
      expect(await pendingOf(fetcher.id)).toEqual([{ fileName: photo }]);

      await expectNothingWritten(async () => {
        const claim = await save(
          { name: 'Not mine', linkPhoto: photo },
          { cookie: other.cookie },
        );
        expect(claim.statusCode).toBe(400);
        expect(claim.body).toContain(text('add.PHOTO_GONE'));
      });
      const discard = await t.inject({
        method: 'POST',
        url: '/wardrobe/new/from-link/photo',
        payload: { url: '', linkPhoto: photo },
        headers: { cookie: other.cookie, 'hx-request': 'true' },
      });
      expect(discard.statusCode).toBe(200);
      expect(await storedOriginals()).toContain(photo);
      expect(await pendingOf(fetcher.id)).toEqual([{ fileName: photo }]);

      // The one who fetched it still can.
      const mine = await save(
        { name: 'Mine', linkPhoto: photo },
        { cookie: fetcher.cookie },
      );
      expect(mine.statusCode).toBe(302);
      expect(await pendingOf(fetcher.id)).toEqual([]);
    });

    it(`are at most ${MAX_PENDING_PER_USER} a user: another evicts the oldest, bytes included`, async () => {
      const hoarder = await signUp('hoarder@example.com');
      const photos: string[] = [];
      for (let i = 0; i < MAX_PENDING_PER_USER; i++) {
        photos.push(await importPhoto(hoarder.cookie));
      }
      // The eleventh from the add sheet's upload: the ten imports spent the
      // link routes' shared rate limit, and the cap is per user, whichever
      // route stores the photo.
      const body = await multipart(
        {},
        {
          photo: {
            data: await jpegPhoto(),
            filename: 'IMG_0011.jpg',
            contentType: 'image/jpeg',
          },
        },
      );
      const eleventh = await t.inject({
        method: 'POST',
        url: '/wardrobe/new/photo',
        payload: body.payload,
        headers: { ...body.headers, cookie: hoarder.cookie },
      });
      expect(eleventh.statusCode).toBe(303);
      photos.push(
        new URL(
          eleventh.headers.location!,
          'http://localhost',
        ).searchParams.get('photo')!,
      );
      const [oldest, ...kept] = photos;
      expect(
        (await pendingOf(hoarder.id)).map((row) => row.fileName).sort(),
      ).toEqual([...kept].sort());
      const stored = await storedOriginals();
      expect(stored).not.toContain(oldest);
      for (const photo of kept) expect(stored).toContain(photo);
      expect(t.logs.messages('info', 'Web').join('\n')).toContain(
        `evicted ${oldest}`,
      );
    });

    it("go with their user's account", async () => {
      const email = 'leaving@example.com';
      const leaving = await signUp(email);
      const photo = await importPhoto(leaving.cookie);
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

    describe('reconciliation', () => {
      const reconcile = () =>
        reconcileStorage({
          db: t.db,
          photos: t.photos,
          logger: silentLogger,
          timeZone: t.timeZone,
        });

      /** Every pending photo two days old: its row and its files. */
      const ageEveryPendingPhoto = async () => {
        const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS);
        const rows = await t.db
          .update(pendingPhoto)
          .set({ createdAt: twoDaysAgo })
          .returning({ fileName: pendingPhoto.fileName });
        // What a pending photo has on disk: the original and its thumb (the
        // cutout comes only after a save queues it).
        for (const { fileName } of rows) {
          for (const variant of ['original', 'thumb'] as const) {
            const path = join(t.dataPath, variantFileName(fileName, variant));
            await utimes(path, twoDaysAgo, twoDaysAgo);
          }
        }
        return rows.map((row) => row.fileName);
      };

      it('removes more than the guard allows of abandoned imports, across users, and still guards the rest', async () => {
        // A saved photo, so the guard sees a live file table.
        const kept = await createGarment(t, { name: 'Saved' });
        await uploadPhoto(t, kept, await jpegPhoto());
        const keptPhoto = await photoFileName(t, kept);
        // 27 abandoned imports: more than GUARD_MAX_SETS, from three users
        // (each within the rate limit and the per-user cap).
        for (const email of [
          'a@example.com',
          'b@example.com',
          'c@example.com',
        ]) {
          const { cookie } = await signUp(email);
          for (let i = 0; i < 9; i++) await importPhoto(cookie);
        }
        const abandoned = await ageEveryPendingPhoto();
        expect(abandoned.length).toBeGreaterThan(GUARD_MAX_SETS);

        const report = await reconcile();
        expect(report.refused).toBeUndefined();
        expect(report.pendingPhotosDeleted).toBe(abandoned.length);
        expect(report.orphanedSetsQuarantined).toBe(0);
        const stored = await storedOriginals();
        for (const photo of abandoned) expect(stored).not.toContain(photo);
        expect(stored).toContain(keptPhoto);
        expect(await t.db.$count(pendingPhoto)).toBe(0);

        // A wholesale mismatch (sets nothing explains) is still refused.
        const strangers = Array.from(
          { length: GUARD_MAX_SETS + 1 },
          () => `${randomUUID()}.webp`,
        );
        const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS);
        for (const name of strangers) {
          const path = join(t.dataPath, name);
          await writeFile(path, `bytes of ${name}`);
          await utimes(path, twoDaysAgo, twoDaysAgo);
        }
        const guarded = await reconcile();
        expect(guarded.refused).toBeDefined();
        expect(await storedOriginals()).toEqual(
          expect.arrayContaining(strangers),
        );
        for (const name of strangers) await rm(join(t.dataPath, name));
      });

      it('keeps young pending photos and drops pending rows whose files are gone', async () => {
        const { cookie, id } = await signUp('young@example.com');
        const young = await importPhoto(cookie);
        const lost = await importPhoto(cookie);
        await t.photos.deleteVariants(unkeyedPhoto(lost));

        const report = await reconcile();
        expect(report).toMatchObject({
          pendingPhotosDeleted: 0,
          pendingRowsWithoutFiles: 1,
          orphanedSetsQuarantined: 0,
        });
        expect(await storedOriginals()).toContain(young);
        expect(await pendingOf(id)).toEqual([{ fileName: young }]);
      });
    });
  });

  describe('refusals', () => {
    let cookie: string;

    beforeAll(async () => {
      ({ cookie } = await signUp('refused@example.com'));
    });

    it.each<[string, () => string, number, StringKey]>([
      ['not a link', () => 'just words', 400, 'linkImport.NO_LINK'],
      [
        'a name that resolves inside the network',
        () => sites.url('/products/tee', INTRANET_HOST),
        400,
        'linkImport.BLOCKED_ADDRESS',
      ],
      [
        'a redirect into the network',
        () => sites.url('/to-the-router'),
        400,
        'linkImport.BLOCKED_ADDRESS',
      ],
      [
        'a name that does not resolve',
        () => sites.url('/', 'nowhere.test'),
        400,
        'linkImport.UNRESOLVABLE',
      ],
      [
        'an error page',
        () => sites.url('/gone'),
        502,
        'linkImport.HTTP_STATUS',
      ],
      [
        'an image that cannot be read',
        () => sites.url('/img/garbage.jpg'),
        502,
        'linkImport.UNREADABLE_IMAGE',
      ],
      [
        "a shop's bot challenge",
        () => sites.url('/challenged'),
        502,
        'linkImport.BLOCKED_BY_SITE',
      ],
      [
        "a shop's rate limit after its www. redirected to the apex",
        () => sites.url('/www/products/limited', WWW_SHOP_HOST),
        502,
        'linkImport.BLOCKED_BY_SITE',
      ],
      [
        'a bot challenge answered with a 2xx',
        () => sites.url('/waf'),
        502,
        'linkImport.BLOCKED_BY_SITE',
      ],
    ])(
      '%s: the link page again with a message, nothing stored',
      async (_case, link, status, message) => {
        const before = await storedOriginals();
        let res!: Awaited<ReturnType<typeof importLink>>;
        await expectNothingWritten(async () => {
          res = await importLink(link(), { cookie });
        });
        expect(res.statusCode).toBe(status);
        const body = unescapeHtml(res.body);
        expect(body).toContain(text(message));
        expect(body).toContain(`value="${link()}"`);
        // Where a name pointed is never told.
        expect(res.body).not.toContain('127.0.0.1');
        expect(res.body).not.toContain('10.1.2.3');
        expect(await storedOriginals()).toEqual(before);
      },
    );
  });

  describe('wardrobe shares', () => {
    let manager: string;
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
      manager = await t.register('manager@example.com');
      viewer = await t.register('viewer@example.com');
      stranger = await t.register('stranger@example.com');
      await share(manager, 'MANAGE');
      await share(viewer, 'VIEW');
    });

    it("a MANAGE grantee adds to the owner's wardrobe; the photo is the owner's", async () => {
      const ownerId = t.owner.id;
      const page = await importLink(sites.url('/img/front.jpg'), {
        cookie: manager,
        ownerId,
      });
      expect(page.statusCode).toBe(200);
      expect(unescapeHtml(page.body)).toContain(
        `action="/wardrobe?ownerId=${ownerId}"`,
      );
      const res = await save(
        { name: 'From the grantee', linkPhoto: linkPhotoIn(page.body)! },
        { cookie: manager, ownerId },
      );
      expect(res.statusCode).toBe(302);
      const id = Number(/^\/wardrobe\/(\d+)/.exec(res.headers.location!)?.[1]);
      expect(await garmentRow(t, id)).toMatchObject({
        ownerId,
        photo: { createdById: ownerId },
      });
    });

    it.each([
      ['a VIEW grantee', () => viewer, 403],
      ['a stranger', () => stranger, 404],
    ] as const)(
      "%s may not import into the owner's wardrobe, and nothing is fetched",
      async (_who, cookie, status) => {
        const hits = sites.hits.length;
        const before = await storedOriginals();
        const res = await importLink(sites.url('/img/front.jpg'), {
          cookie: cookie(),
          ownerId: t.owner.id,
        });
        expect(res.statusCode).toBe(status);
        expect(sites.hits.length).toBe(hits);
        expect(await storedOriginals()).toEqual(before);
      },
    );
  });

  it('is rate limited per user: 10 imports a minute', async () => {
    const cookie = await t.register('shopper@example.com');
    const shopperId = await userIdOf(t, 'shopper@example.com');
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (await importLink(sites.url('/nothing-here'), { cookie })).statusCode,
      );
    }
    // Refused after the fetch, so each spends one (a no-link body spends none).
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(statuses[0]));
    expect(statuses[0]).toBeGreaterThanOrEqual(400);
    expect(statuses[10]).toBe(429);
    expect(t.logs.messages('warn', 'Web')).toContain(
      `Rate limit reached: POST /wardrobe/new/from-link for user ${shopperId}`,
    );
    // Someone else's count is their own.
    const other = await signUp('other-shopper@example.com');
    expect(
      (await importLink(sites.url('/nothing-here'), { cookie: other.cookie }))
        .statusCode,
    ).toBe(statuses[0]);
  });

  it('counts imports and photo choices together: the combined eleventh is refused', async () => {
    const { cookie } = await signUp('mixer@example.com');
    const choose = () =>
      t.inject({
        method: 'POST',
        url: '/wardrobe/new/from-link/photo',
        payload: { url: '' },
        headers: { cookie, 'hx-request': 'true' },
      });
    // Five of each, interleaved: ten fetches between the two routes.
    for (let i = 0; i < 5; i++) {
      expect(
        (await importLink(sites.url('/nothing-here'), { cookie })).statusCode,
      ).not.toBe(429);
      expect((await choose()).statusCode).toBe(200);
    }

    const eleventhImport = await importLink(sites.url('/nothing-here'), {
      cookie,
    });
    expect(eleventhImport.statusCode).toBe(429);
    expect((await choose()).statusCode).toBe(429);
  });
});
