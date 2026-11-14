import { describe, expect, it } from 'vitest';
import type { GarmentRole } from '../../wardrobe/properties';
import {
  freshStates,
  lockedOn,
  openingStates,
  type RoleWindow,
  type RowGarment,
  type RowState,
  savedStates,
  shuffledStates,
  stylingRows,
  withEveryRole,
  withPicks,
} from './rows';

function garment(id: number, status: RowGarment['status'] = 'closet') {
  return { id, name: `G${id}`, category: 'tops', status, photo: null };
}

/** A role's window: `ids` newest first, the cycle's first, of `count`. */
function window(role: GarmentRole, ids: number[], count = ids.length) {
  return ranked(
    role,
    ids.map((id, i) => [id, i + 1]),
    count,
  );
}

/** A role's window as roleWindowsSql reads one: `[id, rank]` pairs, possibly in separate runs. */
function ranked(
  role: GarmentRole,
  garments: [id: number, rank: number][],
  count: number,
): RoleWindow {
  return {
    role,
    count,
    garments: garments.map(([id, rank]) => ({ ...garment(id), rank })),
  };
}

const row = (
  role: GarmentRole,
  garmentId: number | null,
  locked = false,
): RowState => ({ role, garmentId, locked });

describe('freshStates', () => {
  it('a row per role top to toe, every one on "No garment"', () => {
    const windows: RoleWindow[] = [
      window('footwear', [9]),
      window('top', [5, 4]),
      window('accessory', [20]),
      window('one-piece', [30]),
      window('layer', [7]),
      window('bottom', [3]),
    ];
    expect(freshStates(windows)).toEqual([
      row('layer', null),
      row('one-piece', null),
      row('top', null),
      row('bottom', null),
      row('footwear', null),
      row('accessory', null),
    ]);
  });
});

describe('savedStates', () => {
  it('a row per garment in outfit order, then an empty row per other role', () => {
    const windows = [
      window('top', [5]),
      window('bottom', [3]),
      window('accessory', [20, 21]),
      window('footwear', [9]),
    ];
    const saved = [
      { id: 21, role: 'accessory' as const },
      { id: 3, role: 'bottom' as const },
      { id: 20, role: 'accessory' as const },
    ];
    expect(savedStates(saved, windows)).toEqual([
      row('top', null),
      row('bottom', 3),
      row('footwear', null),
      row('accessory', 21),
      row('accessory', 20),
    ]);
  });
});

describe('withEveryRole', () => {
  it('adds the roles the rows lack, and keeps what they hold', () => {
    expect(
      withEveryRole([row('bottom', 3, true)], [window('top', [5])]),
    ).toEqual([row('top', null), row('bottom', 3, true)]);
  });
});

describe('lockedOn', () => {
  it('chooses and locks the garment in its role’s first row', () => {
    const states = [row('top', 5), row('top', 6), row('bottom', 3)];
    expect(lockedOn(states, { id: 4, role: 'top' })).toEqual([
      row('top', 4, true),
      row('top', 6),
      row('bottom', 3),
    ]);
  });

  it('adds a row for a role the stack had none of', () => {
    expect(lockedOn([row('top', 5)], { id: 9, role: 'footwear' })).toEqual([
      row('top', 5),
      row('footwear', 9, true),
    ]);
  });
});

describe('shuffledStates', () => {
  it('fills the unlocked drawn rows with the idea, the locked ones stay', () => {
    const states = [
      row('layer', 7),
      row('top', 5, true),
      row('bottom', 3),
      row('footwear', 9),
    ];
    const idea = [
      { id: 5, role: 'top' as const },
      { id: 4, role: 'bottom' as const },
      { id: 8, role: 'footwear' as const },
    ];
    expect(shuffledStates(states, idea)).toEqual([
      // No layer in the idea: the weather asked for none.
      row('layer', null),
      row('top', 5, true),
      row('bottom', 4),
      row('footwear', 8),
    ]);
  });

  it('a dress empties the unlocked top and bottom rows', () => {
    const states = [
      row('one-piece', null),
      row('top', 5),
      row('bottom', 3),
      row('footwear', 9),
    ];
    const idea = [
      { id: 30, role: 'one-piece' as const },
      { id: 8, role: 'footwear' as const },
    ];
    expect(shuffledStates(states, idea)).toEqual([
      row('one-piece', 30),
      row('top', null),
      row('bottom', null),
      row('footwear', 8),
    ]);
  });

  it('leaves accessories and bags as they were, and a second row of a role empty', () => {
    const states = [
      row('top', 5),
      row('top', 6),
      row('accessory', 20),
      row('bag', null),
    ];
    expect(shuffledStates(states, [{ id: 4, role: 'top' }])).toEqual([
      row('top', 4),
      row('top', null),
      row('accessory', 20),
      row('bag', null),
    ]);
  });
});

