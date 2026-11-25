import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment } from '../../src/db/schema';
import { GARMENT_COLORS } from '../../src/wardrobe/properties';
import { variantFileName } from '../../src/web/files/image-variant';
import { garmentRow, jpegPhoto, uploadPhoto } from './garments';
import {
  createTestApp,
  hxLocationPath,
  TestApp,
  userIdOf,
  TEST_PASSWORD,
} from './harness';
import { expectOfflineGuarded } from './pages';

/**
 * The garment edit, clone and archive paths: the forms render the stored
 * values, POST /wardrobe/:id writes them, a clone lands in the requester's
 * wardrobe with its own copy of the photo set, and archive toggles. Alice owns the garments; Bob holds a MANAGE share on her
 * wardrobe; Carol has no share.
 */

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Every field the garment form (src/web/wardrobe/garment-form.tsx) posts. */
const FORM = {
  name: 'Black Linen Blazer',
  category: 'jacket',
  brand: 'Uniqlo',
  color: ['black', 'white'],
  size: 'm',
  washingDetails: 'Dry clean only',
  dateAquired: '2024-03-15',
  notes: 'Summer weddings',
};

describe('garment edit, clone and archive', () => {
  let t: TestApp;
  let alice: { id: number; cookie: string };
  let bob: { id: number; cookie: string };
  let carol: { cookie: string };
  let garmentId: number;

  const userId = (email: string) => userIdOf(t, email);

  const load = async (id: number) => (await garmentRow(t, id))!;

  const post = (
    url: string,
    payload: Record<string, unknown>,
    cookie: string,
  ) => t.inject({ method: 'POST', url, payload, headers: { cookie } });

  const get = (url: string, cookie: string) =>
    t.inject({ method: 'GET', url, headers: { cookie } });

  const idFromRedirect = (location: unknown) => {
    const match = /^\/wardrobe\/(\d+)/.exec(String(location));
    if (!match) throw new Error(`Unexpected redirect: ${String(location)}`);
    return Number(match[1]);
  };

  /** Alice's garment with every field set and a photo. */
  const createFullGarment = async (overrides: Partial<typeof FORM> = {}) => {
    const res = await post(
      '/wardrobe',
      { ...FORM, ...overrides },
      alice.cookie,
    );
    expect(res.statusCode).toBe(302);
    const id = idFromRedirect(res.headers.location);
    await uploadPhoto(t, id, await jpegPhoto(), alice.cookie);
    return id;
  };

  const photoFiles = (fileName: string) =>
    (['original', 'thumb'] as const).map((variant) =>
      join(t.dataPath, variantFileName(fileName, variant)),
    );

  beforeAll(async () => {
    t = await createTestApp();
    alice = {
      cookie: await t.register('alice@example.com'),
      id: await userId('alice@example.com'),
    };
    bob = {
      cookie: await t.register('bob@example.com'),
      id: await userId('bob@example.com'),
    };
    carol = { cookie: await t.register('carol@example.com') };

    // Alice shares her wardrobe with Bob (MANAGE), as the manage page does.
    const invite = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission: 'MANAGE', currentPassword: TEST_PASSWORD },
      headers: { cookie: alice.cookie, 'hx-request': 'true' },
    });
    const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
      invite.body,
    )?.[1];
    if (!token) throw new Error(`No invite URL in partial:\n${invite.body}`);
    const accepted = await post(
      `/wardrobe-share/invite/${token}/accept`,
      {},
      bob.cookie,
    );
    expect(accepted.headers.location).toBe(`/wardrobe?ownerId=${alice.id}`);

    garmentId = await createFullGarment();
  });

  afterAll(() => t?.cleanup());

  describe('GET /wardrobe/:id/edit', () => {
    it('renders the stored values into the form', async () => {
      const res = await get(`/wardrobe/${garmentId}/edit`, alice.cookie);
      expect(res.statusCode).toBe(200);
      const html = res.body;
      expectOfflineGuarded(res, `/wardrobe/${garmentId}`);
      expect(html).toContain('value="Black Linen Blazer"');
      expect(html).toContain('value="jacket"');
      expect(html).toContain('value="Uniqlo"');
      // Stored normalised: "m" -> "Medium".
      expect(html).toContain('value="Medium"');
      expect(html).toContain('value="2024-03-15"');
      expect(html).toMatch(/name="washingDetails"[^>]*>\s*Dry clean only/);
      expect(html).toMatch(/name="notes"[^>]*>\s*Summer weddings/);
      for (const color of ['black', 'white']) {
        expect(html).toMatch(
          new RegExp(`name="color" value="${color}"\\s+checked`),
        );
      }
      expect(html).not.toMatch(/name="color" value="red"\s+checked/);
    });

    // color-picker.ts only shows and hides the pills the server rendered.
    it('renders every colour pill, shown only for the ticked colours', async () => {
      const res = await get(`/wardrobe/${garmentId}/edit`, alice.cookie);
      const tag = (attribute: string) =>
        res.body.match(new RegExp(`<span[^>]*${attribute}[^>]*>`))?.[0];
      for (const color of GARMENT_COLORS) {
        const pill = tag(`data-color-pill="${color}"`);
        expect(pill, color).toBeDefined();
        expect(/\shidden/.test(pill!), color).toBe(!FORM.color.includes(color));
      }
      expect(tag('data-color-picker-part="placeholder"')).toMatch(/\shidden/);
    });

    // Not in any wardrobe carol can see: as unknown as a missing id.
    it('does not exist for a user without a share', async () => {
      const res = await get(`/wardrobe/${garmentId}/edit`, carol.cookie);
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /wardrobe/:id', () => {
    it('writes every field and redirects to the garment', async () => {
      const id = await createFullGarment();
      const res = await post(
        `/wardrobe/${id}`,
        {
          name: 'Navy Linen Blazer',
          category: 'coat',
          brand: '',
          color: ['blue'],
          size: 'xl',
          washingDetails: 'Hand wash cold',
          dateAquired: '2025-01-02',
          notes: 'Tailored in May',
        },
        alice.cookie,
      );
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`/wardrobe/${id}`);

      const garment = await load(id);
      expect(garment).toMatchObject({
        name: 'Navy Linen Blazer',
        category: 'coat',
        // A cleared field is no value, not an empty string.
        brand: null,
        colors: ['blue'],
        size: 'X-Large',
        washingDetails: 'Hand wash cold',
        notes: 'Tailored in May',
        status: 'closet',
      });
      expect(garment.acquiredOn).toBe('2025-01-02');
      expect(garment.ownerId).toBe(alice.id);
      // The fields-only form never touches the photo.
      expect(garment.photo).toBeDefined();
    });

    it('a MANAGE grantee edits through ?ownerId and is sent back there', async () => {
      const id = await createFullGarment();
      const res = await post(
        `/wardrobe/${id}?ownerId=${alice.id}`,
        { ...FORM, name: 'Edited by Bob' },
        bob.cookie,
      );
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`/wardrobe/${id}?ownerId=${alice.id}`);
      const garment = await load(id);
      expect(garment.name).toBe('Edited by Bob');
      expect(garment.ownerId).toBe(alice.id);
    });

    it('a user without a share cannot edit', async () => {
      const res = await post(
        `/wardrobe/${garmentId}`,
        { ...FORM, name: 'Hijacked' },
        carol.cookie,
      );
      expect(res.statusCode).toBe(404);
      expect((await load(garmentId)).name).toBe(FORM.name);
    });

    // A blank category used to be stored, and the garment dropped out of
    // every category filter.
    it.each(['', '   '])(
      'a blank category (%j) re-renders the form with a 400 and changes nothing',
      async (category) => {
        const id = await createFullGarment();
        const res = await post(
          `/wardrobe/${id}`,
          { ...FORM, name: 'Not saved', category },
          alice.cookie,
        );
        expect(res.statusCode).toBe(400);
        expect(res.body).toContain(`action="/wardrobe/${id}"`);
        // The form keeps what was typed, and says what is wrong.
        expect(res.body).toContain('value="Not saved"');
        expect(res.body).toContain('Give the garment a category');
        expect(await load(id)).toMatchObject({
          name: FORM.name,
          category: FORM.category,
        });
      },
    );

    // An unparseable date used to reach Postgres: a 500.
    it.each(['not-a-date', '2024-02-30', '2024-3-5'])(
      'an invalid date (%j) is refused with 400 and the row is unchanged',
      async (dateAquired) => {
        const id = await createFullGarment();
        const res = await post(
          `/wardrobe/${id}`,
          { ...FORM, dateAquired },
          alice.cookie,
        );
        expect(res.statusCode).toBe(400);
        expect(res.body).toContain('Enter a real date');
        expect((await load(id)).acquiredOn).toBe(FORM.dateAquired);
      },
    );

    it('stores categories trimmed and lower case, and an empty date as none', async () => {
      const id = await createFullGarment();
      const res = await post(
        `/wardrobe/${id}`,
        { ...FORM, category: '  Outer Layer ', dateAquired: '' },
        alice.cookie,
      );
      expect(res.statusCode).toBe(302);
      expect(await load(id)).toMatchObject({
        category: 'outer layer',
        acquiredOn: null,
      });
    });

    // The form shows a built-in category by its label ("Tops") and posts what
    // it shows; the stored key must survive a save and a suggestion pick (#729).
    it('keeps a built-in category when the form is posted back unchanged or a suggestion is picked', async () => {
      const id = await createFullGarment({ category: 'tops' });
      const form = (await get(`/wardrobe/${id}/edit`, alice.cookie)).body;
      const shown = /name="category"[^>]*value="([^"]*)"/.exec(form)?.[1];
      expect(shown).toBeDefined();

      const unchanged = await post(
        `/wardrobe/${id}`,
        { ...FORM, category: shown },
        alice.cookie,
      );
      expect(unchanged.statusCode).toBe(302);
      expect((await load(id)).category).toBe('tops');

      const suggestions = [...form.matchAll(/<option value="([^"]*)"/g)].map(
        (match) => match[1],
      );
      const picked = suggestions.find((value) => /^tops$/i.test(value));
      expect(picked).toBeDefined();
      await post(
        `/wardrobe/${id}`,
        { ...FORM, category: 'jacket' },
        alice.cookie,
      );
      const pickedRes = await post(
        `/wardrobe/${id}`,
        { ...FORM, category: picked },
        alice.cookie,
      );
      expect(pickedRes.statusCode).toBe(302);
      expect((await load(id)).category).toBe('tops');
    });

    it('refuses a field longer than the form allows with a 400, writing nothing', async () => {
      const id = await createFullGarment();
      const res = await post(
        `/wardrobe/${id}`,
        { ...FORM, name: 'x'.repeat(201) },
        alice.cookie,
      );
      expect(res.statusCode).toBe(400);
      expect((await load(id)).name).toBe(FORM.name);
    });

    // Notes were varchar(255) until drizzle/0004_garment_web.sql: longer
    // ones were a 500.
    it('keeps notes longer than 255 characters', async () => {
      const id = await createFullGarment();
      const notes = 'Long care history. '.repeat(30);
      const res = await post(
        `/wardrobe/${id}`,
        { ...FORM, notes },
        alice.cookie,
      );
      expect(res.statusCode).toBe(302);
      expect((await load(id)).notes).toBe(notes);
    });

    it('keyword search finds a garment in its stored case', async () => {
      const res = await get('/wardrobe?keyword=Linen', alice.cookie);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Black Linen Blazer');
    });

    // LIKE is case-sensitive on Postgres; the search is ILIKE.
    it('keyword search ignores case', async () => {
      const res = await get('/wardrobe?keyword=blazer', alice.cookie);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Black Linen Blazer');
    });
  });

  describe('clone', () => {
    it('GET /wardrobe/:id/clone prefills the form from the source', async () => {
      const res = await get(
        `/wardrobe/${garmentId}/clone?ownerId=${alice.id}`,
        bob.cookie,
      );
      expect(res.statusCode).toBe(200);
      const html = res.body;
      expect(html).toContain(
        `action="/wardrobe/${garmentId}/clone?ownerId=${alice.id}"`,
      );
      expect(html).toContain('value="Black Linen Blazer (cloned)"');
      expect(html).toContain('value="jacket"');
      expect(html).toContain('value="Uniqlo"');
      expect(html).toContain('value="2024-03-15"');
      expect(html).toMatch(/name="washingDetails"[^>]*>\s*Dry clean only/);
    });

    it('POST creates the requester’s own garment with a copied photo set', async () => {
      const source = await load(garmentId);
      const res = await post(
        `/wardrobe/${garmentId}/clone?ownerId=${alice.id}`,
        { ...FORM, name: 'Black Linen Blazer (cloned)' },
        bob.cookie,
      );
      expect(res.statusCode).toBe(302);
      const cloneId = idFromRedirect(res.headers.location);
      expect(cloneId).not.toBe(garmentId);

      const clone = await load(cloneId);
      expect(clone.ownerId).toBe(bob.id);
      expect(clone).toMatchObject({
        name: 'Black Linen Blazer (cloned)',
        category: source.category,
        brand: source.brand,
        colors: source.colors,
        size: source.size,
        notes: source.notes,
        status: 'closet',
      });
      // A clone starts unshared, whatever its source's link (#669).
      expect(clone.shareableId).toBeNull();

      // Its own photo set: a new File row and new bytes, owned by Bob, while
      // the source's files stay where they were.
      expect(clone.photo).toBeDefined();
      expect(clone.photo!.fileName).not.toBe(source.photo!.fileName);
      expect(clone.photo!.createdById).toBe(bob.id);
      for (const path of photoFiles(clone.photo!.fileName)) {
        expect(await exists(path)).toBe(true);
      }
      for (const path of photoFiles(source.photo!.fileName)) {
        expect(await exists(path)).toBe(true);
      }

      // It shows in Bob's own wardrobe, not Alice's.
      const own = await get('/wardrobe?keyword=cloned', bob.cookie);
      expect(own.body).toContain(`/wardrobe/${cloneId}"`);
    });

    // The clone used to drop both.
    it('POST keeps washingDetails and dateAquired', async () => {
      const res = await post(
        `/wardrobe/${garmentId}/clone`,
        { ...FORM, name: 'Second copy' },
        alice.cookie,
      );
      expect(res.statusCode).toBe(302);
      const clone = await load(idFromRedirect(res.headers.location));
      expect(clone.washingDetails).toBe(FORM.washingDetails);
      expect(clone.acquiredOn).toBe(FORM.dateAquired);
    });

    it('a user without a share cannot clone', async () => {
      const before = await t.db.$count(garment);
      const res = await post(
        `/wardrobe/${garmentId}/clone?ownerId=${alice.id}`,
        FORM,
        carol.cookie,
      );
      expect(res.statusCode).toBe(404);
      expect(await t.db.$count(garment)).toBe(before);
    });
  });

  describe('POST /wardrobe/:id/archive and /restore', () => {
    it('archives, restores, and the list follows', async () => {
      const id = await createFullGarment({ name: 'Archive me' });
      const listed = async (query: string) =>
        (await get(`/wardrobe?${query}`, alice.cookie)).body.includes(
          `/wardrobe/${id}"`,
        );

      const archive = await post(`/wardrobe/${id}/archive`, {}, alice.cookie);
      expect(archive.statusCode).toBeLessThan(300);
      expect(hxLocationPath(archive)).toBe('/wardrobe');
      expect((await load(id)).status).toBe('archived');
      expect(await listed('keyword=Archive')).toBe(false);
      expect(await listed('keyword=Archive&archived=true')).toBe(true);
      const page = await get(`/wardrobe/${id}`, alice.cookie);
      expect(page.body).toContain(`hx-post="/wardrobe/${id}/restore"`);
      expect(page.body).not.toContain(`hx-post="/wardrobe/${id}/archive"`);

      const restore = await post(`/wardrobe/${id}/restore`, {}, alice.cookie);
      expect(hxLocationPath(restore)).toBe('/wardrobe');
      expect((await load(id)).status).toBe('closet');
      expect(await listed('keyword=Archive')).toBe(true);
    });

    // Each names its move: a stale page's second tap is refused, never the
    // opposite move the old toggle made.
    it('refuses a move the status does not take, with a 409', async () => {
      const id = await createFullGarment({ name: 'Stale tab' });
      expect(
        (await post(`/wardrobe/${id}/restore`, {}, alice.cookie)).statusCode,
      ).toBe(409);
      await post(`/wardrobe/${id}/archive`, {}, alice.cookie);
      expect(
        (await post(`/wardrobe/${id}/archive`, {}, alice.cookie)).statusCode,
      ).toBe(409);
      expect((await load(id)).status).toBe('archived');
      // The refusal's detail rides on the error handler's line (logDetail).
      expect(t.logs.messages('warn', 'Web')).toContain(
        `POST /wardrobe/${id}/archive -> 409: Only a garment in the closet can be archived (garment ${id} is archived)`,
      );
    });

    it('only the owner may archive or restore', async () => {
      for (const move of ['archive', 'restore']) {
        const res = await post(
          `/wardrobe/${garmentId}/${move}?ownerId=${alice.id}`,
          {},
          bob.cookie,
        );
        expect(res.statusCode).toBe(403);
      }
      expect((await load(garmentId)).status).toBe('closet');
    });
  });
});
