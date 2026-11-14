import { and, eq } from 'drizzle-orm';
import { readdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  file,
  garment,
  inspiration,
  inspirationPiece,
  outfit,
  outfitSlot,
  pendingPhoto,
} from '../../src/db/schema';
import { reconcileStorage } from '../../src/maintenance/reconcile';
import { updateInspirationPiece } from '../../src/web/inspiration/queries';
import {
  SHARE_BODY_MAX_BYTES,
  SHARE_PHOTO_MAX_BYTES,
} from '../../src/web/inspiration/share-target';
import { variantFileName } from '../../src/web/files/image-variant';
import { t as text } from '../../src/web/i18n';
import { createGarment, jpegPhoto, photoRow } from './garments';
import {
  createTestApp,
  extractImgSrcs,
  multipart,
  recordQueries,
  TEST_PASSWORD,
  type TestApp,
  unescapeHtml,
  userIdOf,
  asFixture,
} from './harness';
import { interleave } from './interleave';
import { addLook, lookIdOf, lookPhotoName, postLookPhoto } from './inspiration';
import {
  html,
  INTRANET_HOST,
  jpeg,
  type LinkSites,
  startLinkSites,
} from './link-sites';
import { silentLogger } from './logger';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Saved looks (#22, slices 22a to 22d): adding one from a photo, a
 * pasted link or a share's confirmation (22d), its page's title and note, its photo added, replaced and
 * deleted with it, the photo's references (private like a selfie's; never
 * an orphan to reconciliation), its pieces tagged, "Recreate this look"
 * over the closet, saving it as an outfit and "Find this". Who may reach them is the authorization matrix's
 * (authorization-outfits.routes.ts); the matching's rules are
 * src/wardrobe/recreate.spec.ts'.
 */
