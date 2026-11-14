import { Value } from '@sinclair/typebox/value';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SharePermission } from '../db/schema';
import { PROJECT_ROOT } from '../project-root';
import { type IsoDate, parseIsoDate } from '../calendar-date';
import type { CapsuleFields } from '../web/capsules/queries';
import { CapsuleBody, readCapsuleForm } from '../web/capsules/validation';
import {
  readStyleProfileForm,
  StyleProfileBody,
  type StyleProfileFields,
} from '../web/style/validation';
import {
  readWeekTemplateForm,
  WeekTemplateBody,
  weekTemplatePost,
} from '../web/week-plan/template';
import type { TemplateSlot, Weekday } from '../wardrobe/week';
import type { TripFields } from '../web/trips/queries';
import { readTripForm, TripBody } from '../web/trips/validation';
import {
  BrandSizeBody,
  type BrandSizeFields,
  MeasurementsBody,
  readBrandSizeForm,
  readMeasurementsForm,
} from '../web/sizes/validation';
import { normalizeCategory } from '../web/wardrobe/garment';
import {
  type NewRepair,
  readRepairForm,
  RepairBody,
} from '../web/wardrobe/repairs';
import {
  CARE_NOTE_MAX,
  GarmentBody,
  type GarmentFields,
  readGarmentForm,
} from '../web/wardrobe/garment-input';
import { carePresetsFor, type CareLabel } from '../wardrobe/care';
import {
  AWAY_REASONS,
  type AwayReason,
  defaultWashAfter,
  NEVER_WASH,
} from '../wardrobe/availability';
import {
  DAY_OCCASIONS,
  DEFAULT_OCCASION,
  isOccasion,
  type Occasion,
} from '../wardrobe/occasions';
import { brandKey } from '../wardrobe/brands';
import {
  type LengthUnit,
  type Measurement,
  type Measurements,
  MEASUREMENTS,
  NO_MEASUREMENTS,
} from '../wardrobe/measurements';
import {
  categoryRole,
  GARMENT_ROLES,
  GarmentCategory,
  type GarmentRole,
  MATERIALS,
  propertyApplies,
  storedSet,
} from '../wardrobe/properties';
import { type Location, roundedLocation } from '../weather/location';
import {
  isTemperatureUnit,
  type TemperatureUnit,
} from '../weather/temperature';
import {
  BibleError,
  type BibleTable,
  linkUrl,
  list,
  plain,
  readTables,
} from './bible';
import { HISTORY_DAYS, REFERENCE_ANCHOR } from './simulate';
import { BANDS, type Band } from './weather';

/**
 * A persona as the seed writes it, read from its character bible
 * (src/seed/personas/<key>.md) and checked against the app's own rules
 * before anything is written: every garment goes through the garment
 * form's schema and readGarmentForm, and a value the form would drop (a
 * type from another category, a sleeve on shoes) is an error, not a
 * silently different wardrobe.
 */

export const PERSONA_KEYS = ['demo', 'fresh', 'sparse'] as const;
export type PersonaKey = (typeof PERSONA_KEYS)[number];

/**
 * The scale persona (scale.ts) has no bible: it is generated from demo's, so
 * it is a seed key but not a PERSONA_KEY, and `--persona all` leaves it out.
 */
export type SeedKey = PersonaKey | 'scale';

export function isSeedKey(value: string): value is SeedKey {
  return (
    value === 'scale' || (PERSONA_KEYS as readonly string[]).includes(value)
  );
}

/**
 * What a saved outfit is for, in the bible's own words (its Occasion
 * column); a day draws from some of these (its week row). Not the calendar
 * entry's occasion (src/wardrobe/occasions.ts, the part of the day), which
 * the week row's Calendar column and the simulation's evenings decide.
 */
const BIBLE_OCCASIONS = [
  'office',
  'meeting',
  'rain',
  'weekend',
  'wfh',
  'workout',
  'date',
  'night-out',
  'formal',
  'travel',
  'beach',
] as const;
export type BibleOccasion = (typeof BIBLE_OCCASIONS)[number];

export interface SeedGarment {
  /** The bible's id (T01), which outfits and events refer to. */
  id: string;
  /**
   * As the garment form stores it (readGarmentForm's result), care fields
   * included: copies (the Qty column), wears before a wash (the Laundry
   * table) and condition (the Condition table).
   */
  fields: GarmentFields;
  role: GarmentRole;
  archivedOn: IsoDate | null;
  /** Whether the garment has a (generated) photo. */
  photo: boolean;
  /** Out of the closet at the anchor (the Away table), written by setAway. */
  away: { reason: AwayReason; note: string | null } | null;
  /**
   * Its repair and alteration log (the Repairs table, #23), days as the
   * bible dates them (moved with the acquisitions), written by addRepair.
   */
  repairs: NewRepair[];
}

/**
 * A wishlist item (the bible's Wishlist table, #18): a garment row like the
 * others, written with status 'wishlist', never worn, in no outfit or
 * capsule, and optionally the garment it would replace.
 */
export interface SeedWishlistItem {
  id: string;
  fields: GarmentFields;
  photo: boolean;
  /** The owned garment's bible id it would replace; null for none. */
  replaces: string | null;
}

export interface SeedOutfit {
  /** null: untitled. */
  name: string | null;
  favourite: boolean;
  /** None: saved, never drawn. */
  occasions: BibleOccasion[];
  bands: Band[];
  /** Garment ids in builder order (outfitSlotOrder). */
  garmentIds: string[];
}

interface SeedCapsule {
  /** As the capsule form stores them (readCapsuleForm's result). */
  fields: CapsuleFields;
  /** Garment ids (archived ones too: they keep their membership). */
  garmentIds: string[];
}

