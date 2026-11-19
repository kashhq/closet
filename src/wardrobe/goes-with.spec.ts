import { describe, expect, it } from 'vitest';
import type { IdeaGarment } from './generator';
import {
  BEST_OUTFITS,
  goesWith,
  type GoesWithRequest,
  nearDuplicates,
  OUTFIT_COUNT_CAP,
  outfitCount,
  PARTNERS_PER_ROLE,
} from './goes-with';
import {
  builtInCategoriesOf,
  type Formality,
  type GarmentColor,
  type GarmentRole,
  type Pattern,
} from './properties';

/**
 * "Goes with my closet" (#18b): the count and its bound, the item locked
 * into every outfit and never drawn otherwise, the roles it pairs with (the
 * layers judged one by one), the best few at its formality, and
 * near-duplicate detection. The outfits themselves are the generator's
 * (generator.spec.ts covers its rules).
 */

let nextId = 1;

function garment(
  role: GarmentRole,
  options: {
    colors?: GarmentColor[];
    pattern?: Pattern | null;
    formality?: Formality | null;
    idleDays?: number | null;
  } = {},
): IdeaGarment {
  return {
    id: nextId++,
    role,
    category: builtInCategoriesOf(role)[0],
    type: null,
    colors: options.colors ?? ['black'],
    pattern: options.pattern ?? 'solid',
    formality: options.formality ?? null,
    weather: { role, warmth: 2, waterResistant: false, rainGear: false },
    idleDays: options.idleDays === undefined ? 5 : options.idleDays,
  };
}

function many(
  role: GarmentRole,
  n: number,
  colors: GarmentColor[] = ['black'],
) {
  return Array.from({ length: n }, () => garment(role, { colors }));
}

function request(
  item: IdeaGarment,
  closet: IdeaGarment[],
  avoid: [number, number][] = [],
): GoesWithRequest<IdeaGarment> {
  return { item, closet, avoid, rules: [], seed: 1 };
}

const ids = (garments: readonly { id: number }[]) => garments.map((g) => g.id);