describe('inspiration', () => {
  let t: TestApp;
  let sites: LinkSites;
  let photo: Buffer;

  const stored = async () =>
    (await readdir(t.dataPath)).filter((name) => name.endsWith('.webp'));

  const lookRow = async (id: number) => {
    const [row] = await t.db
      .select()
      .from(inspiration)
      .where(eq(inspiration.id, id));
    return row;
  };

  const pasteLink = (url: string) =>
    t.inject({ method: 'POST', url: '/inspiration/link', payload: { url } });

  beforeAll(async () => {
    sites = await startLinkSites();
    t = await createTestApp({}, { outboundFetch: sites.outboundFetch });
    photo = await jpegPhoto(600, 800);
    sites.serve('/look.jpg', jpeg(photo));
    sites.serve(
      '/lookbook',
      html(
        `<html><head><title>Navy blazer, white tee</title><meta property="og:image" content="${sites.url('/look.jpg')}"></head><body></body></html>`,
      ),
    );
    sites.serve(
      '/words',
      html('<html><head><title>Words only</title></head><body></body></html>'),
    );
    sites.serve('/blocked', {
      status: 403,
      type: 'text/html',
      body: '<title>Just a moment...</title>',
      headers: { 'cf-mitigated': 'challenge' },
    });
  });

  afterAll(async () => {
    await t?.cleanup();
    await sites?.close();
  });

  it('saves an upload as a look with a private photo and no cutout, listed newest first', async () => {
    const first = await addLook(t, photo);
    const second = await addLook(t, photo);
    const row = await photoRow(t, second.fileName);
    // A look is a whole picture: nothing is queued for background removal.
    expect(row?.cutoutStatus).toBe('unwanted');

    let list!: Awaited<ReturnType<typeof t.inject>>;
    const { statements } = await recordQueries(async () => {
      list = await t.inject({ method: 'GET', url: '/inspiration' });
    });
    expect(list.statusCode).toBe(200);
    // The session's, then the list's one.
    expect(statements).toBe(2);
    const thumbs = extractImgSrcs(unescapeHtml(list.body)).filter((src) =>
      src.startsWith('/inspiration/photo/thumb/'),
    );
    expect(thumbs).toEqual([
      `/inspiration/photo/thumb/${second.fileName}?v=1`,
      `/inspiration/photo/thumb/${first.fileName}?v=1`,
    ]);
    expect(list.body).toMatch(
      /<a href="\/inspiration" class="tab tab-active" aria-current="page"/,
    );
    expect(list.body).toContain(text('gallery.TAB_INSPIRATION'));

    for (const url of [
      `/inspiration/photo/${second.fileName}?v=1`,
      `/inspiration/photo/thumb/${second.fileName}?v=1`,
    ]) {
      const res = await t.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['cache-control']).toContain('private');
    }
    // Never public by name: the /file/** routes refuse it, the owner too.
    for (const variant of ['', 'thumb/', 'nobg/']) {
      const res = await t.inject({
        method: 'GET',
        url: `/file/${variant}${second.fileName}?v=1`,
      });
      expect(res.statusCode, variant).toBe(404);
    }
    expect(t.logs.messages('info')).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^Inspiration ${second.id} saved by user \\d+ from an upload`,
        ),
      ),
    );
  });

  it('saves a pasted page with its title and its photo, the pending photo claimed', async () => {
    const res = await pasteLink(`Look at this ${sites.url('/lookbook')}`);
    expect(res.statusCode, res.body).toBe(303);
    const id = lookIdOf(res.headers.location);
    expect(res.headers.location).toBe(`/inspiration/${id}`);
    const look = await lookRow(id);
    expect(look).toMatchObject({
      title: 'Navy blazer, white tee',
      sourceUrl: sites.url('/lookbook'),
    });
    const fileName = await lookPhotoName(t, id);
    expect((await photoRow(t, fileName))?.cutoutStatus).toBe('unwanted');
    expect(
      await t.db.$count(pendingPhoto, eq(pendingPhoto.fileName, fileName)),
    ).toBe(0);

    const page = await t.inject({ method: 'GET', url: `/inspiration/${id}` });
    expect(page.statusCode).toBe(200);
    const body = unescapeHtml(page.body);
    expect(body).toContain(`/inspiration/photo/${fileName}?v=1`);
    expect(body).toContain('rel="noopener noreferrer"');
    expect(body).toContain(
      text('inspiration.OPEN_LINK', { host: 'shop.test' }),
    );
  });

  it('keeps a link it could not get a photo from, and says why once', async () => {
    const blocked = await pasteLink(sites.url('/blocked'));
    expect(blocked.statusCode).toBe(303);
    expect(blocked.headers.location).toMatch(/\?unread=blocked-by-site$/);
    const id = lookIdOf(blocked.headers.location);
    expect(await lookRow(id)).toMatchObject({
      sourceUrl: sites.url('/blocked'),
      photoId: null,
    });
    const page = await t.inject({
      method: 'GET',
      url: blocked.headers.location,
    });
    const body = unescapeHtml(page.body);
    expect(body).toContain(text('linkImport.BLOCKED_BY_SITE'));
    expect(body).toContain(text('inspiration.NO_PHOTO'));
    // Unknown URL state is no note, never a 400.
    const odd = await t.inject({
      method: 'GET',
      url: `/inspiration/${id}?unread=nonsense`,
    });
    expect(odd.statusCode).toBe(200);
    expect(unescapeHtml(odd.body)).not.toContain(text('inspiration.UNREAD'));

    const words = await pasteLink(sites.url('/words'));
    expect(words.headers.location).toMatch(/\?unread=no-photo$/);
    expect(await lookRow(lookIdOf(words.headers.location))).toMatchObject({
      title: 'Words only',
      photoId: null,
    });
  });

  it.each([
    ['no link', 'just some words', 400, 'linkImport.NO_LINK'],
    [
      'a private address',
      `http://${INTRANET_HOST}/look`,
      400,
      'linkImport.BLOCKED_ADDRESS',
    ],
  ] as const)(
    'refuses %s: the add page again with the reason, nothing saved',
    async (_case, url, status, message) => {
      const before = await t.db.$count(inspiration);
      const res = await pasteLink(url);
      expect(res.statusCode).toBe(status);
      const body = unescapeHtml(res.body);
      expect(body).toContain(text(message));
      expect(body).toContain(`value="${url}"`);
      expect(await t.db.$count(inspiration)).toBe(before);
    },
  );

  // A share is saved only by the confirmation page's own post (#22d): the
  // service worker answers the share target on the device and never sends
  // it on (share-target.spec.ts), because a cross-site page can submit the
  // same navigation. So a cross-site post is the same-origin hook's 403.
  it.each([
    ['POST /inspiration', '/inspiration'],
    ['the share target', '/inspiration/share'],
  ])('saves nothing for %s from another site', async (_case, url) => {
    const looks = await t.db.$count(inspiration);
    const files = await t.db.$count(file);
    const body = await multipart(
      { title: 'A look' },
      {
        photo: {
          data: photo,
          filename: 'shared.jpg',
          contentType: 'image/jpeg',
        },
      },
    );
    const res = await t.inject({
      method: 'POST',
      url,
      payload: body.payload,
      headers: { ...body.headers, origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(await t.db.$count(inspiration)).toBe(looks);
    expect(await t.db.$count(file)).toBe(files);
  });

  // With no worker to answer it (storage cleared, not installed), Android's
  // share reaches the server with no Origin: the hook's one `stateless`
  // exemption (same-origin.spec.ts holds the list to this route). So the
  // route must write nothing and read only the text fields, never a photo.
  it.each([
    [
      'a link',
      { title: 'Shop', text: 'Look: https://shop.test/look' },
      false,
      '/wardrobe/new/from-link?url=https%3A%2F%2Fshop.test%2Flook',
    ],
    [
      'text without a link',
      { text: 'no link here' },
      false,
      '/wardrobe/new/from-link?text=no+link+here',
    ],
    [
      'a photo with its link',
      { url: 'https://shop.test/look' },
      true,
      '/inspiration/share/confirm#not-opened',
    ],
    ['nothing', {}, false, '/inspiration/share/confirm#not-opened'],
  ])(
    'answers a share no worker took (%s) with a 303, writing nothing',
    async (_case, fields, withPhoto, location) => {
      const before = await stored();
      const pending = await t.db.$count(pendingPhoto);
      const body = await multipart(
        fields,
        withPhoto
          ? {
              photo: {
                data: photo,
                filename: 'shared.jpg',
                contentType: 'image/jpeg',
              },
            }
          : {},
      );
      let res!: Awaited<ReturnType<typeof t.inject>>;
      const { sql } = await recordQueries(async () => {
        res = await t.inject({
          method: 'POST',
          url: '/inspiration/share',
          payload: body.payload,
          headers: body.headers,
          sameOrigin: false,
        });
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(location);
      // The session's row, and nothing else.
      expect(sql).toHaveLength(1);
      expect(sql[0]).toMatch(/^select /i);
      expect(await stored()).toEqual(before);
      expect(await t.db.$count(pendingPhoto)).toBe(pending);
    },
  );

  it('refuses a share no worker took that is declared past the cap, before reading it', async () => {
    const res = await t.inject({
      method: 'POST',
      url: '/inspiration/share',
      payload: 'x',
      headers: {
        'content-type': 'multipart/form-data; boundary=x',
        'content-length': String(SHARE_BODY_MAX_BYTES + 1),
      },
      sameOrigin: false,
    });
    expect(res.statusCode).toBe(413);
  });

  // Whatever the order: the confirmation page puts the fields first, but the
  // route must not depend on it (an older cached page posts the file first).
  it("keeps a shared look's link and title when the photo is posted before them", async () => {
    const form = new FormData();
    form.append(
      'photo',
      new Blob([new Uint8Array(photo)], { type: 'image/jpeg' }),
      'shared.jpg',
    );
    form.append('url', 'https://shop.test/file-first');
    form.append('title', 'File first');
    const encoded = new Response(form);
    const res = await t.inject({
      method: 'POST',
      url: '/inspiration',
      payload: Buffer.from(await encoded.arrayBuffer()),
      headers: { 'content-type': encoded.headers.get('content-type')! },
    });
    expect(res.statusCode).toBe(303);
    expect(await lookRow(lookIdOf(res.headers.location))).toMatchObject({
      sourceUrl: 'https://shop.test/file-first',
      title: 'File first',
    });
  });

  // The confirmation posts the share's link and title beside its photo.
  it('saves a shared photo with its link and title, and refuses a link that is not http(s)', async () => {
    const post = async (fields: Record<string, string>) => {
      const body = await multipart(fields, {
        photo: {
          data: photo,
          filename: 'shared.jpg',
          contentType: 'image/jpeg',
        },
      });
      return t.inject({
        method: 'POST',
        url: '/inspiration',
        payload: body.payload,
        headers: body.headers,
      });
    };
    const saved = await post({
      url: 'https://shop.test/look?a=1',
      title: 'Linen suit',
    });
    expect(saved.statusCode).toBe(303);
    const row = await lookRow(lookIdOf(saved.headers.location));
    expect(row).toMatchObject({
      sourceUrl: 'https://shop.test/look?a=1',
      title: 'Linen suit',
    });
    // Where the save lands, which deletes the share from the device.
    const page = await t.inject({
      method: 'GET',
      url: String(saved.headers.location),
    });
    expect(page.body).toContain('href="https://shop.test/look?a=1"');
    expect(page.body).toContain(
      "import { forgetSavedShare } from 'share-saved';",
    );
    const blank = await post({ url: '', title: '' });
    expect(await lookRow(lookIdOf(blank.headers.location))).toMatchObject({
      sourceUrl: null,
      title: null,
    });

    const looks = await t.db.$count(inspiration);
    const files = await stored();
    const refused: Record<string, string>[] = [
      { url: 'javascript:alert(1)' },
      { url: 'http:no-slashes' },
      { url: 'https://shop.test/a b' },
      { title: 'x'.repeat(256) },
    ];
    for (const fields of refused) {
      const res = await post(fields);
      expect(res.statusCode, JSON.stringify(fields)).toBe(400);
    }
    expect(await t.db.$count(inspiration)).toBe(looks);
    expect(await stored()).toEqual(files);
  });

  // The photo is on the device (the fragment names it), so the server
  // renders one page for every share and reads nothing but the session.
  it('renders the share confirmation from no state: Save disabled, posting the photo to POST /inspiration', async () => {
    let res!: Awaited<ReturnType<typeof t.inject>>;
    const { statements } = await recordQueries(async () => {
      res = await t.inject({
        method: 'GET',
        url: '/inspiration/share/confirm',
      });
    });
    expect(res.statusCode).toBe(200);
    expect(statements).toBe(1);
    const body = unescapeHtml(res.body);
    expect(body).toMatch(
      /<form method="post" action="\/inspiration" enctype="multipart\/form-data"/,
    );
    expect(body).toMatch(/<button type="submit" class="[^"]*" disabled="">/);
    expect(body).toContain('<input type="file" name="photo" accept="image/*"');
    // The link and title precede the file: a browser posts fields in
    // document order, so they never wait behind the photo.
    expect(body.indexOf('name="url"')).toBeGreaterThan(-1);
    expect(body.indexOf('name="url"')).toBeLessThan(
      body.indexOf('type="file"'),
    );
    expect(body.indexOf('name="title"')).toBeLessThan(
      body.indexOf('type="file"'),
    );
    expect(body).toContain('data-stash-cache="shares-v1"');
    expect(body).toContain("import { confirmShare } from 'share-confirm';");
    expect(body).toContain(text('inspiration.SAVE_SHARED'));
  });

  // The share's cap, which the worker keeps to as well: a 413 storing nothing.
  it('refuses a photo past the share cap with a 413, storing nothing', async () => {
    const looks = await t.db.$count(inspiration);
    const files = await t.db.$count(file);
    const bytes = await stored();
    // A whole JPEG, then padding past the cap: the parser reports the cut
    // only after the photo decoded, so its bytes are stored, then deleted
    // before the 413 (Photos.storeUploadParts). Before that they landed
    // after the response, which only "is never an orphan" saw, shifted.
    const huge = Buffer.concat([
      photo,
      Buffer.alloc(SHARE_PHOTO_MAX_BYTES + 1 - photo.length),
    ]);
    const res = await postLookPhoto(t, huge);
    expect(res.statusCode).toBe(413);
    expect(await t.db.$count(inspiration)).toBe(looks);
    expect(await t.db.$count(file)).toBe(files);
    expect(await stored()).toEqual(bytes);
  });

  // The button posts the page's one field, `url`, to the paste's route
  // (POST /inspiration/link, above).
  it('offers "Save as inspiration" on the link page of the own closet only', async () => {
    const own = await t.inject({
      method: 'GET',
      url: `/wardrobe/new/from-link?url=${encodeURIComponent(sites.url('/lookbook'))}`,
    });
    expect(own.statusCode).toBe(200);
    const body = unescapeHtml(own.body);
    expect(body).toContain('formaction="/inspiration/link"');
    expect(body).toContain(text('linkImport.SAVE_AS_INSPIRATION'));
    const wishlist = await t.inject({
      method: 'GET',
      url: '/wardrobe/new/from-link?to=wishlist',
    });
    expect(wishlist.statusCode).toBe(200);
    expect(wishlist.body).not.toContain('formaction="/inspiration/link"');
  });

  it('saves the title and note as they change; a blank is none, too long a 400', async () => {
    const { id } = await addLook(t, photo);
    const save = (payload: Record<string, string>) =>
      t.inject({
        method: 'POST',
        url: `/inspiration/${id}`,
        payload,
        headers: { 'hx-request': 'true' },
      });
    const saved = await save({ title: '  Café look ', note: 'The coat' });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).toContain(text('SAVED'));
    expect(await lookRow(id)).toMatchObject({
      title: 'Café look',
      note: 'The coat',
    });
    await save({ title: '', note: '  ' });
    expect(await lookRow(id)).toMatchObject({ title: null, note: null });
    expect((await save({ title: 'x'.repeat(256), note: '' })).statusCode).toBe(
      400,
    );
  });

  it('adds a photo to a link saved without one, and replaces it, unlinking the old', async () => {
    const id = lookIdOf(
      (await pasteLink(sites.url('/blocked'))).headers.location,
    );
    const added = await postLookPhoto(t, photo, {
      url: `/inspiration/${id}/photo`,
    });
    expect(added.statusCode).toBe(303);
    expect(added.headers.location).toBe(`/inspiration/${id}`);
    const firstName = await lookPhotoName(t, id);

    const replaced = await postLookPhoto(t, photo, {
      url: `/inspiration/${id}/photo`,
    });
    expect(replaced.statusCode).toBe(303);
    const secondName = await lookPhotoName(t, id);
    expect(secondName).not.toBe(firstName);
    expect(await photoRow(t, firstName)).toBeUndefined();
    expect(await stored()).not.toContain(firstName);
    expect(await stored()).toContain(secondName);
  });

  it('deletes a look with its photo, row and bytes', async () => {
    const { id, fileName } = await addLook(t, photo);
    // Its thumb made, so the whole set is on disk.
    await t.inject({
      method: 'GET',
      url: `/inspiration/photo/thumb/${fileName}?v=1`,
    });
    expect(await stored()).toContain(variantFileName(fileName, 'thumb'));

    const res = await t.inject({
      method: 'POST',
      url: `/inspiration/${id}/delete`,
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/inspiration');
    expect(await lookRow(id)).toBeUndefined();
    expect(await photoRow(t, fileName)).toBeUndefined();
    const files = await stored();
    expect(files).not.toContain(fileName);
    expect(files).not.toContain(variantFileName(fileName, 'thumb'));
    const gone = await t.inject({ method: 'GET', url: `/inspiration/${id}` });
    expect(gone.statusCode).toBe(404);
  });

  // Before photoIsReferenced counted looks, every look's photo was an
  // unreferenced `file` row, deleted the night after it was saved.
  it('is never an orphan to storage reconciliation', async () => {
    const { id, fileName } = await addLook(t, photo);
    const then = new Date(Date.now() - 3 * DAY_MS);
    await asFixture(t.db, (tx) =>
      tx
        .update(file)
        .set({ createdOn: then.toISOString() })
        .where(eq(file.fileName, fileName)),
    );
    await utimes(join(t.dataPath, fileName), then, then);

    const report = await reconcileStorage({
      db: t.db,
      photos: t.photos,
      timeZone: t.timeZone,
      logger: silentLogger,
    });
    expect(report.refused).toBeUndefined();
    expect(report).toMatchObject({
      orphanedRowsDeleted: 0,
      orphanedSetsQuarantined: 0,
    });
    expect(await photoRow(t, fileName)).toBeDefined();
    expect(await stored()).toContain(fileName);
    expect((await lookRow(id)).photoId).not.toBeNull();
  });

  const pieces = async (id: number) =>
    t.db
      .select({
        position: inspirationPiece.position,
        role: inspirationPiece.role,
        type: inspirationPiece.type,
        colors: inspirationPiece.colors,
        pattern: inspirationPiece.pattern,
      })
      .from(inspirationPiece)
      .where(eq(inspirationPiece.inspirationId, id))
      .orderBy(inspirationPiece.position);

  const piece = (
    kind: string,
    color = '',
    accent = '',
    pattern = '',
  ): Record<string, string> => ({ kind, color, accent, pattern });

  /** A hint's own post: its hidden kind (the select's options are <option>s). */
  const hintFor = (kind: string) => `type="hidden" name="kind" value="${kind}"`;

  /** A garment of the owner's `cookie`, posted through the garment form. */
  const wear = async (
    cookie: string,
    name: string,
    category: string,
    type: string,
    color: string,
  ) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      payload: { name, category, props: '1', type, color: [color] },
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    return Number(
      /^\/wardrobe\/(\d+)\?/.exec(String(res.headers.location))![1],
    );
  };

  /**
   * A closet (a navy blazer, a black jacket, a white and a grey tee) and a
   * look titled `title` with three pieces: a blue blazer, a white tee and
   * white sneakers, which the closet has nothing close to.
   */
  const closetAndLook = async (cookie: string, title = 'Navy and white') => {
    const navyBlazer = await wear(
      cookie,
      'Navy blazer',
      'outerwear',
      'blazer',
      'blue',
    );
    const blackJacket = await wear(
      cookie,
      'Black jacket',
      'outerwear',
      'jacket',
      'black',
    );
    const whiteTee = await wear(
      cookie,
      'White tee',
      'tops',
      't-shirt',
      'white',
    );
    const greyTee = await wear(cookie, 'Grey tee', 'tops', 't-shirt', 'grey');
    const { id } = await addLook(t, photo, cookie);
    const named = await t.inject({
      method: 'POST',
      url: `/inspiration/${id}`,
      payload: { title, note: '' },
      headers: { cookie, 'hx-request': 'true' },
    });
    expect(named.statusCode).toBe(200);
    for (const payload of [
      piece('layer/blazer', 'blue'),
      piece('top/t-shirt', 'white'),
      piece('footwear/sneakers', 'white', '', 'solid'),
    ]) {
      const res = await t.inject({
        method: 'POST',
        url: `/inspiration/${id}/pieces`,
        payload,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(303);
    }
    return { id, navyBlazer, blackJacket, whiteTee, greyTee };
  };

  const matchedOf = async (id: number) =>
    (
      await t.db
        .select({ matched: inspirationPiece.matchedGarmentId })
        .from(inspirationPiece)
        .where(eq(inspirationPiece.inspirationId, id))
        .orderBy(inspirationPiece.position)
    ).map((row) => row.matched);

  it('tags a look: the hints from its title, the add form, a change saved, a removal; a bad value is a 400', async () => {
    const id = lookIdOf(
      (await pasteLink(sites.url('/lookbook'))).headers.location,
    );
    const page = async () =>
      unescapeHtml(
        (await t.inject({ method: 'GET', url: `/inspiration/${id}` })).body,
      );
    // "Navy blazer, white tee": one hint per garment, its own colour.
    const first = await page();
    expect(first).toContain(hintFor('layer/blazer'));
    expect(first).toContain(hintFor('top/t-shirt'));
    // Nothing to recreate before a piece.
    expect(first).not.toContain(`/inspiration/${id}/recreate`);

    const add = (payload: Record<string, string>) =>
      t.inject({ method: 'POST', url: `/inspiration/${id}/pieces`, payload });
    const added = await add(piece('layer/blazer', 'blue'));
    expect(added.statusCode).toBe(303);
    expect(added.headers.location).toBe(`/inspiration/${id}#look-pieces`);
    // An accent alone is the main colour; one colour twice is once.
    expect((await add(piece('bottom', '', 'black', 'solid'))).statusCode).toBe(
      303,
    );
    expect((await add(piece('footwear', 'white', 'white'))).statusCode).toBe(
      303,
    );
    expect(await pieces(id)).toEqual([
      {
        position: 0,
        role: 'layer',
        type: 'blazer',
        colors: ['blue'],
        pattern: null,
      },
      {
        position: 1,
        role: 'bottom',
        type: null,
        colors: ['black'],
        pattern: 'solid',
      },
      {
        position: 2,
        role: 'footwear',
        type: null,
        colors: ['white'],
        pattern: null,
      },
    ]);
    const tagged = await page();
    expect(tagged).not.toContain(hintFor('layer/blazer'));
    expect(tagged).toContain(hintFor('top/t-shirt'));
    expect(tagged).toContain(`href="/inspiration/${id}/recreate"`);
    expect(t.logs.ops('inspiration.piece.added')).toContainEqual(
      expect.objectContaining({
        inspirationId: id,
        position: 0,
        kind: 'layer/blazer',
      }),
    );

    // The piece's autosave: answered with the status line.
    const saved = await t.inject({
      method: 'POST',
      url: `/inspiration/${id}/pieces/0`,
      payload: piece('layer/coat', 'beige', 'blue', 'check'),
      headers: { 'hx-request': 'true' },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).toContain(text('SAVED'));
    expect((await pieces(id))[0]).toEqual({
      position: 0,
      role: 'layer',
      type: 'coat',
      colors: ['beige', 'blue'],
      pattern: 'check',
    });

    // Stored data: a type of another role, an unknown colour, a missing kind.
    for (const payload of [
      piece('layer/jeans'),
      piece('top', 'navy'),
      { color: 'blue' },
    ]) {
      const res = await add(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const unknown = await t.inject({
      method: 'POST',
      url: `/inspiration/${id}/pieces/9`,
      payload: piece('top'),
    });
    expect(unknown.statusCode).toBe(404);

    const removed = await t.inject({
      method: 'POST',
      url: `/inspiration/${id}/pieces/1/delete`,
    });
    expect(removed.statusCode).toBe(303);
    expect((await pieces(id)).map((p) => p.position)).toEqual([0, 2]);
    // The next one goes last, whatever was removed.
    await add(piece('accessory/belt'));
    expect((await pieces(id)).map((p) => p.position)).toEqual([0, 2, 3]);

    // A piece an older build added (no counter) sits past it: the next add
    // reserves beyond the stored maximum instead of hitting the key.
    await t.db.insert(inspirationPiece).values({
      inspirationId: id,
      position: 9,
      role: 'accessory',
      type: null,
      colors: [],
      pattern: null,
    });
    expect((await add(piece('accessory/hat'))).statusCode).toBe(303);
    expect((await pieces(id)).map((p) => p.position)).toEqual([0, 2, 3, 9, 10]);
  });

  it('holds a look to INSPIRATION_MAX_PIECES pieces', async () => {
    const { id } = await addLook(t, photo);
    await t.db.insert(inspirationPiece).values(
      Array.from({ length: 12 }, (_, position) => ({
        inspirationId: id,
        position,
        role: 'accessory' as const,
        colors: [],
      })),
    );
    const res = await t.inject({
      method: 'POST',
      url: `/inspiration/${id}/pieces`,
      payload: piece('top'),
    });
    expect(res.statusCode).toBe(400);
    expect(
      await t.db.$count(
        inspirationPiece,
        eq(inspirationPiece.inspirationId, id),
      ),
    ).toBe(12);
    const body = unescapeHtml(
      (await t.inject({ method: 'GET', url: `/inspiration/${id}` })).body,
    );
    expect(body).toContain(text('inspiration.PIECES_FULL', { max: 12 }));
  });

  it('recreates a look from the owner’s closet in one statement: the closest first, the alternates, the missing', async () => {
    const cookie = await t.register('recreator@example.com');
    const othersTee = await createGarment(t, {
      name: 'Their tee',
      category: 'tops',
    });
    const { id, navyBlazer, blackJacket, whiteTee, greyTee } =
      await closetAndLook(cookie);

    let res!: Awaited<ReturnType<typeof t.inject>>;
    const { statements } = await recordQueries(async () => {
      res = await t.inject({
        method: 'GET',
        url: `/inspiration/${id}/recreate`,
        headers: { cookie },
      });
    });
    expect(res.statusCode).toBe(200);
    // The session's, then the look, the closet and its rules in one.
    expect(statements).toBe(2);
    const body = unescapeHtml(res.body);
    const matchesOf = (position: number) => {
      const section = body
        .split(`data-recreate-piece="${position}"`)[1]
        ?.split('data-recreate-piece=')[0];
      return [...(section ?? '').matchAll(/data-match="(\d+)"/g)].map((m) =>
        Number(m[1]),
      );
    };
    // The blazer, then the black jacket (black is close to navy).
    expect(matchesOf(0)).toEqual([navyBlazer, blackJacket]);
    expect(matchesOf(1)).toEqual([whiteTee, greyTee]);
    expect(matchesOf(2)).toEqual([]);
    expect(body).toMatch(/data-recreate-piece="2"[^>]*data-missing=""/);
    expect(body).toContain(text('inspiration.MISSING'));
    expect(body).toContain(
      text('inspiration.IN_CLOSET', { matched: 2, of: 3 }),
    );
    // The owner's closet only: another user's white tee never shows.
    expect(body).not.toContain(`data-match="${othersTee}"`);
  });

  it('saves the chosen garments as an outfit named after the look, recording each choice; the same save twice is one outfit', async () => {
    const cookie = await t.register('look-saver@example.com');
    const { id, blackJacket } = await closetAndLook(cookie, 'Jacket weather');
    const save = (payload: Record<string, unknown>) =>
      t.inject({
        method: 'POST',
        url: `/inspiration/${id}/recreate/outfit`,
        payload,
        headers: { cookie },
      });

    // The alternate jacket for the blazer, None for the tee.
    let res!: Awaited<ReturnType<typeof t.inject>>;
    const { statements } = await recordQueries(async () => {
      res = await save({
        position: ['0', '1'],
        garment: [String(blackJacket), ''],
      });
    });
    expect(res.statusCode, res.body).toBe(303);
    // The session, begin, the owner lock, the look locked, its pieces' roles,
    // the garments locked (with the outfit they already are), the outfit
    // and its slots, the choices recorded, commit.
    expect(statements).toBe(10);
    const outfitId = Number(
      /^\/outfits\/(\d+)$/.exec(String(res.headers.location))?.[1],
    );
    expect(outfitId).toBeGreaterThan(0);
    const [saved] = await t.db
      .select()
      .from(outfit)
      .where(eq(outfit.id, outfitId));
    expect(saved.name).toBe('Jacket weather');
    const slots = await t.db
      .select({ garmentId: outfitSlot.garmentId })
      .from(outfitSlot)
      .where(eq(outfitSlot.outfitId, outfitId));
    expect(slots).toEqual([{ garmentId: blackJacket }]);
    expect(await matchedOf(id)).toEqual([blackJacket, null, null]);
    expect(t.logs.ops('inspiration.outfit.saved')).toContainEqual(
      expect.objectContaining({
        inspirationId: id,
        outfitId,
        garments: 1,
        changed: true,
      }),
    );

    // The page centres the choice made, not the closest.
    const page = unescapeHtml(
      (
        await t.inject({
          method: 'GET',
          url: `/inspiration/${id}/recreate`,
          headers: { cookie },
        })
      ).body,
    );
    expect(page).toContain(`name="garment" value="${blackJacket}"`);
    expect(page).toMatch(
      new RegExp(`data-snap-value="${blackJacket}"[^>]*data-selected=""`),
    );
    expect(page).toContain(text('inspiration.SAVE_OUTFIT'));

    // A double tap: the outfit the first made, nothing created.
    const again = await save({
      position: ['0', '1'],
      garment: [String(blackJacket), ''],
    });
    expect(again.headers.location).toBe(`/outfits/${outfitId}?alreadySaved=1`);
    expect(
      await t.db.$count(
        outfit,
        eq(outfit.ownerId, await userIdOf(t, 'look-saver@example.com')),
      ),
    ).toBe(1);
  });

  it('refuses a save whole: nothing chosen, a choice of another kind or for no piece, another user’s garment, a malformed post', async () => {
    const cookie = await t.register('look-refused@example.com');
    const userId = await userIdOf(t, 'look-refused@example.com');
    const { id, navyBlazer, whiteTee } = await closetAndLook(cookie);
    const othersTee = await createGarment(t, {
      name: 'Their tee',
      category: 'tops',
    });
    const save = (payload: Record<string, unknown>) =>
      t.inject({
        method: 'POST',
        url: `/inspiration/${id}/recreate/outfit`,
        payload,
        headers: { cookie },
      });
    for (const [payload, status] of [
      [{ position: ['0', '1'], garment: ['', ''] }, 400],
      [{ position: ['0', '1'], garment: [String(navyBlazer)] }, 400],
      [
        {
          position: ['0', '0'],
          garment: [String(navyBlazer), String(navyBlazer)],
        },
        400,
      ],
      [{ position: '0', garment: 'blazer' }, 400],
      // The tee is not a layer, and the look has no piece 7: the page is stale.
      [{ position: ['0'], garment: [String(whiteTee)] }, 409],
      [{ position: ['7'], garment: [String(navyBlazer)] }, 409],
      [{ position: ['1'], garment: [String(othersTee)] }, 404],
    ] as const) {
      const res = await save(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(status);
    }
    expect(await t.db.$count(outfit, eq(outfit.ownerId, userId))).toBe(0);
    expect(await matchedOf(id)).toEqual([null, null, null]);
  });

  it("never gives a removed piece's position to a new one: a stale save is a 409, not applied to the replacement", async () => {
    const cookie = await t.register('look-positions@example.com');
    const { id, whiteTee } = await closetAndLook(cookie);
    const sneakers = await wear(
      cookie,
      'White sneakers',
      'footwear',
      'sneakers',
      'white',
    );
    const post = (url: string, payload: Record<string, unknown> = {}) =>
      t.inject({ method: 'POST', url, payload, headers: { cookie } });
    // The look has pieces 0 to 2; the match view (stale) will post piece 2.
    expect((await post(`/inspiration/${id}/pieces/2/delete`)).statusCode).toBe(
      303,
    );
    const added = await post(
      `/inspiration/${id}/pieces`,
      piece('footwear/sneakers', 'white', '', 'solid'),
    );
    expect(added.statusCode).toBe(303);
    const positions = (
      await t.db
        .select({ position: inspirationPiece.position })
        .from(inspirationPiece)
        .where(eq(inspirationPiece.inspirationId, id))
        .orderBy(inspirationPiece.position)
    ).map((row) => row.position);
    expect(positions).toEqual([0, 1, 3]);

    const stale = await post(`/inspiration/${id}/recreate/outfit`, {
      position: ['1', '2'],
      garment: [String(whiteTee), String(sneakers)],
    });
    expect(stale.statusCode).toBe(409);
    expect(await matchedOf(id)).toEqual([null, null, null]);
  });

  it('refuses one garment chosen for two pieces: a 409, nothing saved or recorded', async () => {
    const email = 'look-duplicate@example.com';
    const cookie = await t.register(email);
    const tee = await wear(cookie, 'White tee', 'tops', 't-shirt', 'white');
    const shirt = await wear(cookie, 'White shirt', 'tops', 't-shirt', 'white');
    const { id } = await addLook(t, photo, cookie);
    for (const payload of [
      piece('top/t-shirt', 'white'),
      piece('top/t-shirt', 'white'),
    ]) {
      await t.inject({
        method: 'POST',
        url: `/inspiration/${id}/pieces`,
        payload,
        headers: { cookie },
      });
    }
    const save = (garment: number[]) =>
      t.inject({
        method: 'POST',
        url: `/inspiration/${id}/recreate/outfit`,
        payload: { position: ['0', '1'], garment: garment.map(String) },
        headers: { cookie },
      });
    const dup = await save([tee, tee]);
    expect(dup.statusCode).toBe(409);
    expect(
      await t.db.$count(outfit, eq(outfit.ownerId, await userIdOf(t, email))),
    ).toBe(0);
    expect(await matchedOf(id)).toEqual([null, null]);
    expect((await save([tee, shirt])).statusCode).toBe(303);
  });

  it('a piece already on the wishlist takes no garment from the closet assignment: the next piece keeps the only match', async () => {
    const cookie = await t.register('look-wishlisted@example.com');
    const tee = await wear(cookie, 'Only tee', 'tops', 't-shirt', 'white');
    const { id } = await addLook(t, photo, cookie);
    for (const payload of [
      piece('top/t-shirt', 'white'),
      piece('top/t-shirt', 'white'),
    ]) {
      const res = await t.inject({
        method: 'POST',
        url: `/inspiration/${id}/pieces`,
        payload,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(303);
    }
    const found = await t.inject({
      method: 'POST',
      url: `/inspiration/${id}/pieces/0/find`,
      headers: { cookie },
    });
    expect(found.statusCode).toBe(303);

    const page = unescapeHtml(
      (
        await t.inject({
          method: 'GET',
          url: `/inspiration/${id}/recreate`,
          headers: { cookie },
        })
      ).body,
    );
    const second = page
      .split('data-recreate-piece="1"')[1]
      ?.split('data-recreate-piece=')[0];
    expect(page).toContain('data-wishlisted=');
    expect(second).toContain(`data-snap-value="${tee}"`);
    expect(page).not.toContain('data-missing=""');
    expect(page).toContain(text('inspiration.SAVE_OUTFIT'));
  });

  it('a piece edit and the save take turns on the look: a role changed under the save refuses it, recording nothing', async () => {
    const email = 'look-raced@example.com';
    const cookie = await t.register(email);
    const userId = await userIdOf(t, email);
    const { id, whiteTee } = await closetAndLook(cookie);
    // The autosave holds the look's lock with piece 1 (a top) now a bottom;
    // the save, posted for a top, waits, then reads the role as it is.
    const [, res] = await interleave(
      t.db,
      (tx) =>
        updateInspirationPiece(tx, id, 1, userId, {
          role: 'bottom',
          type: null,
          colors: ['white'],
          pattern: null,
        }),
      () =>
        t.inject({
          method: 'POST',
          url: `/inspiration/${id}/recreate/outfit`,
          payload: { position: ['1'], garment: [String(whiteTee)] },
          headers: { cookie },
        }),
    );
    expect(res.statusCode).toBe(409);
    expect(await matchedOf(id)).toEqual([null, null, null]);
    expect(await t.db.$count(outfit, eq(outfit.ownerId, userId))).toBe(0);
  });

  it('finds a missing piece: one wishlist item with its kind and colours, noting the look, shown on the match view; a double tap makes one', async () => {
    const cookie = await t.register('look-finder@example.com');
    const userId = await userIdOf(t, 'look-finder@example.com');
    const { id } = await closetAndLook(cookie, 'Summer whites');
    const find = () =>
      t.inject({
        method: 'POST',
        url: `/inspiration/${id}/pieces/2/find`,
        headers: { cookie },
      });

    const before = unescapeHtml(
      (
        await t.inject({
          method: 'GET',
          url: `/inspiration/${id}/recreate`,
          headers: { cookie },
        })
      ).body,
    );
    expect(before).toContain(`formaction="/inspiration/${id}/pieces/2/find"`);

    let res!: Awaited<ReturnType<typeof t.inject>>;
    const { statements } = await recordQueries(async () => {
      res = await find();
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(
      `/inspiration/${id}/recreate#recreate-piece-2`,
    );
    // The session, begin, the piece locked, the item, the piece's match, commit.
    expect(statements).toBe(6);
    const items = await t.db
      .select()
      .from(garment)
      .where(and(eq(garment.ownerId, userId), eq(garment.status, 'wishlist')));
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({
      name: text('property.type.sneakers'),
      category: 'footwear',
      type: 'sneakers',
      colors: ['white'],
      // Footwear has no pattern.
      pattern: null,
      sourceUrl: null,
      notes: text('inspiration.FOUND_NOTE', { look: 'Summer whites' }),
    });
    expect(await matchedOf(id)).toEqual([null, null, item.id]);

    const after = unescapeHtml(
      (
        await t.inject({
          method: 'GET',
          url: `/inspiration/${id}/recreate`,
          headers: { cookie },
        })
      ).body,
    );
    expect(after).toContain(`data-wishlisted="${item.id}"`);
    expect(after).toContain(text('inspiration.ON_WISHLIST'));
    expect(after).not.toContain(`/inspiration/${id}/pieces/2/find`);

    // A second tap (submit-once is the client's guard): the same item.
    expect((await find()).statusCode).toBe(303);
    expect(
      await t.db.$count(
        garment,
        and(eq(garment.ownerId, userId), eq(garment.status, 'wishlist')),
      ),
    ).toBe(1);
    expect(t.logs.ops('inspiration.piece.found')).toContainEqual(
      expect.objectContaining({
        inspirationId: id,
        position: 2,
        userId,
        garmentId: item.id,
        changed: false,
      }),
    );
    // An unknown piece is a 404, writing nothing.
    const unknown = await t.inject({
      method: 'POST',
      url: `/inspiration/${id}/pieces/9/find`,
      headers: { cookie },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('deleting the account removes a look, its file row and every variant, leaving nothing to reconcile', async () => {
    const email = 'look-leaver@example.com';
    const cookie = await t.register(email);
    const userId = await userIdOf(t, email);
    const { id, fileName } = await addLook(t, photo, cookie);
    const variants = [
      fileName,
      variantFileName(fileName, 'thumb'),
      variantFileName(fileName, 'nobg'),
    ];
    expect(await stored()).toContain(fileName);

    const res = await t.inject({
      method: 'POST',
      url: '/auth/delete-account',
      payload: { email, password: TEST_PASSWORD },
      headers: { cookie },
    });

    expect(res.statusCode).toBe(302);
    expect(await lookRow(id)).toBeUndefined();
    expect(await photoRow(t, fileName)).toBeUndefined();
    expect(
      await t.db.select().from(file).where(eq(file.createdById, userId)),
    ).toEqual([]);
    const files = await stored();
    for (const name of variants) expect(files).not.toContain(name);

    const report = await reconcileStorage({
      db: t.db,
      photos: t.photos,
      timeZone: t.timeZone,
      logger: silentLogger,
    });
    expect(report.refused).toBeUndefined();
    expect(report).toMatchObject({
      orphanedRowsDeleted: 0,
      orphanedSetsQuarantined: 0,
    });
  });
});
