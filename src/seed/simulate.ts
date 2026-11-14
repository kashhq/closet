import {
  addDays,
  dayOfWeek,
  daysBetween,
  type IsoDate,
  startOfWeek,
} from '../calendar-date';
import { cleanCopies, washLimit } from '../wardrobe/availability';
import { DEFAULT_OCCASION, type Occasion } from '../wardrobe/occasions';
import type {
  BibleOccasion,
  Persona,
  SeedEvent,
  SeedGarment,
  SeedOutfit,
} from './persona';
import { stream } from './random';
import { BANDS, type Band, type Weather, weatherFor } from './weather';

/**
 * A persona's life, day by day, from its bible's tables (the rules are the
 * bible's Simulation section, demo.md): which saved outfit on which day,
 * evenings out, what got logged and worn, laundry. Pure and deterministic:
 * the same persona and anchor give the same entries (random.ts). Later
 * features extend this rather than writing rows beside it (AGENTS.md, Seed
 * personas): wears and washes (#7) are its worn entries and its Sundays,
 * judged by the app's own wash rules (src/wardrobe/availability.ts);
 * occasions (#13) are each entry's part of the day, with the week's morning
 * workouts as entries of their own; the weekly auto-plan (#16) fills the
 * planned week's template slots (the day's outfit, the workout), so the
 * simulation plans only what comes some weeks (a date night, a night out)
 * and an Event's outfit there (seed.ts writePlannedWeek).
 */

/** The bibles' dates are written for this Saturday; seeding shifts them by whole weeks. */
export const REFERENCE_ANCHOR: IsoDate = '2026-09-26';
/** The first meeting Wednesday at the reference anchor; every other one after. */
const REFERENCE_MEETING_WEDNESDAY: IsoDate = '2026-07-01';

export const HISTORY_DAYS = 91;
export const PLANNED_DAYS = 7;

// demo.md, Simulation: the odds and weights.
const LOGGED = 0.85;
const OFFICE_CHANGE_OF_MIND = 0.04;
const DATE_NIGHT_WEEKLY = 0.75;
const DATE_NIGHT_FRIDAY = 0.6;
const NIGHT_OUT_EVERY_WEEKS = 3;
const FAVOURITE_WEIGHT = 3;
const WORN_YESTERDAY = 0.2;
const WORN_RECENTLY = 0.5;
const RECENT_DAYS = 3;
const RAIN_OUTFIT_WEIGHT = 4;
const WORKOUT_SKIPPED = 0.2;
// Before a date or a night out he takes a mirror selfie (#19); the last
// four weeks of them are still on his phone's camera roll.
const SELFIE_OCCASIONS: readonly Occasion[] = ['evening', 'night-out'];
const SELFIE_DAYS = 28;
/** An outfit index for "none": no outfit fits, no workout, no evening. */
const NONE = -1;

// The evening's calendar occasion, by what the evening is.
const EVENING_OCCASIONS: Record<'date' | 'night-out', Occasion> = {
  date: 'evening',
  'night-out': 'night-out',
};

const SUNDAY = 0;
const WEDNESDAY = 3;
const THURSDAY = 4;
const FRIDAY = 5;
const SATURDAY = 6;

/** One calendar entry to write. */
interface SimulatedEntry {
  day: IsoDate;
  /** Index into persona.outfits. */
  outfit: number;
  /** The part of the day it is for. */
  occasion: Occasion;
  /**
   * Worn that day (a past entry he logged, or the anchor's morning
   * workout); false for a planned one.
   */
  worn: boolean;
  /** He took an outfit selfie of it (#19): worn evenings, the last four weeks. */
  selfie: boolean;
}

/**
 * Where a day stands from the anchor: history, the anchor itself (today,
 * half lived), or the planned week.
 */
type DayKind = 'past' | 'today' | 'planned';

/** Records an outfit of the day for an occasion (nothing for NONE). */
type Plan = (outfit: number, occasion: Occasion, worn: boolean) => void;

/** A laundry Sunday: the garments washed that day (every one worn since the last). */
interface SimulatedWash {
  day: IsoDate;
  /** Bible ids. */
  garmentIds: string[];
}

export interface SimulatedLife {
  /**
   * Days added to the garments' reference dates (acquired, archived):
   * whole weeks, so the wardrobe stands where it did relative to the anchor.
   */
  shiftDays: number;
  /**
   * Days added to the Events' reference dates (and the trips', #10): whole
   * 52-week years, so they keep their season.
   */
  eventShiftDays: number;
  /** The history's first day and the anchor (its last). */
  first: IsoDate;
  anchor: IsoDate;
  entries: SimulatedEntry[];
  /** Laundry Sundays up to the anchor (the planned week's are not history). */
  washes: SimulatedWash[];
  weather: Weather[];
}