/** A row of the week table: one weekday's rules. */
interface SeedDay {
  /** The occasions the day's outfit is drawn from. */
  draws: BibleOccasion[];
  /** The calendar occasion of the day's outfit (all day, work). */
  occasion: Occasion;
  /** The saved outfit of a morning workout (by name), before the day's outfit. */
  workout: string | undefined;
}

export interface SeedEvent {
  from: IsoDate;
  to: IsoDate;
  name: string;
  /** The saved outfit worn (by name); undefined when the rules decide. */
  wears: string | undefined;
  /** False: the day is not logged at all (he forgot). */
  recorded: boolean;
  /** °F added to the day's high. */
  weatherShift: number;
}

type LaundrySelector =
  | { role: GarmentRole }
  | { types: string[] }
  | { garmentId: string };

/** A row of the Laundry table: it overrides the app's default for what it selects. */
interface LaundryRule {
  selector: LaundrySelector;
  /** Wears before a wash; null: never washed. */
  wears: number | null;
}

/** The Account table's weather rows: where the persona lives, and how they read it. */
export interface PersonaWeather {
  home: { name: string; location: Location };
  unit: TemperatureUnit;
}

/**
 * A trip of the bible's (#10, the Trips tables): the trip form's fields
 * (reference dates, moved with the Events by the seed), its located
 * destination, its outfits by saved outfit name for a day and occasion, its
 * extras and which garments are marked packed.
 */
interface SeedTrip {
  fields: TripFields;
  location: Location | null;
  outfits: { day: IsoDate; occasion: Occasion | undefined; outfit: string }[];
  extras: { label: string; packed: boolean }[];
  /** Garment ids of the bible's, each in one of the trip's outfits. */
  packed: string[];
}

/**
 * The persona's sizes (#24, Profile › Sizes): the Measurements table
 * (its `Unit` row the unit, the rest in that unit) and the Brand sizes
 * table, each through the editor's own readers.
 */
export interface SeedSizes {
  unit: LengthUnit;
  lengths: Measurements;
  brands: BrandSizeFields[];
}

export interface Persona {
  key: SeedKey;
  account: { email: string; firstName: string; lastName: string };
  /** Their weather settings (#14); null without a `Weather home` row. */
  weather: PersonaWeather | null;
  /** Personas this one shares its wardrobe with, once both exist. */
  sharesWith: { persona: SeedKey; permission: SharePermission }[];
  /** What the persona owns (the closet and the archive). */
  garments: SeedGarment[];
  /** What the persona is thinking of buying. */
  wishlist: SeedWishlistItem[];
  outfits: SeedOutfit[];
  capsules: SeedCapsule[];
  /** The Style profile table (#34); null without it. */
  styleProfile: StyleProfileFields | null;
  /** The Measurements and Brand sizes tables (#24); null without either. */
  sizes: SeedSizes | null;
  /**
   * The week template (#16), the week table as a template: each day's
   * `Calendar` occasion, and a workout where it has a `Workout`. Null
   * without a week. Evenings and nights out come some weeks, not on a
   * weekday: they stay out of it, planned by hand.
   */
  weekTemplate: TemplateSlot[] | null;
  /** The Clashes table: garment id pairs the outfit generator never combines (#9). */
  avoid: [string, string][];
  /** Sunday first; null without a history. */
  week: SeedDay[] | null;
  /** Days of worn history before the anchor. */
  historyDays: number;
  events: SeedEvent[];
  trips: SeedTrip[];
}

/** Where the bibles live, from src/ and dist/ alike (the image copies them). */
const PERSONAS_DIR = join(PROJECT_ROOT, 'src', 'seed', 'personas');

export function loadPersona(key: PersonaKey): Persona {
  const path = join(PERSONAS_DIR, `${key}.md`);
  return parsePersona(key, readFileSync(path, 'utf8'));
}

export function parsePersona(key: PersonaKey, markdown: string): Persona {
  const source = `${key}.md`;
  const tables = readTables(markdown, source);
  const find = (...columns: string[]) =>
    tables.filter((table) => columns.every((c) => table.columns.includes(c)));
  const account = find('Field', 'Value')[0];
  if (!account) throw new BibleError(source, 'no Account table');
  const fields = Object.fromEntries(
    account.rows.map((row) => [row.Field, plain(row.Value)]),
  );
  // The garment tables: the Wishlist one holds what is not owned yet, and
  // its ids are nowhere else (not in outfits, capsules or the care tables).
  const garmentTables = find('id', 'Colours').filter(
    (table) => table.heading !== WISHLIST_HEADING,
  );
  const wishlistTables = find('id', 'Colours').filter(
    (table) => table.heading === WISHLIST_HEADING,
  );
  const ids = new Set(
    garmentTables.flatMap((table) => table.rows.map((row) => row.id)),
  );
  const care: GarmentCare = {
    laundry: find('Garments', 'Wears before a wash').flatMap((table) =>
      table.rows.map((row) => readLaundryRule(source, row, ids)),
    ),
    conditions: garmentNotes(source, find('Garment', 'Condition'), ids),
    away: garmentNotes(source, find('Garment', 'Away'), ids),
    labels: garmentRows(source, find('Garment', 'Wash', 'Dry cleaning'), ids),
    repairs: repairRows(source, find('Garment', 'Kind', 'What was done'), ids),
  };
  const garments = garmentTables.flatMap((table) =>
    table.rows.map((row) => readGarment(source, table, row, care)),
  );
  const wishlist = wishlistTables.flatMap((table) =>
    table.rows.map((row) => readWishlistItem(source, table, row, ids)),
  );
  const outfits = find('Garments', 'Occasion').flatMap((table) =>
    table.rows.map((row) => readOutfit(source, row, ids)),
  );
  const names = new Set(outfits.flatMap((o) => o.name ?? []));
  const week = find('Day', 'Draws from')[0];
  const seedWeek = week ? readWeek(source, week, names) : null;
  return {
    key,
    account: {
      email: required(source, fields, 'Email'),
      firstName: required(source, fields, 'First name'),
      lastName: required(source, fields, 'Last name'),
    },
    weather: readWeather(source, fields),
    sharesWith: list(fields['Shares with'] ?? '').map((share) =>
      readShare(source, share),
    ),
    garments,
    wishlist,
    outfits,
    capsules: uniqueNames(
      source,
      find('Capsule', 'Garments').flatMap((table) =>
        table.rows.map((row) => readCapsule(source, row, ids)),
      ),
    ),
    styleProfile: readStyleProfile(source, find('Setting', 'Value')[0]),
    sizes: readSizes(source, {
      measurements: find('Measurement', 'Value')[0],
      brands: find('Brand', 'Size', 'Note').filter(
        (table) => table.heading === BRAND_SIZES_HEADING,
      )[0],
    }),
    avoid: readClashes(source, find('Garment', 'Never with'), ids, outfits),
    week: seedWeek,
    historyDays: HISTORY_DAYS,
    weekTemplate: seedWeek ? readWeekTemplate(source, seedWeek) : null,
    events: find('From', 'To', 'Wears').flatMap((table) =>
      table.rows.map((row) => readEvent(source, row, names)),
    ),
    trips: readTrips(source, {
      trips: find('Trip', 'From', 'To', 'Destination'),
      outfits: find('Trip', 'Day', 'Occasion', 'Outfit'),
      extras: find('Trip', 'Extra', 'Packed'),
      packed: find('Trip', 'Garments packed'),
      outfitsByName: new Map(
        outfits.flatMap((o) => (o.name ? [[o.name, o] as const] : [])),
      ),
    }),
  };
}

