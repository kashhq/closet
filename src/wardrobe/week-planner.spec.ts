import { describe, expect, it } from 'vitest';
import { addDays, type IsoDate } from '../calendar-date';
import type { DayForecast } from '../weather/forecast';
import { assessOutfit, weatherNeeds } from '../weather/match';
import { keyOf } from './generator';
import {
  builtInCategoriesOf,
  type GarmentColor,
  type GarmentRole,
  type Warmth,
} from './properties';
import type { TemplateSlot } from './week';
import {
  emptySlots,
  needsChange,
  type OutfitGarmentState,
  PLAN_DAYS,
  type PlannedNeeds,
  type PlannerGarment,
  plannedNeeds,
  planWeek,
  replanWeek,
  sameNeeds,
  type Unwearable,
  unwearableOn,
  type WeekEntry,
  type WeekInput,
} from './week-planner';

/**
 * The weekly planner (#16): which slots are empty, the generator per slot
 * with its forecast, wash limits across the week (its own future wears
 * count), no outfit twice, and the re-plan's judgement of auto entries.
 */

// Sunday 27 September 2026; the week runs to Saturday 3 October.
const TODAY = '2026-09-27';
const WEEK = Array.from({ length: PLAN_DAYS }, (_, i) => addDays(TODAY, i));

let nextId = 1;

function garment(
  role: GarmentRole,
  options: {
    colors?: GarmentColor[];
    warmth?: Warmth;
    quantity?: number;
    washLimit?: number | null;
    wearsSinceWash?: number;
    idleDays?: number | null;
    waterResistant?: boolean;
  } = {},
): PlannerGarment {
  return {
    id: nextId++,
    role,
    category: builtInCategoriesOf(role)[0],
    type: null,
    colors: options.colors ?? ['black'],
    pattern: 'solid',
    formality: null,
    weather: {
      role,
      warmth: options.warmth ?? (role === 'layer' ? 3 : 2),
      waterResistant: options.waterResistant ?? false,
      rainGear: false,
    },
    idleDays: options.idleDays === undefined ? 10 : options.idleDays,
    quantity: options.quantity ?? 1,
    washLimit: options.washLimit === undefined ? null : options.washLimit,
    wearsSinceWash: options.wearsSinceWash ?? 0,
  };
}

/** Plenty of everything: tops, bottoms, shoes that never run out. */
function roomyCloset(): PlannerGarment[] {
  return [
    ...(['white', 'grey', 'black', 'beige', 'brown'] as const).map((color) =>
      garment('top', { colors: [color], quantity: 3, washLimit: 1 }),
    ),
    ...(['blue', 'black', 'beige'] as const).map((color) =>
      garment('bottom', { colors: [color], washLimit: 3 }),
    ),
    garment('footwear', { colors: ['white'] }),
    garment('footwear', { colors: ['brown'] }),
  ];
}

const every = (occasion: TemplateSlot['occasion']): TemplateSlot[] =>
  ([0, 1, 2, 3, 4, 5, 6] as const).map((weekday) => ({ weekday, occasion }));

/** A day at `feelsLike` °C every hour. */
function steadyDay(day: IsoDate, feelsLike: number, rain = false): DayForecast {
  const chance = rain ? 80 : 0;
  return {
    day,
    code: rain ? 63 : 1,
    high: feelsLike,
    low: feelsLike,
    precipitationChance: chance,
    hours: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      feelsLike,
      precipitationChance: chance,
      code: rain ? 63 : 1,
    })),
  };
}

function input(
  overrides: Partial<WeekInput<PlannerGarment>> = {},
): WeekInput<PlannerGarment> {
  return {
    today: TODAY,
    hour: 7,
    days: WEEK,
    template: every('all-day'),
    entries: [],
    pool: roomyCloset(),
    forecast: new Map(),
    offset: 0,
    rainGear: [],
    avoid: [],
    rules: [],
    saved: [],
    ...overrides,
  };
}

function entry(
  id: number,
  day: IsoDate,
  occasion: WeekEntry['occasion'],
  garments: PlannerGarment[],
  worn = false,
): WeekEntry {
  return {
    id,
    day,
    occasion,
    worn,
    garments: garments.map((g) => ({
      id: g.id,
      role: g.role,
      weather: g.weather,
    })),
  };
}

const planned = (plan: ReturnType<typeof planWeek>) =>
  plan.planned.map((slot) => [slot.day, slot.occasion]);

