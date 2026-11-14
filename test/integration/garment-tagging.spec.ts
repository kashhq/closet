import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment } from '../../src/db/schema';
import {
  createTestApp,
  recordQueries,
  type TestApp,
  asFixture,
} from './harness';
import {
  expectFragment,
  expectNativePostForms,
  expectNoRawI18nKeys,
} from './pages';

/**
 * Tagging mode (#12, slice 12c): the wardrobe prompts while garments lack
 * their type (where the category has types), warmth (where the role has
 * one) or formality; /wardrobe/tag shows them one at a time, newest first;
 * a tap saves at once and a type fills its presets only where nothing is
 * set, answering the chips alone (the card's form is an AutosaveForm,
 * src/web/autosave.tsx); Next saves the card and moves past it, so a
 * garment left alone waits for the next pass.
 */

type Props = Record<string, unknown>;

describe('tagging mode', () => {
  let t: TestApp;

  const create = async (payload: Props) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      payload: { props: '1', ...payload },
    });
    expect(res.statusCode).toBe(302);
    return Number(/^\/wardrobe\/(\d+)/.exec(String(res.headers.location))![1]);
  };
  const row = async (id: number) =>
    (await t.db.select().from(garment).where(eq(garment.id, id)))[0];
  const tag = (id: number, payload: Props) =>
    t.inject({
      method: 'POST',
      url: `/wardrobe/${id}/tag`,
      payload,
      headers: { 'hx-request': 'true' },
    });
  const card = (query = '') =>
    t.inject({
      method: 'GET',
      url: `/wardrobe/tag${query}`,
      headers: { 'hx-request': 'true' },
    });

  let ids: Record<'done' | 'bag' | 'heavy' | 'blank' | 'archived', number>;

  beforeAll(async () => {
    t = await createTestApp();
    ids = {
      // Fully tagged: never on a card.
      done: await create({
        name: 'Done tee',
        category: 'tops',
        type: 't-shirt',
        warmth: '2',
        formality: '2',
      }),
      // A bag has no warmth: only its type and formality are asked.
      bag: await create({ name: 'Tote', category: 'bags', type: 'tote' }),
      // Warmth chosen on the form (a 6 oz tee), type still missing.
      heavy: await create({
        name: 'Heavy tee',
        category: 'tops',
        warmth: '3',
        fabricWeight: '6',
      }),
      blank: await create({ name: 'Blank tee', category: 'tops' }),
      archived: await create({ name: 'Old tee', category: 'tops' }),
    };
    await t.inject({
      method: 'POST',
      url: `/wardrobe/${ids.archived}/archive`,
    });
  });

  afterAll(() => t?.cleanup());

  it('prompts on the wardrobe with how many need details', async () => {
    const res = await t.inject({ method: 'GET', url: '/wardrobe' });
    expectNoRawI18nKeys(res);
    // Tote, Heavy tee, Blank tee; not the tagged or the archived one.
    expect(res.body).toContain('3 to tag');
    expect(res.body).toContain('href="/wardrobe/tag"');
  });

  it('shows the newest garment that needs details first, as a full page', async () => {
    const res = await t.inject({ method: 'GET', url: '/wardrobe/tag' });
    expect(res.statusCode).toBe(200);
    expectNoRawI18nKeys(res);
    expectNativePostForms(res);
    expect(res.body).toContain('Blank tee');
    expect(res.body).toContain('3 left to tag');
    // One form, saved on every tap and posted by Next: its queue carries a
    // tap made just before Next along with it.
    expect(res.body).toContain(`hx-post="/wardrobe/${ids.blank}/tag"`);
    expect(res.body).toContain('hx-target="#tag-fields"');
    expect(res.body).toMatch(
      /<button type="submit" name="next" value="1" class="btn btn-primary">Next<\/button>/,
    );
  });

  // A round trip per statement in production (#156, #159): the card and its
  // count left are one statement, and so are a tap's chips and count.
  it('reads the card, or a tap’s answer, with its count left in one statement', async () => {
    const page = await recordQueries(() =>
      t.inject({ method: 'GET', url: '/wardrobe/tag' }),
    );
    // The session, then the card.
    expect(page.statements).toBe(2);
    const past = await recordQueries(() => card(`?before=${ids.bag}`));
    expect(past.statements).toBe(2);
    expect(past.sql.join('\n')).toContain('count(*) over ()');

    // A tap that changes nothing: the session, the garment, its answer.
    const current = await row(ids.blank);
    const tap = await recordQueries(() =>
      tag(ids.blank, { type: current.type ?? '' }),
    );
    expect(tap.statements).toBe(3);
    expect(await row(ids.blank)).toEqual(current);
  });

  it('moves past a garment with Next, leaving it for the next pass', async () => {
    const res = await tag(ids.blank, { next: '1' });
    expect(res.statusCode).toBe(200);
    expectFragment(res);
    // The next garment's card, in place of this one's.
    expect(res.headers['hx-retarget']).toBe('#tag-card');
    expect(res.headers['hx-reswap']).toBe('outerHTML');
    expect(res.body).toContain('id="tag-card"');
    expect(res.body).toContain('Heavy tee');
    expect(res.body).not.toContain('Blank tee');
    // Nothing tapped, nothing written: no presets for a garment left alone.
    expect(await row(ids.blank)).toMatchObject({
      type: null,
      warmth: null,
      formality: null,
    });
  });

  it('still answers the card after a garment to pages cached with the Next link', async () => {
    const res = await card(`?before=${ids.blank}`);
    expectFragment(res);
    expect(res.body).toContain('Heavy tee');
    expect(res.body).not.toContain('Blank tee');
  });

  it('ends a pass that skipped garments with how many are left, never "all done"', async () => {
    // Past the tote, the oldest still needing details: nothing older left,
    // but the three skipped on the way still need them.
    const res = await card(`?before=${ids.bag}`);
    expectFragment(res);
    expectNoRawI18nKeys(res);
    expect(res.body).toContain('id="tag-card"');
    expect(res.body).not.toContain('Every garment has its details.');
    expect(res.body).toContain(
      'End of this pass. 3 garments you skipped still need details.',
    );
    expect(res.body).toContain('href="/wardrobe/tag"');
    expect(res.body).toContain('>Start over</a>');
  });

  it('asks a bag only what a bag has', async () => {
    const res = await card(`?before=${ids.heavy}`);
    expect(res.body).toContain('Tote');
    expect(res.body).toContain('name="formality"');
    expect(res.body).not.toContain('name="warmth"');
  });

  it('fills a type’s presets into what is unset, and saves at once', async () => {
    const res = await tag(ids.blank, { type: 't-shirt' });
    expect(res.statusCode).toBe(200);
    expectFragment(res);
    expect(res.body).toMatch(/name="warmth" value="2"[^>]*checked/);
    // The chips and the count, never the form or the card around them.
    expect(res.body).not.toContain('id="tag-card"');
    expect(res.body).not.toContain('hx-post');
    expect(res.body).toMatch(
      /<p id="tag-left" class="[^"]*" hx-swap-oob="true">2 left to tag<\/p>/,
    );
    expect(await row(ids.blank)).toMatchObject({
      type: 't-shirt',
      warmth: 2,
      formality: 2,
      sleeve: 'short',
    });
  });

  it('never overwrites a warmth the form set (the heavy tee stays warm)', async () => {
    await tag(ids.heavy, { type: 't-shirt' });
    expect(await row(ids.heavy)).toMatchObject({
      type: 't-shirt',
      warmth: 3,
      formality: 2,
      fabricWeight: 203,
    });
  });

  it('replaces a value the user taps', async () => {
    await tag(ids.heavy, { type: 't-shirt', warmth: '4', formality: '3' });
    expect(await row(ids.heavy)).toMatchObject({ warmth: 4, formality: 3 });
  });

  it('moves the first type’s presets when another type is tapped', async () => {
    const id = await create({ name: 'Undecided', category: 'tops' });
    await tag(id, { type: 'tank' });
    expect(await row(id)).toMatchObject({ warmth: 1, sleeve: 'sleeveless' });
    // The card saved the tank's presets; a sweater replaces them.
    await tag(id, { type: 'sweater' });
    expect(await row(id)).toMatchObject({
      type: 'sweater',
      warmth: 4,
      formality: 3,
      sleeve: 'long',
    });
    // A value tapped in between is the user's and stays.
    await tag(id, { type: 'sweater', warmth: '5' });
    await tag(id, { type: 'cardigan' });
    expect(await row(id)).toMatchObject({ warmth: 5, sleeve: 'long' });
    await t.inject({ method: 'POST', url: `/wardrobe/${id}/archive` });
  });

  it('saves the taps Next carries, then moves on', async () => {
    const id = await create({ name: 'Quick polo', category: 'tops' });
    const res = await tag(id, {
      type: 'polo',
      warmth: '4',
      formality: '3',
      next: '1',
    });
    expect(res.headers['hx-retarget']).toBe('#tag-card');
    expect(res.body).not.toContain('Quick polo');
    expect(await row(id)).toMatchObject({
      type: 'polo',
      warmth: 4,
      formality: 3,
      sleeve: 'short',
    });
    expect(t.logs.messages('info', 'Web')).toContainEqual(
      `Tagging: user ${t.owner.id} moved on from garment ${id}`,
    );
    await t.inject({ method: 'POST', url: `/wardrobe/${id}/archive` });
  });

  it('ignores a warmth posted for a bag', async () => {
    await tag(ids.bag, { warmth: '3', formality: '2' });
    expect(await row(ids.bag)).toMatchObject({ warmth: null, formality: 2 });
  });

  it('refuses a type the category does not have', async () => {
    const res = await tag(ids.bag, { type: 't-shirt' });
    expect(res.statusCode).toBe(400);
    expect((await row(ids.bag)).type).toBe('tote');
  });

  it('logs the tap', async () => {
    await tag(ids.blank, { formality: '3' });
    expect(t.logs.messages('info', 'Web')).toContainEqual(
      expect.stringMatching(
        new RegExp(`^Garment ${ids.blank} tagged by user \\d+: formality$`),
      ),
    );
  });

  it('writes nothing for a card left alone: Next posts its checked chips, which change nothing', async () => {
    // Type and warmth set, formality missing: on the card with two chips
    // checked, which the form posts on Next as on every tap.
    const id = await create({ name: 'Half tee', category: 'tops' });
    await asFixture(t.db, (tx) =>
      tx
        .update(garment)
        .set({ type: 't-shirt', warmth: 3, formality: null })
        .where(eq(garment.id, id)),
    );
    const before = await row(id);
    t.logs.clear();

    let res!: Awaited<ReturnType<typeof tag>>;
    const record = await recordQueries(async () => {
      res = await tag(id, { type: 't-shirt', warmth: '3', next: '1' });
    });
    expect(record.sql.filter((sql) => /^\s*update\b/i.test(sql))).toEqual([]);
    expect(await row(id)).toEqual(before);
    // The same type again brings no presets: formality stays the person's.
    expect((await row(id)).formality).toBeNull();
    expect(t.logs.messages('info', 'Web')).not.toContainEqual(
      expect.stringContaining(`Garment ${id} tagged`),
    );
    // The next card, all the same.
    expect(res.headers['hx-retarget']).toBe('#tag-card');
    expect(res.body).toContain('id="tag-card"');
    expect(res.body).not.toContain('Half tee');

    // A tap that changes one field writes that field alone.
    t.logs.clear();
    await tag(id, { type: 't-shirt', warmth: '3', formality: '4' });
    expect(await row(id)).toEqual({
      ...before,
      formality: 4,
      // Stamped by the sync triggers (#196a).
      revision: expect.any(Number),
      updatedAt: expect.any(Date),
    });
    expect(t.logs.messages('info', 'Web')).toContainEqual(
      `Garment ${id} tagged by user ${t.owner.id}: formality`,
    );
    await t.inject({ method: 'POST', url: `/wardrobe/${id}/archive` });
  });

  it('takes "Other" where no type of the category applies, and the garment leaves the queue (#685)', async () => {
    const id = await create({
      name: 'Hair clip',
      category: 'accessories',
      warmth: '1',
      formality: '2',
    });
    const res = await card();
    expect(res.body).toContain('Hair clip');
    expect(res.body).toContain('1 left to tag');
    expect(res.body).toContain('value="other"');
    expect(res.body).toContain('aria-label="Socks"');

    const tapped = await tag(id, {
      type: 'other',
      warmth: '1',
      formality: '2',
    });
    expect(tapped.statusCode).toBe(200);
    expect(tapped.body).toContain('0 left to tag');
    expect(await row(id)).toMatchObject({ type: 'other', warmth: 1 });
    // "Other" brings no presets, so what was chosen stays.
    expect((await row(id)).formality).toBe(2);

    // Tops always have a closest type: no "Other" on their card.
    const tee = await create({ name: 'Odd top', category: 'tops' });
    const tops = await card();
    expect(tops.body).toContain('Odd top');
    expect(tops.body).toContain('aria-label="Sports top"');
    expect(tops.body).not.toContain('value="other"');
    await t.inject({ method: 'POST', url: `/wardrobe/${tee}/archive` });
  });

  it('says so when every garment is tagged, and the prompt goes', async () => {
    const res = await t.inject({ method: 'GET', url: '/wardrobe/tag' });
    expectNoRawI18nKeys(res);
    expect(res.body).toContain('Every garment has its details.');
    const wardrobe = await t.inject({ method: 'GET', url: '/wardrobe' });
    expect(wardrobe.body).not.toContain('to tag');
  });
});