/**
 * The Trips tables (#10): each trip through the trip form's own two
 * layers, its outfits (saved outfits by name, on one of its days, a known
 * occasion or `—`), its extras (`yes`/`no` packed) and its packed garments,
 * which must be in one of its outfits (the app keeps a mark only for a
 * garment on the list). A row naming no trip of the table is refused.
 */
function readTrips(
  source: string,
  tables: {
    trips: BibleTable[];
    outfits: BibleTable[];
    extras: BibleTable[];
    packed: BibleTable[];
    outfitsByName: Map<string, SeedOutfit>;
  },
): SeedTrip[] {
  const rows = (of: BibleTable[]) => of.flatMap((table) => table.rows);
  const trips = new Map<string, SeedTrip>();
  for (const row of rows(tables.trips)) {
    const trip = readTrip(source, row);
    if (trips.has(trip.fields.name)) {
      throw new BibleError(source, `trip "${trip.fields.name}" listed twice`);
    }
    trips.set(trip.fields.name, trip);
  }
  const tripOf = (row: Record<string, string>, table: string) => {
    const found = trips.get(plain(row.Trip));
    if (!found) {
      throw new BibleError(source, `${table}: no trip "${plain(row.Trip)}"`);
    }
    return found;
  };
  for (const row of rows(tables.outfits)) {
    const trip = tripOf(row, 'Trip outfits');
    trip.outfits.push(readTripOutfit(source, trip, row, tables.outfitsByName));
  }
  for (const row of rows(tables.extras)) {
    tripOf(row, 'Trip extras').extras.push(readTripExtra(source, row));
  }
  for (const row of rows(tables.packed)) {
    const trip = tripOf(row, 'Trip packing');
    trip.packed.push(
      ...readTripPacked(source, trip, row, tables.outfitsByName),
    );
  }
  return [...trips.values()];
}

// Through the trip form's own two layers, like a capsule.
function readTrip(source: string, row: Record<string, string>): SeedTrip {
  const where = `${source} trip "${plain(row.Trip)}"`;
  const post = {
    name: plain(row.Trip),
    destination: plain(row.Destination),
    startsOn: plain(row.From),
    endsOn: plain(row.To),
    notes: plain(row.Notes ?? ''),
  };
  if (!Value.Check(TripBody, post)) {
    throw new BibleError(where, 'not a trip form post');
  }
  const form = readTripForm(post);
  if (!form.ok) throw new BibleError(where, JSON.stringify(form.errors));
  return {
    fields: form.fields,
    location: readLocation(where, 'Location', plain(row.Location ?? '')),
    outfits: [],
    extras: [],
    packed: [],
  };
}

// A saved outfit by name, on one of the trip's days, a known occasion or none.
function readTripOutfit(
  source: string,
  trip: SeedTrip,
  row: Record<string, string>,
  outfitsByName: Map<string, SeedOutfit>,
): SeedTrip['outfits'][number] {
  const where = `${source} trip "${trip.fields.name}" on ${row.Day}`;
  const day = readDate(where, row.Day);
  const outfit = plain(row.Outfit);
  const occasion = plain(row.Occasion);
  if (!day || day < trip.fields.startsOn || day > trip.fields.endsOn) {
    throw new BibleError(where, 'not a day of the trip');
  }
  if (!outfitsByName.has(outfit)) {
    throw new BibleError(where, `no saved outfit is called "${outfit}"`);
  }
  if (occasion && !isOccasion(occasion)) {
    throw new BibleError(where, `not an occasion: ${occasion}`);
  }
  return {
    day,
    occasion: occasion ? (occasion as Occasion) : undefined,
    outfit,
  };
}

function readTripExtra(
  source: string,
  row: Record<string, string>,
): SeedTrip['extras'][number] {
  const packed = plain(row.Packed);
  if (packed !== 'yes' && packed !== 'no') {
    throw new BibleError(source, `Trip extras: "${packed}" is not yes or no`);
  }
  return { label: plain(row.Extra), packed: packed === 'yes' };
}