function dayKind(day: IsoDate, anchor: IsoDate): DayKind {
  if (day < anchor) return 'past';
  return day === anchor ? 'today' : 'planned';
}

/** Whole weeks from the reference anchor to `anchor`, never past it. */
function shiftFor(anchor: IsoDate): number {
  return Math.floor(daysBetween(REFERENCE_ANCHOR, anchor) / 7) * 7;
}

// Events keep their season: they move by whole 52-week years (364 days, so
// a Saturday stays a Saturday) to the year nearest the anchor. Seeded in
// January, the summer's beach day and heat wave are simply not in the window.
const YEAR_OF_WEEKS = 364;

function eventShiftFor(anchor: IsoDate): number {
  return (
    Math.round(daysBetween(REFERENCE_ANCHOR, anchor) / YEAR_OF_WEEKS) *
    YEAR_OF_WEEKS
  );
}

export function simulate(persona: Persona, anchor: IsoDate): SimulatedLife {
  const shiftDays = shiftFor(anchor);
  const first = addDays(anchor, -(persona.historyDays - 1));
  const shifted = (day: IsoDate) => addDays(day, shiftDays);
  const eventShift = eventShiftFor(anchor);
  const events = persona.events.map((event) => ({
    ...event,
    from: addDays(event.from, eventShift),
    to: addDays(event.to, eventShift),
  }));
  const eventOn = (day: IsoDate) =>
    events.find((e) => e.from <= day && day <= e.to);
  const weather = weatherFor(
    persona.key,
    first,
    persona.historyDays + PLANNED_DAYS,
    (day) => eventOn(day)?.weatherShift ?? 0,
  );
  const life: SimulatedLife = {
    shiftDays,
    eventShiftDays: eventShift,
    first,
    anchor,
    entries: [],
    washes: [],
    weather,
  };
  if (!persona.week) return life;

  const day = new Days(persona, shifted, anchor);
  for (const today of weather) {
    const kind = dayKind(today.day, anchor);
    day.live(today, kind, eventOn(today.day), life.entries);
    if (dayOfWeek(today.day) === SUNDAY) {
      const washed = day.laundry();
      if (kind !== 'planned' && washed.length > 0) {
        life.washes.push({ day: today.day, garmentIds: washed });
      }
    }
  }
  return life;
}

/** The simulation's state as the days go by: dirty clothes and recent outfits. */
class Days {
  // Days each garment was worn since its wash: the app counts wears by
  // distinct day (a morning and an evening outfit are one wear).
  private readonly wornSinceWash = new Map<string, Set<IsoDate>>();
  private readonly lastWorn = new Map<number, IsoDate>();
  private readonly garments: Map<string, SeedGarment>;

  constructor(
    private readonly persona: Persona,
    private readonly shifted: (day: IsoDate) => IsoDate,
    private readonly anchor: IsoDate,
  ) {
    this.garments = new Map(persona.garments.map((g) => [g.id, g]));
  }

  /**
   * One day. The anchor is today, half lived (#15, Today): the morning's
   * workout is done and worn, the evening planned, and the day's own outfit
   * not chosen yet, which is what Today suggests (an Event's outfit is
   * decided already: planned). The rotation still draws the day's outfit,
   * so the planned week after it is the one it always was. On a planned
   * day the template's slots (the day's outfit, the workout) are left to
   * "Plan my week" (#16): drawn and counted as worn here all the same, so
   * the draws and the evenings after them stay as they were.
   */
  live(
    weather: Weather,
    kind: DayKind,
    event: SeedEvent | undefined,
    entries: SimulatedEntry[],
  ): void {
    const { day } = weather;
    if (event && !event.recorded) return;
    const main = this.mainOutfit(weather, event);
    if (main === NONE) return;
    const workout = event ? NONE : this.workout(weather);
    // Worn whether or not he logs it: the laundry does not care.
    this.wear(workout, day);
    this.wear(main, day);
    if (!this.logged(day, kind, event)) return;
    const plan: Plan = (outfit, occasion, worn) => {
      if (outfit === NONE) return;
      const selfie =
        worn &&
        SELFIE_OCCASIONS.includes(occasion) &&
        daysBetween(day, this.anchor) < SELFIE_DAYS;
      entries.push({ day, outfit, occasion, worn, selfie });
    };
    if (kind !== 'planned') plan(workout, 'workout', true);
    this.planDay(weather, kind, event, main, plan);
    const evening = event ? undefined : this.eveningOn(day);
    if (!evening) return;
    const outfit = this.choose([evening], weather, 'evening', main);
    this.wear(outfit, day);
    plan(outfit, EVENING_OCCASIONS[evening], kind === 'past');
  }