describe('emptySlots', () => {
  const template: TemplateSlot[] = [
    { weekday: 1, occasion: 'work' },
    { weekday: 1, occasion: 'workout' },
    { weekday: 1, occasion: 'evening' },
    { weekday: 0, occasion: 'all-day' },
  ];

  it("lists the template's slots day by day, in occasion order", () => {
    expect(
      emptySlots({ ...input(), template, entries: [] }).map((s) => [
        s.day,
        s.occasion,
      ]),
    ).toEqual([
      ['2026-09-27', 'all-day'],
      ['2026-09-28', 'workout'],
      ['2026-09-28', 'work'],
      ['2026-09-28', 'evening'],
    ]);
  });

  it('skips a slot an entry fills: its own occasion, or any outfit that dresses the day', () => {
    const slots = emptySlots({
      ...input(),
      template,
      entries: [
        // An all-day outfit on Monday dresses the work slot too.
        { day: '2026-09-28', occasion: 'all-day' },
        { day: '2026-09-28', occasion: 'evening' },
        // A night out is not an evening.
        { day: '2026-09-27', occasion: 'night-out' },
      ],
    });
    expect(slots.map((s) => [s.day, s.occasion])).toEqual([
      ['2026-09-27', 'all-day'],
      ['2026-09-28', 'workout'],
    ]);
  });

  it("leaves today's slots whose window has ended", () => {
    const slots = (hour: number) =>
      emptySlots({
        ...input({ hour }),
        template: [
          { weekday: 0, occasion: 'workout' },
          { weekday: 0, occasion: 'evening' },
        ],
        entries: [],
      }).map((s) => s.occasion);
    expect(slots(5)).toEqual(['workout', 'evening']);
    // The workout window is 6 to 9, the evening's 18 to 23.
    expect(slots(9)).toEqual(['evening']);
    expect(slots(23)).toEqual([]);
  });
});