// Only garments of the trip's outfits: the app keeps no other mark.
function readTripPacked(
  source: string,
  trip: SeedTrip,
  row: Record<string, string>,
  outfitsByName: Map<string, SeedOutfit>,
): string[] {
  const onList = new Set(
    trip.outfits.flatMap((o) => outfitsByName.get(o.outfit)!.garmentIds),
  );
  const packed = list(row['Garments packed']);
  const stray = packed.find((id) => !onList.has(id));
  if (stray) {
    throw new BibleError(
      source,
      `Trip packing: ${stray} is in no outfit of "${trip.fields.name}"`,
    );
  }
  return packed;
}

/** "30.27, -97.74", already rounded as the app stores it; none for `—`. */
function readLocation(
  where: string,
  label: string,
  text: string,
): Location | null {
  if (!text) return null;
  const [latitude, longitude] = text
    .split(',')
    .map((part) => Number(part.trim()));
  const location = roundedLocation(latitude, longitude);
  if (
    !location ||
    location.latitude !== latitude ||
    location.longitude !== longitude
  ) {
    throw new BibleError(
      where,
      `${label} is not a rounded "latitude, longitude": ${text}`,
    );
  }
  return location;
}

/**
 * The Clashes tables: pairs of two owned garments the generator never puts
 * together. A pair inside a saved outfit contradicts the story (he wears
 * them together), so it is refused.
 */
function readClashes(
  source: string,
  tables: BibleTable[],
  garmentIds: Set<string>,
  outfits: SeedOutfit[],
): [string, string][] {
  return tables.flatMap((table) =>
    table.rows.map((row): [string, string] => {
      const a = plain(row.Garment);
      const b = plain(row['Never with']);
      if (!garmentIds.has(a) || !garmentIds.has(b) || a === b) {
        throw new BibleError(
          source,
          `Clashes: "${a}" and "${b}" are not two owned garments`,
        );
      }
      if (
        outfits.some(
          (o) => o.garmentIds.includes(a) && o.garmentIds.includes(b),
        )
      ) {
        throw new BibleError(
          source,
          `Clashes: ${a} and ${b} are together in a saved outfit`,
        );
      }
      return [a, b];
    }),
  );
}

/** The heading of the bible's wishlist table (a garment table otherwise). */
const WISHLIST_HEADING = 'Wishlist';

/** Nothing about care: a wishlist item is not owned, worn or washed. */
const NO_CARE: GarmentCare = {
  laundry: [],
  conditions: new Map(),
  away: new Map(),
  labels: new Map(),
  repairs: new Map(),
};

// A Wishlist row: a garment row through the same form (no acquired date:
// it is not bought), and what it replaces, an owned garment's id.
function readWishlistItem(
  source: string,
  table: BibleTable,
  row: Record<string, string>,
  ownedIds: Set<string>,
): SeedWishlistItem {
  const where = `${source} ${row.id}`;
  if (ownedIds.has(row.id)) {
    throw new BibleError(where, 'a wishlist id is also an owned garment');
  }
  const { id, fields, photo } = readGarment(source, table, row, NO_CARE);
  if (fields.acquiredOn !== null) {
    throw new BibleError(where, 'a wishlist item has no acquired date');
  }
  const replaces = plain(row.Replaces ?? '') || null;
  if (replaces !== null && !ownedIds.has(replaces)) {
    throw new BibleError(where, `replaces "${replaces}", not an owned garment`);
  }
  return { id, fields, photo, replaces };
}

/**
 * The tables that add to garments by id: Laundry, Condition, Away, Care
 * labels and Repairs.
 */
interface GarmentCare {
  laundry: LaundryRule[];
  /** Garment id to its Condition row's value and note. */
  conditions: Map<string, { value: string; note: string }>;
  /** Garment id to its Away row's value and note. */
  away: Map<string, { value: string; note: string }>;
  /** Garment id to its Care labels row: where the label differs from its materials. */
  labels: Map<string, Record<string, string>>;
  /** Garment id to its Repairs rows. */
  repairs: Map<string, Record<string, string>[]>;
}

// A table with one row per garment id (the Care labels), rows as read.
function garmentRows(
  source: string,
  tables: BibleTable[],
  garmentIds: Set<string>,
): Map<string, Record<string, string>> {
  const rows = new Map<string, Record<string, string>>();
  for (const table of tables) {
    for (const row of table.rows) {
      const id = plain(row.Garment);
      if (!garmentIds.has(id) || rows.has(id)) {
        throw new BibleError(
          source,
          `${table.heading}: "${id}" is not a garment, or is listed twice`,
        );
      }
      rows.set(id, row);
    }
  }
  return rows;
}

// The Repairs table's rows by garment id, several a garment.
function repairRows(
  source: string,
  tables: BibleTable[],
  garmentIds: Set<string>,
): Map<string, Record<string, string>[]> {
  const rows = new Map<string, Record<string, string>[]>();
  for (const table of tables) {
    for (const row of table.rows) {
      const id = plain(row.Garment);
      if (!garmentIds.has(id)) {
        throw new BibleError(
          source,
          `${table.heading}: "${id}" is not a garment`,
        );
      }
      rows.set(id, [...(rows.get(id) ?? []), row]);
    }
  }
  return rows;
}

// A table of (Garment, <value>, Note) rows by garment id: the Condition
// and Away tables. The value column is the one that is neither.
function garmentNotes(
  source: string,
  tables: BibleTable[],
  garmentIds: Set<string>,
): Map<string, { value: string; note: string }> {
  const notes = new Map<string, { value: string; note: string }>();
  for (const table of tables) {
    const column = table.columns.find((c) => c !== 'Garment' && c !== 'Note');
    for (const row of table.rows) {
      const id = plain(row.Garment);
      if (!garmentIds.has(id) || notes.has(id) || !column) {
        throw new BibleError(
          source,
          `${table.heading}: "${id}" is not a garment, or is listed twice`,
        );
      }
      notes.set(id, { value: plain(row[column]), note: plain(row.Note ?? '') });
    }
  }
  return notes;
}