  // The day's own outfit: a past day's as worn (with, some office days, the
  // one planned and left for the rain); on the anchor and the planned week
  // none unless an Event decided it (Today suggests one; "Plan my week"
  // fills the planned week, #16).
  private planDay(
    weather: Weather,
    kind: DayKind,
    event: SeedEvent | undefined,
    main: number,
    plan: Plan,
  ): void {
    const occasion = this.dayOccasion(weather.day, main);
    if (kind === 'past') {
      plan(this.changeOfMind(weather, main), occasion, false);
    }
    if (kind === 'past' || event) plan(main, occasion, kind === 'past');
  }

  // The week row's calendar occasion for an outfit the day draws from; an
  // Event's outfit from outside them (the wedding, the beach, the travel
  // day) is all day. The first cool Thursday's chore coat is still work.
  private dayOccasion(day: IsoDate, outfit: number): Occasion {
    const draws = this.occasionsOn(day);
    const drawn = this.persona.outfits[outfit].occasions.some((o) =>
      draws.includes(o),
    );
    return drawn ? this.weekday(day).occasion : DEFAULT_OCCASION;
  }

  // The week's morning workout (a run, the gym), before the day's outfit;
  // NONE when the day has none, he skipped it (one in five), or the weather
  // is outside the outfit's bands (no run in freezing weather).
  private workout(weather: Weather): number {
    const name = this.weekday(weather.day).workout;
    if (!name) return NONE;
    const index = this.persona.outfits.findIndex((o) => o.name === name);
    const outfit = this.persona.outfits[index];
    const skipped = stream(this.persona.key, 'workout', weather.day).chance(
      WORKOUT_SKIPPED,
    );
    return skipped ||
      bandDistance(outfit.bands, weather.band) > 0 ||
      !this.available(outfit, weather.day)
      ? NONE
      : index;
  }

  // The event's outfit, else the day's draw.
  private mainOutfit(weather: Weather, event: SeedEvent | undefined): number {
    return event?.wears
      ? this.persona.outfits.findIndex((o) => o.name === event.wears)
      : this.choose(this.occasionsOn(weather.day), weather, 'day');
  }

  // An event is a day he remembers; an ordinary one he logs most days.
  private logged(
    day: IsoDate,
    kind: DayKind,
    event: SeedEvent | undefined,
  ): boolean {
    return (
      kind !== 'past' ||
      event !== undefined ||
      stream(this.persona.key, 'logged', day).chance(LOGGED)
    );
  }

  // The office outfit he planned and did not wear (rain changed his mind);
  // -1 on most days.
  private changeOfMind(weather: Weather, worn: number): number {
    const changed =
      this.occasionsOn(weather.day).includes('office') &&
      stream(this.persona.key, 'change-of-mind', weather.day).chance(
        OFFICE_CHANGE_OF_MIND,
      );
    return changed ? this.choose(['office'], weather, 'skipped', worn) : -1;
  }

  /**
   * Sunday: everything worn since the last wash that ever gets washed comes
   * back clean (shoes and bags are not laundered; the raw denim is never
   * washed). Returns what was washed, in bible order.
   */
  laundry(): string[] {
    const washed = this.persona.garments
      .filter(
        (g) =>
          (this.wornSinceWash.get(g.id)?.size ?? 0) > 0 &&
          washLimit(g.fields.category, g.fields.washAfterWears ?? null) !==
            null,
      )
      .map((g) => g.id);
    this.wornSinceWash.clear();
    return washed;
  }

  private weekday(day: IsoDate) {
    return this.persona.week![dayOfWeek(day)];
  }

  // The week's row, with a meeting Wednesday's office day made a meeting.
  private occasionsOn(day: IsoDate): BibleOccasion[] {
    const { draws } = this.weekday(day);
    const weeks = daysBetween(this.shifted(REFERENCE_MEETING_WEDNESDAY), day);
    const meeting = dayOfWeek(day) === WEDNESDAY && mod(weeks / 7, 2) === 0;
    return meeting ? draws.map((o) => (o === 'office' ? 'meeting' : o)) : draws;
  }