describe('planWeek', () => {
  it('fills every empty slot with an outfit, and plans the same week twice alike', () => {
    const week = input();
    const plan = planWeek(week);
    expect(planned(plan)).toEqual(WEEK.map((day) => [day, 'all-day']));
    expect(plan.unfilled).toEqual([]);
    expect(planWeek(week)).toEqual(plan);
    for (const slot of plan.planned) {
      expect(slot.idea.garments.map((g) => g.role)).toEqual([
        'top',
        'bottom',
        'footwear',
      ]);
    }
  });

  it('hands back the pool’s own garments', () => {
    const week = input();
    const [first] = planWeek(week).planned;
    for (const g of first.idea.garments) {
      expect(week.pool).toContain(g);
    }
  });

  it('plans the same week from the same closet whatever its ids and row order (a reseed)', () => {
    const colorsOf = (plan: ReturnType<typeof planWeek>) =>
      plan.planned.map((slot) => [
        slot.day,
        slot.idea.garments.map((g) => `${g.role} ${g.colors.join('/')}`),
      ]);
    const pool = roomyCloset();
    const before = planWeek(input({ pool }));
    // Reseeded: new ids, in the same relative order, and the rows read back
    // in another order (Postgres returns a query's rows in no set order).
    const reseeded = pool
      .map((g) => ({ ...g, id: g.id + 1000 }))
      .reverse()
      .sort((a, b) => {
        if (a.role < b.role) return -1;
        return a.role > b.role ? 1 : 0;
      });
    expect(colorsOf(planWeek(input({ pool: reseeded })))).toEqual(
      colorsOf(before),
    );
  });

  it('never plans the same outfit twice in the week, nor a saved one', () => {
    const pool = roomyCloset();
    const [white] = pool;
    const [blue] = pool.filter((g) => g.role === 'bottom');
    const [sneakers] = pool.filter((g) => g.role === 'footwear');
    const saved = [
      [white, blue, sneakers].map(({ id, role }) => ({ id, role })),
    ];
    const plan = planWeek(
      input({
        pool,
        saved,
        template: [...every('all-day'), ...every('evening')],
      }),
    );
    const keys = plan.planned.map((slot) => keyOf(slot.idea.garments));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain(keyOf([white, blue, sneakers]));
  });

  describe('wash limits across the week', () => {
    it('counts its own future wears: two tees worn once each dress two days, then it stops', () => {
      const plan = planWeek(
        input({
          pool: [
            garment('top', { colors: ['white'], washLimit: 1 }),
            garment('top', { colors: ['grey'], washLimit: 1 }),
            garment('bottom', { colors: ['blue'], washLimit: null }),
            garment('bottom', { colors: ['black'], washLimit: null }),
          ],
        }),
      );
      expect(planned(plan)).toEqual([
        ['2026-09-27', 'all-day'],
        ['2026-09-28', 'all-day'],
      ]);
      expect(plan.unfilled.map((s) => s.day)).toEqual(WEEK.slice(2));
    });

    it('counts copies: a tee ×3 at one wear each dresses three days', () => {
      const tee = garment('top', {
        colors: ['white'],
        washLimit: 1,
        quantity: 3,
      });
      const plan = planWeek(
        input({
          pool: [
            tee,
            ...(['blue', 'black', 'beige', 'grey'] as const).map((color) =>
              garment('bottom', { colors: [color] }),
            ),
          ],
        }),
      );
      expect(plan.planned).toHaveLength(3);
    });

    it('starts from the wears since the wash: jeans at 2 of 3 are planned once', () => {
      const jeans = garment('bottom', {
        colors: ['blue'],
        washLimit: 3,
        wearsSinceWash: 2,
      });
      const plan = planWeek(
        input({
          pool: [
            ...(['white', 'grey', 'black'] as const).map((color) =>
              garment('top', { colors: [color], quantity: 3, washLimit: 1 }),
            ),
            jeans,
          ],
        }),
      );
      expect(plan.planned).toHaveLength(1);
      expect(plan.planned[0].idea.garments).toContain(jeans);
    });

    it('never takes the clean copy a planned entry later in the week relies on', () => {
      const jeans = garment('bottom', {
        colors: ['blue'],
        washLimit: 3,
        wearsSinceWash: 2,
      });
      const tops = (['white', 'grey', 'black'] as const).map((color) =>
        garment('top', { colors: [color], quantity: 3, washLimit: 1 }),
      );
      const friday = entry(1, '2026-10-02', 'evening', [tops[0], jeans]);
      const plan = planWeek(
        input({ pool: [...tops, jeans], entries: [friday] }),
      );
      // Only Friday itself, whose evening wears them anyway.
      expect(planned(plan)).toEqual([['2026-10-02', 'all-day']]);
      expect(plan.unfilled).toHaveLength(PLAN_DAYS - 1);
    });

    it('wears a garment twice on one day for one wear', () => {
      const tee = garment('top', { colors: ['white'], washLimit: 1 });
      const shorts = garment('bottom', { colors: ['blue'] });
      const chinos = garment('bottom', { colors: ['beige'] });
      // Tonight's plan already takes the tee's one wear; the day's outfit
      // may wear it too, but no other day may.
      const tonight = entry(1, TODAY, 'evening', [tee, shorts]);
      const plan = planWeek(
        input({
          pool: [tee, shorts, chinos],
          entries: [tonight],
          saved: [tonight.garments],
        }),
      );
      expect(planned(plan)).toEqual([[TODAY, 'all-day']]);
      expect(plan.planned[0].idea.garments).toEqual([tee, chinos]);
    });

    it("counts a garment worn today once: another of today's slots, but no later day", () => {
      const tee = garment('top', {
        colors: ['white'],
        washLimit: 1,
        wearsSinceWash: 1,
        idleDays: 0,
      });
      const plan = planWeek(
        input({
          pool: [tee, garment('bottom', { colors: ['blue'] })],
          template: every('evening'),
          hour: 12,
        }),
      );
      expect(planned(plan)).toEqual([[TODAY, 'evening']]);
    });

    it('lets a garment that never needs a wash dress every day', () => {
      const plan = planWeek(
        input({
          pool: [
            ...(
              [
                'white',
                'grey',
                'black',
                'beige',
                'brown',
                'blue',
                'green',
              ] as const
            ).map((color) => garment('top', { colors: [color], washLimit: 1 })),
            garment('bottom', { colors: ['blue'], washLimit: null }),
          ],
        }),
      );
      expect(plan.planned).toHaveLength(PLAN_DAYS);
    });
  });

  it("dresses each slot for its own day's forecast", () => {
    const coat = garment('layer', { colors: ['black'], warmth: 5 });
    const forecast = new Map([
      [WEEK[0], steadyDay(WEEK[0], 24)],
      [WEEK[1], steadyDay(WEEK[1], 0)],
    ]);
    const plan = planWeek(
      input({
        pool: [...roomyCloset(), coat],
        forecast,
        days: WEEK.slice(0, 2),
      }),
    );
    const [warm, cold] = plan.planned;
    expect(warm.needs?.torso).toBeLessThan(cold.needs!.torso);
    expect(warm.idea.garments).not.toContain(coat);
    expect(cold.idea.garments).toContain(coat);
  });

  it('plans without weather where the forecast has no day', () => {
    const plan = planWeek(input({ days: WEEK.slice(0, 1) }));
    expect(plan.planned[0].needs).toBeNull();
  });

  it('plans nothing without a template', () => {
    expect(planWeek(input({ template: [] }))).toEqual({
      planned: [],
      unfilled: [],
    });
  });

  describe('a workout (#647)', () => {
    const typed = (
      role: GarmentRole,
      category: string,
      type: string,
    ): PlannerGarment => ({
      ...garment(role, { washLimit: null }),
      category,
      type,
      formality: 1,
    });
    const workouts = (pool: PlannerGarment[]) =>
      planWeek(
        input({
          pool,
          template: [
            { weekday: 1, occasion: 'workout' },
            { weekday: 1, occasion: 'all-day' },
          ],
          days: WEEK.slice(1, 2),
          forecast: new Map([[WEEK[1], steadyDay(WEEK[1], 0)]]),
        }),
      );

    it('leaves the slot empty when the closet has no activewear, never a near miss', () => {
      const plan = workouts(roomyCloset());
      expect(plan.planned.map((p) => p.occasion)).toEqual(['all-day']);
      expect(plan.unfilled).toEqual([{ day: WEEK[1], occasion: 'workout' }]);
    });

    it('dresses it in running shoes and athletic bottoms, the top whatever fits', () => {
      const shoes = typed('footwear', 'footwear', 'running-shoes');
      const shorts = typed('bottom', 'bottoms', 'running-shorts');
      const plan = workouts([...roomyCloset(), shoes, shorts]);
      const workout = plan.planned.find((p) => p.occasion === 'workout')!;
      expect(workout.idea.garments).toEqual(
        expect.arrayContaining([shoes, shorts]),
      );
      expect(workout.idea.garments.some((g) => g.role === 'top')).toBe(true);
      expect(plan.unfilled).toEqual([]);
    });
  });
});