/**
 * `Weather home` (a place's name), `Weather location` ("40.69, -73.97",
 * rounded as the app stores it) and `Temperature unit` (celsius or
 * fahrenheit), all or none.
 */
function readWeather(
  source: string,
  fields: Record<string, string>,
): PersonaWeather | null {
  const name = fields['Weather home'];
  if (name === undefined) return null;
  // Required, so never blank: readLocation answers a location or throws.
  const location = readLocation(
    source,
    'Weather location',
    required(source, fields, 'Weather location'),
  )!;
  const unit = required(source, fields, 'Temperature unit');
  if (!isTemperatureUnit(unit)) {
    throw new BibleError(source, `Temperature unit is not one: ${unit}`);
  }
  return { home: { name, location }, unit };
}

function required(
  source: string,
  fields: Record<string, string>,
  name: string,
): string {
  const value = fields[name];
  if (!value) throw new BibleError(source, `Account has no ${name}`);
  return value;
}

function readShare(source: string, share: string): Persona['sharesWith'][0] {
  const match = /^(\w+) \((VIEW|MANAGE)\)$/.exec(share);
  if (!match || !isSeedKey(match[1])) {
    throw new BibleError(source, `"Shares with" names no persona: ${share}`);
  }
  return {
    persona: match[1],
    permission: match[2] as SharePermission,
  };
}

// The garment tables' columns and the form field each fills. A column the
// seed does not know is an error, so a renamed header cannot quietly drop
// a property.
const FORM_COLUMNS: Record<string, string> = {
  'Name in the app': 'name',
  Brand: 'brand',
  Size: 'size',
  Warmth: 'warmth',
  'Form.': 'formality',
  Pattern: 'pattern',
  Fit: 'fit',
  Sleeve: 'sleeve',
  Length: 'length',
  Acquired: 'dateAquired',
  'Why he owns it': 'notes',
  Notes: 'notes',
};
const OTHER_COLUMNS = new Set([
  'id',
  'Type',
  'Category',
  'Category / type',
  'Colours',
  'Materials',
  'Product',
  'Price',
  'Weight',
  'WR',
  'Qty',
  'Archived',
  'Photo',
  'Replaces',
]);

function readGarment(
  source: string,
  table: BibleTable,
  row: Record<string, string>,
  care: GarmentCare,
): SeedGarment {
  const id = row.id;
  const where = `${source} ${id}`;
  const post = textFields(source, row);
  // A column the table does not have reads as empty.
  const cell = (column: string) => row[column] ?? '';
  const { category, type } = readCategory(where, table, row);
  Object.assign(post, {
    category,
    type: type ?? '',
    color: list(cell('Colours')),
    materials: list(cell('Materials')),
    fabricWeight: /^([\d.]+) oz$/.exec(plain(cell('Weight')))?.[1] ?? '',
    waterResistant: plain(cell('WR')) === 'yes' ? 'true' : undefined,
    sourceUrl: linkUrl(cell('Product')) ?? '',
    price: /\$[\d,]+(?:\.\d{1,2})?/.exec(cell('Price'))?.[0] ?? '',
    ...carePost(care, { id, category: normalizeCategory(category), type }),
    ...careLabelPost(where, care.labels.get(id), {
      category: normalizeCategory(category),
      materials: list(cell('Materials')),
    }),
    quantity: plain(cell('Qty')) || '1',
  });
  const fields = storedFields(where, post);
  return {
    id,
    fields,
    role: categoryRole(fields.category),
    archivedOn: readDate(where, plain(cell('Archived'))),
    photo: plain(cell('Photo')) !== 'no',
    away: readAway(where, care.away.get(id)),
    repairs: readRepairs(where, care.repairs.get(id) ?? [], fields.acquiredOn),
  };
}

// The Care labels table's columns and the form field each fills.
const CARE_LABEL_COLUMNS: Record<string, keyof CareLabel> = {
  Wash: 'careWash',
  Bleach: 'careBleach',
  Dry: 'careDry',
  Iron: 'careIron',
  'Dry cleaning': 'careDryClean',
};

/**
 * The care label as the form posts it: what the materials suggest, as the
 * form's material chips fill it (carePresetsFor), then the Care labels
 * table's row where the label says otherwise (`—` keeps the suggestion).
 * Shoes and bags have no label: a row for one is an error.
 */
function careLabelPost(
  where: string,
  row: Record<string, string> | undefined,
  garment: { category: string; materials: string[] },
): Record<string, string> {
  if (!propertyApplies('careWash', garment.category)) {
    if (row) throw new BibleError(where, 'a care label on a role without one');
    // As the form posts it for shoes: the marker, which stores none.
    return { careLabel: '1' };
  }
  const presets = carePresetsFor(storedSet(MATERIALS, garment.materials) ?? []);
  const post: Record<string, string> = { careLabel: '1' };
  for (const [column, field] of Object.entries(CARE_LABEL_COLUMNS)) {
    const given = plain(row?.[column] ?? '');
    const preset = field === 'careDryClean' ? undefined : presets[field];
    post[field] = given || preset || '';
  }
  return post;
}

// A Repairs row as the edit page's form posts it.
function repairPost(row: Record<string, string>): Record<string, string> {
  return {
    day: plain(row.Day ?? ''),
    kind: plain(row.Kind ?? ''),
    note: plain(row['What was done'] ?? ''),
    cost: /\$[\d,]+(?:\.\d{1,2})?/.exec(row.Cost ?? '')?.[0] ?? '',
  };
}

/**
 * The Repairs rows through the log's own form (readRepairForm: a real day,
 * not after the reference anchor, a note, a cost as a price), and never
 * before the garment was acquired.
 */