describe('openingStates', () => {
  const windows = [window('top', [5, 4]), window('bottom', [3])];

  it('is the fresh stack without an outfit or a garment', () => {
    expect(openingStates(windows, {})).toEqual(freshStates(windows));
  });

  it('"Style this": the garment locked, the idea in the other rows', () => {
    expect(
      openingStates(windows, {
        with: { id: 4, role: 'top' },
        idea: [
          { id: 4, role: 'top' },
          { id: 3, role: 'bottom' },
        ],
      }),
    ).toEqual([row('top', 4, true), row('bottom', 3)]);
  });
});

describe('stylingRows', () => {
  it('gives each row its role’s window and says where the next page starts', () => {
    const [top] = stylingRows([row('top', 5)], [window('top', [5, 4], 12)], []);
    expect(top.garments.map((g) => g.id)).toEqual([5, 4]);
    expect(top.moreBefore).toBe(4);

    const [whole] = stylingRows([row('top', 5)], [window('top', [5, 4])], []);
    expect(whole.moreBefore).toBeUndefined();
  });

  it('windows each row around its own garment, with a page either way (#996)', () => {
    // A cycle of 40 (ids 140 down to 101, rank = 141 - id): the head, and
    // the runs the SQL reads around rank 20 and rank 38.
    const ids = (from: number, to: number): [number, number][] =>
      Array.from({ length: to - from + 1 }, (_, i) => [
        141 - from - i,
        from + i,
      ]);
    const accessories = ranked(
      'accessory',
      [...ids(1, 10), ...ids(10, 30).slice(1), ...ids(31, 40)],
      40,
    );
    const [fresh, deep, end] = stylingRows(
      [row('accessory', null), row('accessory', 121), row('accessory', 103)],
      [accessories],
      [],
    );
    expect(fresh.garments.map((g) => g.id)).toEqual(
      ids(1, 10).map(([id]) => id),
    );
    expect([fresh.moreAfter, fresh.moreBefore]).toEqual([undefined, 131]);
    expect(deep.garments.map((g) => g.id)).toEqual(
      ids(10, 30).map(([id]) => id),
    );
    expect([deep.moreAfter, deep.moreBefore]).toEqual([131, 111]);
    expect(end.garments.map((g) => g.id)).toEqual(
      ids(28, 40).map(([id]) => id),
    );
    expect([end.moreAfter, end.moreBefore]).toEqual([113, undefined]);
  });

  it('leads with a chosen garment outside the cycle (archived)', () => {
    const archived = garment(2, 'archived');
    const [top] = stylingRows(
      [row('top', 2)],
      [window('top', [5, 4])],
      [archived],
    );
    expect(top.garments.map((g) => g.id)).toEqual([2, 5, 4]);
    expect(top.garmentId).toBe(2);
  });

  it('falls back to "No garment" for a choice found nowhere (deleted since)', () => {
    const [top] = stylingRows([row('top', 99)], [window('top', [5])], []);
    expect(top.garmentId).toBeNull();
    expect(top.garments.map((g) => g.id)).toEqual([5]);
  });
});

describe('Include picks (#335)', () => {
  const toBuy = (id: number, role: GarmentRole) => ({
    ...garment(id, 'wishlist'),
    role,
  });

  it('withPicks puts them on their role’s window in the order given, and makes one for a role the closet lacks', () => {
    const windows = withPicks(
      [window('top', [5, 4], 7)],
      [toBuy(20, 'top'), toBuy(22, 'top'), toBuy(21, 'footwear')],
    );
    expect(
      windows.map((w) => [w.role, w.count, w.picks?.map((p) => p.id)]),
    ).toEqual([
      ['top', 7, [20, 22]],
      ['footwear', 0, [21]],
    ]);
  });

  it('a pick leads its strip but is neither opened on nor counted in paging', () => {
    const windows = withPicks(
      [window('top', [5, 4], 7)],
      [toBuy(20, 'top'), toBuy(21, 'footwear')],
    );
    const states = freshStates(windows);
    expect(states).toEqual([row('top', null), row('footwear', null)]);
    const rows = stylingRows(states, windows, []);
    expect(rows[0].garments.map((g) => g.id)).toEqual([20, 5, 4]);
    expect(rows[0].moreBefore).toBe(4);
    expect(rows[1].garments.map((g) => g.id)).toEqual([21]);
  });
});