describe('the re-plan', () => {
  const coat = () => garment('layer', { colors: ['black'], warmth: 5 });

  /** A week planned warm, then its forecast judged again. */
  function plannedWarm() {
    const pool = [...roomyCloset(), coat()];
    const days = WEEK.slice(0, 3);
    const warm = new Map(days.map((d) => [d, steadyDay(d, 24)]));
    const plan = planWeek(input({ pool, days, forecast: warm }));
    const entries = plan.planned.map((slot, i) =>
      entry(100 + i, slot.day, slot.occasion, slot.idea.garments),
    );
    const auto = plan.planned.map((slot, i) => ({
      entryId: 100 + i,
      plannedFor: plannedNeeds(slot.needs),
      unwearable: null as Unwearable | null,
    }));
    return { pool, days, entries, auto, warm };
  }

  it('leaves an entry whose targets did not change', () => {
    const { pool, entries, auto, warm } = plannedWarm();
    expect(
      replanWeek({ ...input({ pool, entries, forecast: warm }), auto }),
    ).toEqual(auto.map(({ entryId }) => ({ entryId, kind: 'unchanged' })));
  });

  it('swaps an outfit the new forecast finds too light, saying it turned colder', () => {
    const { pool, entries, auto, warm } = plannedWarm();
    const forecast = new Map(warm);
    forecast.set(WEEK[1], steadyDay(WEEK[1], 0));
    const replans = replanWeek({ ...input({ pool, entries, forecast }), auto });
    expect(replans.map((r) => r.kind)).toEqual([
      'unchanged',
      'swap',
      'unchanged',
    ]);
    const swap = replans[1];
    if (swap.kind !== 'swap') throw new Error('not a swap');
    expect(swap.cause).toEqual({ kind: 'weather', change: 'colder' });
    expect(swap.slot).toEqual({ day: WEEK[1], occasion: 'all-day' });
    expect(swap.idea.garments.map((g) => g.role)).toContain('layer');
    expect(swap.needs!.torso).toBeGreaterThan(auto[1].plannedFor!.torso);
  });

  describe('the legs-and-feet too-warm bound (#750)', () => {
    const boots = garment('footwear', { warmth: 5 });
    const pool = [...roomyCloset(), boots];
    const day = WEEK[0];
    const outfit = [
      pool.find((g) => g.role === 'top')!,
      pool.find((g) => g.role === 'bottom')!,
      boots,
    ];
    const needsAt = (feelsLike: number) =>
      weatherNeeds(steadyDay(day, feelsLike), 'all-day', 0)!;
    const feetTooWarm = (feelsLike: number) =>
      assessOutfit(
        needsAt(feelsLike),
        outfit.map((g) => g.weather),
      ).problems.includes('feet-too-warm');
    const replanAt = (plannedAt: number, now: number, ceiling = true) => {
      const planned = plannedNeeds(needsAt(plannedAt))!;
      return replanWeek({
        ...input({
          pool,
          entries: [entry(1, day, 'all-day', outfit)],
          forecast: new Map([[day, steadyDay(day, now)]]),
        }),
        auto: [
          {
            entryId: 1,
            plannedFor: ceiling ? planned : { ...planned, limbsCeiling: null },
            unwearable: null,
          },
        ],
      })[0];
    };

    it('judges an entry whose targets held but whose ceiling fell: boots planned at 8.4 C, 8.6 C now', () => {
      expect(feetTooWarm(8.4)).toBe(false);
      expect(feetTooWarm(8.6)).toBe(true);
      const before = plannedNeeds(needsAt(8.4))!;
      expect(sameNeeds(before, plannedNeeds(needsAt(8.6)))).toBe(true);
      expect(before.limbsCeiling).toBe(4);
      const replan = replanAt(8.4, 8.6);
      // A better idea exists in the roomy closet: swapped, and the weather did warm.
      expect(replan.kind).toBe('swap');
      if (replan.kind !== 'swap') return;
      expect(replan.cause).toEqual({ kind: 'weather', change: 'warmer' });
      expect(replan.needs!.limbsCeiling).toBe(3);
    });

    it('leaves a near miss alone: planned already too warm, the same weather the next morning', () => {
      expect(feetTooWarm(8.6)).toBe(true);
      expect(replanAt(8.6, 8.6)).toEqual({ entryId: 1, kind: 'unchanged' });
    });

    it('judges a near miss when the ceiling falls further still: a heatwave under boots planned at ceiling 5', () => {
      const planned: PlannedNeeds = {
        ...plannedNeeds(needsAt(8.6))!,
        limbsCeiling: 5,
      };
      const [replan] = replanWeek({
        ...input({
          pool,
          entries: [entry(1, day, 'all-day', outfit)],
          forecast: new Map([[day, steadyDay(day, 8.6)]]),
        }),
        auto: [{ entryId: 1, plannedFor: planned, unwearable: null }],
      });
      expect(replan.kind).toBe('swap');
      if (replan.kind !== 'swap') return;
      expect(replan.cause).toEqual({ kind: 'weather', change: 'warmer' });
    });

    it('never judges an entry planned before the ceiling was kept', () => {
      expect(replanAt(8.4, 8.6, false)).toEqual({
        entryId: 1,
        kind: 'unchanged',
      });
    });
  });

  it('keeps an outfit that still fits new targets, recording them', () => {
    const { pool, entries, auto, warm } = plannedWarm();
    const forecast = new Map(warm);
    // Warmer still: a tee is a tee.
    forecast.set(WEEK[1], steadyDay(WEEK[1], 30));
    const [, second] = replanWeek({
      ...input({ pool, entries, forecast }),
      auto,
    });
    expect(second.kind).toBe('kept');
  });

  it("keeps the outfit when nothing fits better, and never judges a person's own entries", () => {
    const { pool, entries, auto, warm } = plannedWarm();
    const forecast = new Map(warm);
    forecast.set(WEEK[1], steadyDay(WEEK[1], 0));
    // Without the coat nothing answers the cold better.
    const noCoat = pool.filter((g) => g.role !== 'layer');
    const replans = replanWeek({
      ...input({ pool: noCoat, entries, forecast }),
      // Only the first entry is the planner's: the cold day's is the person's.
      auto: [auto[0], auto[2]],
    });
    expect(replans.map((r) => r.entryId)).toEqual([100, 102]);
    expect(replans.map((r) => r.kind)).toEqual(['unchanged', 'unchanged']);
    const kept = replanWeek({
      ...input({ pool: noCoat, entries, forecast }),
      auto,
    });
    expect(kept[1]).toEqual({
      entryId: 101,
      kind: 'kept',
      needs: expect.objectContaining({
        torso: expect.any(Number) as number,
      }) as unknown,
    });
  });

  it('leaves an entry whose day has no forecast now', () => {
    const { pool, entries, auto } = plannedWarm();
    const replans = replanWeek({ ...input({ pool, entries }), auto });
    expect(replans.every((r) => r.kind === 'unchanged')).toBe(true);
  });

  it("a swap respects the week's wash limits", () => {
    // One coat, one wear left on it: Monday's cold day takes it only if no
    // other day of the week holds it.
    const limited = garment('layer', {
      colors: ['black'],
      warmth: 5,
      washLimit: 10,
      wearsSinceWash: 9,
    });
    const { entries, auto, warm } = plannedWarm();
    const pool = [...roomyCloset(), limited];
    const tuesday = entry(200, WEEK[2], 'evening', [limited]);
    const forecast = new Map(warm);
    forecast.set(WEEK[1], steadyDay(WEEK[1], 0));
    const replans = replanWeek({
      ...input({ pool, entries: [...entries, tuesday], forecast }),
      auto,
    });
    // The coat's last wear is Tuesday's: Monday swaps to something else or
    // keeps its outfit, never the coat.
    const swap = replans[1];
    expect(swap.kind === 'swap' && swap.idea.garments.includes(limited)).toBe(
      false,
    );
    // Without Tuesday's entry, the coat is Monday's answer.
    const free = replanWeek({
      ...input({ pool, entries, forecast }),
      auto,
    })[1];
    expect(free.kind === 'swap' && free.idea.garments.includes(limited)).toBe(
      true,
    );
  });

  describe('an outfit that can no longer be worn', () => {
    /** The week planned warm, Monday's entry (the second) unwearable for `unwearable`. */
    function withUnwearable(unwearable: Unwearable) {
      const week = plannedWarm();
      const auto = week.auto.map((a, i) =>
        i === 1 ? { ...a, unwearable } : a,
      );
      return { ...week, auto };
    }

    it('is swapped for the best idea whatever the forecast, naming why', () => {
      const { pool, entries, auto, warm } = plannedWarm();
      const gone = entries[1].garments.find((g) => g.role === 'bottom')!;
      const unwearable: Unwearable = { reason: 'repair', garmentId: gone.id };
      // The caller's pool has no garment away (weekPool).
      const closet = pool.filter((g) => g.id !== gone.id);
      const replans = replanWeek({
        ...input({ pool: closet, entries, forecast: warm }),
        auto: auto.map((a, i) => (i === 1 ? { ...a, unwearable } : a)),
      });
      expect(replans.map((r) => r.kind)).toEqual([
        'unchanged',
        'swap',
        'unchanged',
      ]);
      const swap = replans[1];
      if (swap.kind !== 'swap') throw new Error('not a swap');
      expect(swap.cause).toEqual({ kind: 'unwearable', unwearable });
      expect(swap.slot).toEqual({ day: WEEK[1], occasion: 'all-day' });
      expect(swap.idea.garments.map((g) => g.id)).not.toContain(gone.id);
      // Planned for the slot's targets now: the same warm day's.
      expect(swap.needs).toEqual(auto[1].plannedFor);
    });

    it('is swapped without a forecast too, planned for no targets', () => {
      const { pool, entries, auto } = withUnwearable({ reason: 'deleted' });
      const [, swap] = replanWeek({ ...input({ pool, entries }), auto });
      expect(swap).toMatchObject({
        kind: 'swap',
        needs: null,
        cause: { kind: 'unwearable', unwearable: { reason: 'deleted' } },
      });
    });

    it('stays when nothing else dresses the slot', () => {
      const { entries, auto, warm } = withUnwearable({ reason: 'deleted' });
      // Only the week's own garments, one clean wear each: no idea is left.
      const worn = new Set(entries.flatMap((e) => e.garments.map((g) => g.id)));
      const pool = plannedWarm()
        .pool.filter((g) => worn.has(g.id))
        .map((g) => ({ ...g, quantity: 1, washLimit: 1, wearsSinceWash: 0 }));
      const replans = replanWeek({
        ...input({ pool, entries, forecast: warm }),
        auto,
      });
      expect(replans[1]).toEqual({ entryId: 101, kind: 'unchanged' });
    });

    it("is never judged on a person's own entry", () => {
      const { pool, entries, auto, warm } = withUnwearable({
        reason: 'lent',
        garmentId: 1,
      });
      const replans = replanWeek({
        ...input({ pool, entries, forecast: warm }),
        auto: [auto[0], auto[2]],
      });
      expect(replans.map((r) => r.kind)).toEqual(['unchanged', 'unchanged']);
    });
  });
});