function readRepairs(
  where: string,
  rows: Record<string, string>[],
  acquiredOn: IsoDate | null,
): NewRepair[] {
  return rows.map((row) => {
    let body: RepairBody;
    try {
      body = Value.Parse(RepairBody, repairPost(row));
    } catch (error) {
      throw new BibleError(where, `not a repair: ${String(error)}`);
    }
    const form = readRepairForm(body, REFERENCE_ANCHOR);
    if (!form.ok) {
      throw new BibleError(where, `repair: ${JSON.stringify(form.errors)}`);
    }
    if (acquiredOn !== null && form.entry.day < acquiredOn) {
      throw new BibleError(where, `a repair before it was acquired`);
    }
    return form.entry;
  });
}

/** The care fields as the form posts them, from the Laundry and Condition tables. */
function carePost(
  care: GarmentCare,
  garment: { id: string; category: string; type: string | null },
): Record<string, string | undefined> {
  const condition = care.conditions.get(garment.id);
  return {
    care: '1',
    washAfterWears: washAfterFor(care.laundry, garment),
    condition: condition?.value,
    conditionNote: condition?.note,
  };
}

/**
 * The garment form's "wash after" from the Laundry table: its most specific
 * row (an id beats a type, a type beats a role), posted only where it
 * differs from the app's default for the category (so the form shows "the
 * usual" everywhere else); a row's "never" is NEVER_WASH.
 */
function washAfterFor(
  rules: LaundryRule[],
  garment: { id: string; category: string; type: string | null },
): string {
  const role = categoryRole(garment.category);
  const find = (test: (selector: LaundrySelector) => boolean) =>
    rules.find((rule) => test(rule.selector));
  const rule =
    find((s) => 'garmentId' in s && s.garmentId === garment.id) ??
    find((s) => 'types' in s && s.types.includes(garment.type ?? '')) ??
    find((s) => 'role' in s && s.role === role);
  if (!rule || rule.wears === defaultWashAfter(garment.category)) return '';
  return String(rule.wears ?? NEVER_WASH);
}

// The Away table's row, checked as POST /wardrobe/:id/away would.
function readAway(
  where: string,
  row: { value: string; note: string } | undefined,
): SeedGarment['away'] {
  if (!row) return null;
  const reason = AWAY_REASONS.find((r) => r === row.value);
  if (!reason) {
    throw new BibleError(where, `away: "${row.value}" is not lent or repair`);
  }
  if (row.note.length > CARE_NOTE_MAX) {
    throw new BibleError(where, `away: the note is over ${CARE_NOTE_MAX}`);
  }
  return { reason, note: row.note || null };
}

// The columns that are form fields as they are, as the form posts them.
function textFields(
  source: string,
  row: Record<string, string>,
): Record<string, unknown> {
  const post: Record<string, unknown> = {
    props: '1',
    product: '1',
    fabricWeightUnit: 'oz',
  };
  for (const [column, cell] of Object.entries(row)) {
    const field = FORM_COLUMNS[column];
    // A hand-set warmth or formality is marked `*`; the value is the same.
    if (field) post[field] = plain(cell).replace(/\*$/, '');
    else if (!OTHER_COLUMNS.has(column)) {
      throw new BibleError(source, `unknown garment column "${column}"`);
    }
  }
  return post;
}

// The category from its own column, or from the section heading ("Tops").
function readCategory(
  where: string,
  table: BibleTable,
  row: Record<string, string>,
): { category: string; type: string | null } {
  const combined = row['Category / type'];
  if (combined !== undefined) {
    const [category, type] = plain(combined).split('/');
    return { category: category.trim(), type: type?.trim() || null };
  }
  const category = row.Category ?? normalizeCategory(table.heading);
  if (!category) throw new BibleError(where, 'no category');
  return { category: plain(category), type: plain(row.Type ?? '') || null };
}

// The post through both of the form's layers: the route's schema (a value
// outside a property's set is refused there) and readGarmentForm; then
// every posted value must have been kept.
function storedFields(
  where: string,
  post: Record<string, unknown>,
): GarmentFields {
  let body: GarmentBody;
  try {
    body = Value.Parse(GarmentBody, post);
  } catch (error) {
    throw new BibleError(where, `not a garment form post: ${String(error)}`);
  }
  // Each persona posts its own wardrobe.
  const form = readGarmentForm(body, { owner: true });
  if (!form.ok) {
    throw new BibleError(where, JSON.stringify(form.errors));
  }
  const dropped = [
    'type',
    'warmth',
    'formality',
    'pattern',
    'fit',
    'sleeve',
    'length',
    'fabricWeight',
    'sourceUrl',
    'price',
    'conditionNote',
    ...Object.values(CARE_LABEL_COLUMNS),
  ].filter(
    (name) => post[name] && form.fields[name as keyof GarmentFields] === null,
  );
  if (post.waterResistant && !form.fields.waterResistant) {
    dropped.push('waterResistant');
  }
  if ((post.materials as string[]).length > 0 && !form.fields.materials) {
    dropped.push('materials');
  }
  if (dropped.length > 0) {
    throw new BibleError(
      where,
      `the garment form drops ${dropped.join(', ')} for category ${form.fields.category}`,
    );
  }
  return form.fields;
}

function readDate(where: string, text: string): IsoDate | null {
  if (!text) return null;
  const day = parseIsoDate(text);
  if (!day) throw new BibleError(where, `not a date: ${text}`);
  return day;
}

// Builder order: an outfit's slots are written layer first, as the builder
// lists its rows; categories the list lacks come last.
const SLOT_ORDER: readonly string[] = [
  GarmentCategory.OUTERWEAR,
  GarmentCategory.DRESSES,
  GarmentCategory.TOPS,
  GarmentCategory.BOTTOMS,
  GarmentCategory.FOOTWEAR,
  GarmentCategory.ACCESSORIES,
  GarmentCategory.BAGS,
  GarmentCategory.OTHER,
];

/** Slot order of a garment's category (outfits write their slots in it). */
export function slotRank(category: string): number {
  const rank = SLOT_ORDER.indexOf(category);
  return rank === -1 ? SLOT_ORDER.length : rank;
}