  // The evening's second outfit, on most days none: date night (most
  // weeks, Friday or Saturday) and a night out with friends every third
  // week (Thursday, or Saturday when that is free).
  private eveningOn(day: IsoDate): 'date' | 'night-out' | undefined {
    const weekday = dayOfWeek(day);
    const sunday = addDays(day, -weekday);
    const random = stream(this.persona.key, 'evenings', sunday);
    // Gotcha: the draws' order and short-circuits are the seed's
    // determinism; reordering them changes every persona's evenings.
    let dateNight: number | undefined;
    if (random.chance(DATE_NIGHT_WEEKLY)) {
      dateNight = random.chance(DATE_NIGHT_FRIDAY) ? FRIDAY : SATURDAY;
    }
    const week =
      daysBetween(startOfWeek(this.shifted(REFERENCE_ANCHOR)), sunday) / 7;
    let nightOut: number | undefined;
    if (mod(week, NIGHT_OUT_EVERY_WEEKS) === 0) {
      nightOut =
        dateNight === SATURDAY || random.chance(0.5) ? THURSDAY : SATURDAY;
    }
    if (weekday === dateNight) return 'date';
    if (weekday === nightOut) return 'night-out';
    return undefined;
  }

  /**
   * A saved outfit for the occasions and the weather, weighted (favourites,
   * not what was just worn, rain gear in the rain); -1 when none fits. With
   * nothing clean in the day's band, the neighbouring bands, then dirty
   * clothes, are tried.
   */
  private choose(
    occasions: BibleOccasion[],
    weather: Weather,
    slot: string,
    except = -1,
  ): number {
    const fits = (outfit: SeedOutfit, index: number) =>
      index !== except &&
      outfit.occasions.some((o) => occasions.includes(o)) &&
      this.available(outfit, weather.day);
    const tiers: [number, boolean][] = [
      [0, false],
      [1, false],
      [0, true],
      [1, true],
      [2, true],
    ];
    for (const [distance, dirtyOk] of tiers) {
      const candidates = this.persona.outfits.flatMap((outfit, index) =>
        fits(outfit, index) &&
        bandDistance(outfit.bands, weather.band) <= distance &&
        (dirtyOk || this.clean(outfit))
          ? [index]
          : [],
      );
      if (candidates.length === 0) continue;
      const weights = candidates.map((index) =>
        this.weight(this.persona.outfits[index], index, weather),
      );
      const random = stream(this.persona.key, 'outfit', slot, weather.day);
      return candidates[random.weighted(weights)];
    }
    return -1;
  }

  private weight(outfit: SeedOutfit, index: number, weather: Weather): number {
    let weight = outfit.favourite ? FAVOURITE_WEIGHT : 1;
    const last = this.lastWorn.get(index);
    const since = last ? daysBetween(last, weather.day) : Infinity;
    if (since === 1) weight *= WORN_YESTERDAY;
    else if (since <= RECENT_DAYS) weight *= WORN_RECENTLY;
    if (weather.rain && outfit.occasions.includes('rain')) {
      weight *= RAIN_OUTFIT_WEIGHT;
    }
    return weight;
  }

  // Owned by then: acquired (reference dates, shifted) and not yet archived.
  private available(outfit: SeedOutfit, day: IsoDate): boolean {
    return outfit.garmentIds.every((id) => {
      const garment = this.garments.get(id)!;
      const acquired = garment.fields.acquiredOn;
      return (
        (!acquired || this.shifted(acquired) <= day) &&
        (!garment.archivedOn || day < this.shifted(garment.archivedOn))
      );
    });
  }

  // A clean copy of every garment left, by the app's rule (cleanCopies):
  // the wears the garment form's "wash after" and quantity allow.
  private clean(outfit: SeedOutfit): boolean {
    return outfit.garmentIds.every((id) => {
      const { fields } = this.garments.get(id)!;
      return (
        cleanCopies({
          quantity: fields.quantity ?? 1,
          limit: washLimit(fields.category, fields.washAfterWears ?? null),
          wearsSinceWash: this.wornSinceWash.get(id)?.size ?? 0,
        }) > 0
      );
    });
  }

  // Nothing for NONE (no workout, no evening outfit that day).
  private wear(outfit: number, day: IsoDate): void {
    if (outfit === NONE) return;
    this.lastWorn.set(outfit, day);
    for (const id of this.persona.outfits[outfit].garmentIds) {
      const days = this.wornSinceWash.get(id) ?? new Set<IsoDate>();
      this.wornSinceWash.set(id, days.add(day));
    }
  }
}

/** How many bands the nearest of `bands` is from `band`; Infinity for none. */
function bandDistance(bands: readonly Band[], band: Band): number {
  const at = BANDS.indexOf(band);
  return Math.min(...bands.map((b) => Math.abs(BANDS.indexOf(b) - at)));
}

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}