describe('goesWith', () => {
  it('counts every distinct outfit the item makes, the item in each', () => {
    const item = garment('top', { colors: ['green'] });
    const closet = [...many('bottom', 3), ...many('footwear', 2)];
    const result = goesWith(request(item, closet));
    // 3 bottoms x 2 shoes: the whole space, found and counted exactly.
    expect(result).toMatchObject({ outfits: 6, capped: false });
    expect(result.best).toHaveLength(BEST_OUTFITS);
    for (const idea of result.best) {
      expect(ids(idea.garments)).toContain(item.id);
      expect(idea.garments.map((g) => g.role)).toEqual([
        'top',
        'bottom',
        'footwear',
      ]);
    }
  });

  it('stops counting at the bound: "50+"', () => {
    const item = garment('top', { colors: ['white'] });
    // 10 x 6 = 60 outfits, past the cap.
    const closet = [...many('bottom', 10), ...many('footwear', 6)];
    expect(OUTFIT_COUNT_CAP).toBe(50);
    expect(goesWith(request(item, closet))).toMatchObject({
      outfits: OUTFIT_COUNT_CAP,
      capped: true,
    });
    expect(outfitCount(request(item, closet))).toEqual({
      outfits: OUTFIT_COUNT_CAP,
      capped: true,
    });
    // Exactly at the cap is not past it.
    const exact = [...many('bottom', 10), ...many('footwear', 5)];
    expect(outfitCount(request(item, exact))).toEqual({
      outfits: 50,
      capped: false,
    });
  });

  it('never draws the item from the closet: it is locked, and only it', () => {
    const item = garment('top', { colors: ['grey'] });
    const tops = many('top', 4);
    const closet = [...tops, ...many('bottom', 2), ...many('footwear', 2)];
    const result = goesWith(request(item, closet));
    // The item is the top of every outfit: no closet top rides with it.
    expect(result.outfits).toBe(4);
    for (const idea of result.best) {
      expect(ids(idea.garments).filter((id) => ids(tops).includes(id))).toEqual(
        [],
      );
    }
    expect(result.roles.map((r) => r.role)).toEqual(['bottom', 'footwear']);
  });

  it('keeps to the hard rules: a bottom that clashes is not one it goes with', () => {
    // Red and green already: a yellow bottom would be a third colour.
    const item = garment('top', { colors: ['red', 'green'] });
    const plain = many('bottom', 2);
    const yellow = garment('bottom', { colors: ['yellow'] });
    const shoes = many('footwear', 2);
    const result = goesWith(request(item, [...plain, yellow, ...shoes]));
    expect(result.outfits).toBe(4);
    const bottoms = result.roles.find((r) => r.role === 'bottom')!;
    expect(bottoms).toMatchObject({ goes: 2, of: 3 });
    expect(ids(bottoms.best.map((p) => p.garment))).not.toContain(yellow.id);
  });

  it('keeps to the avoided pairs among closet garments', () => {
    const item = garment('top');
    const [jeans, chinos] = many('bottom', 2);
    const [boots, sneakers] = many('footwear', 2);
    const result = goesWith(
      request(item, [jeans, chinos, boots, sneakers], [[jeans.id, boots.id]]),
    );
    expect(result.outfits).toBe(3);
  });

  it('answers nothing when nothing goes with it', () => {
    const item = garment('top', { colors: ['red', 'green'] });
    const closet = [
      garment('bottom', { colors: ['yellow'] }),
      ...many('footwear', 2),
      ...many('layer', 2),
    ];
    expect(goesWith(request(item, closet))).toEqual({
      outfits: 0,
      capped: false,
      best: [],
      roles: [],
    });
    expect(goesWith(request(item, []))).toMatchObject({ outfits: 0 });
  });

  it('judges each layer with the item, since no forecast draws one', () => {
    const item = garment('top', { colors: ['red'] });
    const coat = garment('layer', { colors: ['black'] });
    // Red, green, orange: one colour too many with the item.
    const loud = garment('layer', { colors: ['green', 'orange'] });
    const closet = [coat, loud, ...many('bottom', 2), ...many('footwear', 1)];
    const result = goesWith(request(item, closet));
    // Outfits hold no layer (no weather): top, bottom, shoes.
    expect(result.outfits).toBe(2);
    for (const idea of result.best) {
      expect(idea.garments.map((g) => g.role)).not.toContain('layer');
    }
    const layers = result.roles.find((r) => r.role === 'layer')!;
    expect(layers).toMatchObject({ goes: 1, of: 2 });
    expect(layers.best).toEqual([
      {
        garment: expect.objectContaining({ id: coat.id }) as unknown,
        outfits: null,
        atFormality: true,
      },
    ]);
  });

  it('says so when no layer goes with it', () => {
    const item = garment('top', { colors: ['red', 'blue'] });
    const loud = garment('layer', { colors: ['green'] });
    const result = goesWith(
      request(item, [loud, ...many('bottom', 1), ...many('footwear', 1)]),
    );
    expect(result.roles.find((r) => r.role === 'layer')).toEqual({
      role: 'layer',
      goes: 0,
      of: 1,
      best: [],
    });
  });

  it('a layer on the wishlist is the layer of every outfit, and asks for no other', () => {
    const item = garment('layer', { colors: ['brown'] });
    const closet = [
      ...many('top', 2),
      ...many('bottom', 2),
      ...many('footwear', 1),
      ...many('layer', 3),
    ];
    const result = goesWith(request(item, closet));
    expect(result.outfits).toBe(4);
    for (const idea of result.best) {
      expect(idea.garments.filter((g) => g.role === 'layer')).toEqual([item]);
    }
    expect(result.roles.map((r) => r.role)).toEqual([
      'top',
      'bottom',
      'footwear',
    ]);
  });

  it('puts the outfits and partners at the item’s formality first', () => {
    const item = garment('top', { formality: 3 });
    const joggers = garment('bottom', { formality: 1 });
    const chinos = garment('bottom', { formality: 3 });
    const slides = garment('footwear', { formality: 1 });
    const loafers = garment('footwear', { formality: 3 });
    const result = goesWith(request(item, [joggers, chinos, slides, loafers]));
    expect(result.outfits).toBe(4);
    expect(ids(result.best[0].garments)).toEqual([
      item.id,
      chinos.id,
      loafers.id,
    ]);
    expect(result.best[0].score).toBe(0);
    // The rest by how far they dress from it: two steps (one piece at 1),
    // before four (both).
    expect(result.best.slice(1).map((idea) => idea.score)).toEqual([2, 2]);
    const bottoms = result.roles.find((r) => r.role === 'bottom')!;
    expect(bottoms.best.map((p) => [p.garment.id, p.atFormality])).toEqual([
      [chinos.id, true],
      [joggers.id, false],
    ]);
  });

  it('names at most a few partners per role, those in the most outfits first', () => {
    const item = garment('footwear', { colors: ['white'] });
    const green = garment('top', { colors: ['green'] });
    const loud = garment('top', { colors: ['yellow', 'orange'] });
    const red = garment('bottom', { colors: ['red'] });
    // Red with yellow and orange is three colours: the red bottom goes with
    // four tops of five, the plain ones with all five.
    const closet = [green, loud, ...many('top', 3), red, ...many('bottom', 3)];
    const result = goesWith(request(item, closet));
    expect(result.outfits).toBe(19);
    const bottoms = result.roles.find((r) => r.role === 'bottom')!;
    expect(bottoms.goes).toBe(4);
    expect(bottoms.best).toHaveLength(PARTNERS_PER_ROLE);
    expect(ids(bottoms.best.map((p) => p.garment))).not.toContain(red.id);
    for (const partner of bottoms.best) expect(partner.outfits).toBe(5);
  });

  it('ignores rotation: how long a garment rested changes nothing', () => {
    const item = garment('top');
    const bottoms = many('bottom', 6);
    const shoes = many('footwear', 5);
    const rested = [...bottoms, ...shoes].map((g, i) => ({
      ...g,
      idleDays: i % 2 === 0 ? null : 0,
    }));
    const strip = (result: ReturnType<typeof goesWith>) =>
      result.best.map((idea) => ids(idea.garments));
    expect(strip(goesWith(request(item, rested)))).toEqual(
      strip(goesWith(request(item, [...bottoms, ...shoes]))),
    );
  });

  it('is deterministic for a seed', () => {
    const item = garment('top');
    const closet = [...many('bottom', 8), ...many('footwear', 8)];
    expect(goesWith(request(item, closet))).toEqual(
      goesWith(request(item, closet)),
    );
  });
});