/** The garment ids a cell names (`T13 white oxford, B04`), in order. */
function garmentIdsIn(cell: string): string[] {
  return [...cell.matchAll(/\b[A-Z]\d{2}\b/g)].map(([id]) => id);
}

function readOutfit(
  source: string,
  row: Record<string, string>,
  garmentIds: Set<string>,
): SeedOutfit {
  const title = plain(row.Name);
  const favourite = title.endsWith(' *');
  const name = favourite ? title.slice(0, -2) : title;
  const where = `${source} outfit "${name || row['#']}"`;
  const garments = garmentIdsIn(row.Garments);
  const unknown = garments.filter((id) => !garmentIds.has(id));
  if (unknown.length > 0 || garments.length === 0) {
    throw new BibleError(where, `unknown garments: ${unknown.join(', ')}`);
  }
  const occasions = list(row.Occasion);
  const wrong = occasions.filter(
    (o) => !(BIBLE_OCCASIONS as readonly string[]).includes(o),
  );
  if (wrong.length > 0) {
    throw new BibleError(where, `unknown occasions: ${wrong.join(', ')}`);
  }
  return {
    name: name || null,
    favourite,
    occasions: occasions as BibleOccasion[],
    bands: readBands(where, plain(row.Bands)),
    garmentIds: garments,
  };
}

// Through the capsule form's own two layers, like a garment: a name the
// form would refuse (blank, too long) fails here, before anything is written.
function readCapsule(
  source: string,
  row: Record<string, string>,
  garmentIds: Set<string>,
): SeedCapsule {
  const where = `${source} capsule "${plain(row.Capsule)}"`;
  const post = { name: plain(row.Capsule), notes: plain(row.Notes ?? '') };
  if (!Value.Check(CapsuleBody, post)) {
    throw new BibleError(where, 'not a capsule form post');
  }
  const form = readCapsuleForm(post);
  if (!form.ok) throw new BibleError(where, JSON.stringify(form.errors));
  const garments = garmentIdsIn(row.Garments);
  const unknown = garments.filter((id) => !garmentIds.has(id));
  if (unknown.length > 0) {
    throw new BibleError(where, `unknown garments: ${unknown.join(', ')}`);
  }
  return { fields: form.fields, garmentIds: garments };
}

// A wardrobe holds a name once, whatever its case (the capsule table's
// unique index): refused here, before anything is written.
function uniqueNames(source: string, capsules: SeedCapsule[]): SeedCapsule[] {
  const seen = new Set<string>();
  for (const { fields } of capsules) {
    const key = fields.name.toLowerCase();
    if (seen.has(key)) {
      throw new BibleError(source, `two capsules are called "${fields.name}"`);
    }
    seen.add(key);
  }
  return capsules;
}