describe('unwearableOn', () => {
  function state(
    overrides: Partial<OutfitGarmentState> = {},
  ): OutfitGarmentState {
    return {
      id: nextId++,
      status: 'closet',
      away: null,
      quantity: 1,
      limit: 1,
      wearsSinceWash: 0,
      wornToday: false,
      ...overrides,
    };
  }
  const tomorrow = addDays(TODAY, 1);
  const on = (
    day: IsoDate,
    slots: (OutfitGarmentState | null)[],
    outfitCreated = true,
  ) => unwearableOn({ day, outfitCreated, slots }, TODAY);

  it('wears an outfit whose garments are all in the closet, home and clean', () => {
    expect(
      on(TODAY, [state(), state({ limit: null, wearsSinceWash: 40 })]),
    ).toBe(null);
  });

  it('names a garment away or out of the closet, on any day', () => {
    for (const [overrides, reason] of [
      [{ away: 'lent' }, 'lent'],
      [{ away: 'repair' }, 'repair'],
      [{ status: 'archived' }, 'archived'],
      [{ status: 'wishlist' }, 'wishlist'],
    ] as const) {
      const out = state(overrides);
      for (const day of [TODAY, tomorrow]) {
        expect(on(day, [state(), out]), `${reason} on ${day}`).toEqual({
          reason,
          garmentId: out.id,
        });
      }
    }
  });

  it('counts dirty only on the day itself, and never a garment already worn today', () => {
    const dirty = state({ wearsSinceWash: 1 });
    expect(on(TODAY, [state(), dirty])).toEqual({
      reason: 'dirty',
      garmentId: dirty.id,
    });
    // A later day: the laundry may well be done by then.
    expect(on(tomorrow, [state(), dirty])).toBe(null);
    // Worn today already: today's other slots wear it for no second wear.
    expect(on(TODAY, [state({ wearsSinceWash: 1, wornToday: true })])).toBe(
      null,
    );
    // One clean copy of three is enough.
    expect(on(TODAY, [state({ quantity: 3, wearsSinceWash: 2 })])).toBe(null);
  });

  it('reads an empty slot as a deleted garment only in an outfit the planner created', () => {
    expect(on(tomorrow, [state(), null])).toEqual({ reason: 'deleted' });
    // A saved outfit it reused may have a slot left empty on purpose.
    expect(on(tomorrow, [state(), null], false)).toBe(null);
    // A garment it can name comes first.
    const lent = state({ away: 'lent' });
    expect(on(tomorrow, [null, lent])).toEqual({
      reason: 'lent',
      garmentId: lent.id,
    });
  });
});

describe('needs', () => {
  const base: PlannedNeeds = {
    torso: 4,
    limbs: 3,
    layer: false,
    rain: false,
    limbsCeiling: 3,
  };

  it('compares the targets the re-plan watches', () => {
    expect(sameNeeds(base, { ...base })).toBe(true);
    expect(sameNeeds(base, { ...base, rain: true })).toBe(false);
    expect(sameNeeds(null, null)).toBe(true);
    expect(sameNeeds(null, base)).toBe(false);
  });

  it('names the change, the most telling first', () => {
    expect(needsChange(null, base)).toBe('forecast');
    expect(needsChange(base, { ...base, rain: true, torso: 6 })).toBe('rain');
    expect(needsChange(base, { ...base, torso: 6 })).toBe('colder');
    expect(needsChange(base, { ...base, limbs: 2 })).toBe('warmer');
    expect(needsChange({ ...base, rain: true }, base)).toBe('dry');
    expect(needsChange(base, { ...base, layer: true })).toBe('swing');
  });
});