describe('nearDuplicates', () => {
  const lookalike = (
    id: number,
    category: string,
    type: string | null,
    colors: GarmentColor[],
  ) => ({ id, category, type, colors });
  const item = lookalike(1, 'tops', 'sweater', ['grey', 'blue']);

  it('finds the same category, type and colours, in any order', () => {
    const same = lookalike(2, 'tops', 'sweater', ['blue', 'grey']);
    expect(nearDuplicates(item, [same])).toEqual([same]);
  });

  it('is not a near-duplicate with another type, colour set or category', () => {
    expect(
      nearDuplicates(item, [
        lookalike(2, 'tops', 't-shirt', ['grey', 'blue']),
        lookalike(3, 'tops', 'sweater', ['grey']),
        lookalike(4, 'tops', 'sweater', ['grey', 'blue', 'white']),
        lookalike(5, 'outerwear', 'sweater', ['grey', 'blue']),
        lookalike(6, 'tops', null, ['grey', 'blue']),
      ]),
    ).toEqual([]);
  });

  it('counts two untyped garments of a category as the same kind', () => {
    const scarf = lookalike(1, 'scarves', null, ['red']);
    const other = lookalike(2, 'scarves', null, ['red']);
    expect(nearDuplicates(scarf, [other])).toEqual([other]);
  });

  it('never matches without colours, or the item itself', () => {
    const plain = lookalike(1, 'tops', 'sweater', []);
    expect(
      nearDuplicates(plain, [lookalike(2, 'tops', 'sweater', [])]),
    ).toEqual([]);
    expect(nearDuplicates(item, [item])).toEqual([]);
  });

  it('ignores brands unless asked for the same brand', () => {
    const uniqlo = { ...item, brand: 'Uniqlo' };
    const cos = { ...lookalike(2, 'tops', 'sweater', ['grey']), brand: 'COS' };
    const other = { ...cos, colors: ['blue', 'grey'] as GarmentColor[] };
    expect(nearDuplicates(uniqlo, [other])).toEqual([other]);
    expect(nearDuplicates(uniqlo, [other], { sameBrand: true })).toEqual([]);
  });

  it('with the same brand, matches its spellings and a blank brand on either side', () => {
    const probe = {
      category: 'tops',
      type: 'sweater',
      colors: ['grey', 'blue'] as GarmentColor[],
      brand: ' UNIQLO ',
    };
    const spelled = {
      ...lookalike(2, 'tops', 'sweater', ['blue', 'grey']),
      brand: 'uniqlo',
    };
    const blank = {
      ...lookalike(3, 'tops', 'sweater', ['grey', 'blue']),
      brand: null,
    };
    expect(
      nearDuplicates(probe, [spelled, blank], { sameBrand: true }),
    ).toEqual([spelled, blank]);
    expect(
      nearDuplicates({ ...probe, brand: '' }, [spelled], { sameBrand: true }),
    ).toEqual([spelled]);
  });

  it('judges a form not yet saved, which has no id', () => {
    const unsaved = { category: 'tops', type: 'sweater', colors: item.colors };
    const same = lookalike(1, 'tops', 'sweater', ['grey', 'blue']);
    expect(nearDuplicates(unsaved, [same])).toEqual([same]);
  });
});