function readBands(where: string, text: string): Band[] {
  if (text === 'any') return [...BANDS];
  const bands = list(text);
  const wrong = bands.filter((b) => !(BANDS as readonly string[]).includes(b));
  if (wrong.length > 0) {
    throw new BibleError(where, `unknown bands: ${wrong.join(', ')}`);
  }
  return bands as Band[];
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// The Calendar and Workout columns are optional: a week without them plans
// all-day outfits and no workouts.
function readWeek(
  source: string,
  table: BibleTable,
  outfitNames: Set<string>,
): SeedDay[] {
  return WEEKDAYS.map((day) => {
    const row = table.rows.find((r) => r.Day === day);
    if (!row) throw new BibleError(source, `the week has no ${day}`);
    const draws = list(row['Draws from']);
    const wrong = draws.filter(
      (o) => !(BIBLE_OCCASIONS as readonly string[]).includes(o),
    );
    if (wrong.length > 0 || draws.length === 0) {
      throw new BibleError(source, `${day} draws from ${row['Draws from']}`);
    }
    return {
      draws: draws as BibleOccasion[],
      occasion: readCalendarOccasion(source, day, row),
      workout: readWorkout(source, day, row, outfitNames),
    };
  });
}

function readCalendarOccasion(
  source: string,
  day: string,
  row: Record<string, string>,
): Occasion {
  const occasion = plain(row.Calendar ?? '') || DEFAULT_OCCASION;
  if (!isOccasion(occasion)) {
    throw new BibleError(source, `${day}'s calendar occasion ${occasion}`);
  }
  return occasion;
}

function readWorkout(
  source: string,
  day: string,
  row: Record<string, string>,
  outfitNames: Set<string>,
): string | undefined {
  const workout = plain(row.Workout ?? '') || undefined;
  if (workout && !outfitNames.has(workout)) {
    throw new BibleError(
      source,
      `${day}'s workout: no saved outfit is called "${workout}"`,
    );
  }
  return workout;
}

/** The bible's Wears cell for an event whose outfit nobody wrote down. */
const NOT_RECORDED = 'not recorded';

function readEvent(
  source: string,
  row: Record<string, string>,
  outfitNames: Set<string>,
): SeedEvent {
  const where = `${source} event ${row.From}`;
  const wears = plain(row.Wears);
  if (wears && wears !== NOT_RECORDED && !outfitNames.has(wears)) {
    throw new BibleError(where, `no saved outfit is called "${wears}"`);
  }
  const shift = plain(row.Weather);
  return {
    from: readDate(where, row.From)!,
    to: readDate(where, row.To)!,
    name: row.Event,
    wears: wears === NOT_RECORDED ? undefined : wears || undefined,
    recorded: wears !== NOT_RECORDED,
    weatherShift: shift ? Number(shift) : 0,
  };
}

function readLaundryRule(
  source: string,
  row: Record<string, string>,
  garmentIds: Set<string>,
): LaundryRule {
  const selector = plain(row.Garments);
  const wears = plain(row['Wears before a wash']);
  const rule = { wears: wears === 'never' ? null : Number(wears) };
  if (rule.wears !== null && !(rule.wears > 0)) {
    throw new BibleError(source, `laundry: "${wears}" is not a count`);
  }
  if (selector.startsWith('type:')) {
    return { ...rule, selector: { types: list(selector.slice(5)) } };
  }
  if (garmentIds.has(selector)) {
    return { ...rule, selector: { garmentId: selector } };
  }
  if ((GARMENT_ROLES as readonly string[]).includes(selector)) {
    return { ...rule, selector: { role: selector as GarmentRole } };
  }
  throw new BibleError(source, `laundry: "${selector}" selects nothing`);
}

// ---- The style profile (#34) ------------------------------------------------

// The Style profile table's settings and the form field each fills.
const STYLE_SETTINGS: Record<
  string,
  'styles' | 'budget' | 'palette' | 'notes'
> = {
  Styles: 'styles',
  Budget: 'budget',
  Palette: 'palette',
  Notes: 'notes',
};

// Through the style profile form's own two layers: a style or colour the
// form would refuse fails here.
function readStyleProfile(
  source: string,
  settings: BibleTable | undefined,
): StyleProfileFields | null {
  if (!settings) return null;
  const where = `${source} style profile`;
  let body: StyleProfileBody;
  try {
    body = Value.Parse(StyleProfileBody, settingsPost(where, settings.rows));
  } catch (error) {
    throw new BibleError(where, `not a style profile post: ${String(error)}`);
  }
  return readStyleProfileForm(body);
}

// The week table as the template form posts it (#16): a day's Calendar
// occasion that is not the outfit of the day, or anything the form would
// refuse, fails here.
function readWeekTemplate(source: string, week: SeedDay[]): TemplateSlot[] {
  const where = `${source} week template`;
  const notDay = week.find((day) => !DAY_OCCASIONS.includes(day.occasion));
  if (notDay) {
    throw new BibleError(
      where,
      `${notDay.occasion} is not an outfit for the day`,
    );
  }
  const slots = week.flatMap((day, weekday): TemplateSlot[] => [
    { weekday: weekday as Weekday, occasion: day.occasion },
    ...(day.workout
      ? [{ weekday: weekday as Weekday, occasion: 'workout' as const }]
      : []),
  ]);
  let body: WeekTemplateBody;
  try {
    body = Value.Parse(WeekTemplateBody, weekTemplatePost(slots));
  } catch (error) {
    throw new BibleError(where, `not a week template post: ${String(error)}`);
  }
  return readWeekTemplateForm(body);
}

// The Style profile table as the form posts it: the sets as lists.
function settingsPost(
  where: string,
  rows: Record<string, string>[],
): Record<string, unknown> {
  const post: Record<string, unknown> = {};
  for (const row of rows) {
    const field = STYLE_SETTINGS[plain(row.Setting)];
    if (!field) throw new BibleError(where, `unknown setting "${row.Setting}"`);
    const isSet = field === 'styles' || field === 'palette';
    post[field] = isSet ? list(row.Value) : plain(row.Value);
  }
  return post;
}

// ---- Sizes (#24) --------------------------------------------------------------

const BRAND_SIZES_HEADING = 'Brand sizes';

// The Measurements table's rows by name: `Unit`, then a label per measurement.
const MEASUREMENT_ROWS: Record<string, Measurement> = Object.fromEntries(
  MEASUREMENTS.map((m) => [m[0].toUpperCase() + m.slice(1), m]),
);

// Both tables through the Sizes editor's readers: a length out of range or
// a brand row without a size or a note fails here, as the form would
// refuse it; a brand twice (in any case) is refused like the unique index.
function readSizes(
  source: string,
  tables: { measurements?: BibleTable; brands?: BibleTable },
): SeedSizes | null {
  if (!tables.measurements && !tables.brands) return null;
  const where = `${source} sizes`;
  return {
    ...readMeasurementsTable(where, tables.measurements?.rows ?? []),
    brands: readBrandSizesTable(where, tables.brands?.rows ?? []),
  };
}

function readMeasurementsTable(
  where: string,
  rows: Record<string, string>[],
): Pick<SeedSizes, 'unit' | 'lengths'> {
  const post: Record<string, string> = { unit: 'in' };
  for (const row of rows) {
    const label = plain(row.Measurement);
    const field = label === 'Unit' ? 'unit' : MEASUREMENT_ROWS[label];
    if (!field) throw new BibleError(where, `unknown measurement "${label}"`);
    post[field] = plain(row.Value);
  }
  let body: MeasurementsBody;
  try {
    body = Value.Parse(MeasurementsBody, post);
  } catch (error) {
    throw new BibleError(where, `not a measurements post: ${String(error)}`);
  }
  const form = readMeasurementsForm(body, NO_MEASUREMENTS);
  if (!form.ok) throw new BibleError(where, JSON.stringify(form.errors));
  return { unit: body.unit, lengths: form.lengths };
}

function readBrandSizesTable(
  where: string,
  rows: Record<string, string>[],
): BrandSizeFields[] {
  const brands = rows.map((row) => {
    const post = {
      brand: plain(row.Brand),
      size: plain(row.Size),
      note: plain(row.Note),
    };
    let body: BrandSizeBody;
    try {
      body = Value.Parse(BrandSizeBody, post);
    } catch (error) {
      throw new BibleError(where, `not a brand size post: ${String(error)}`);
    }
    const read = readBrandSizeForm(body);
    if (!read.ok) {
      throw new BibleError(
        `${where} brand "${post.brand}"`,
        JSON.stringify(read.errors),
      );
    }
    return read.fields;
  });
  const keys = brands.map((b) => brandKey(b.brand));
  if (new Set(keys).size !== keys.length) {
    throw new BibleError(where, 'a brand is listed twice');
  }
  return brands;
}
