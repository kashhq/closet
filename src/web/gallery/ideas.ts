import type { SQL } from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import { seededRandom } from '../../random';
import {
  generateIdeas,
  type Idea,
  inOutfitOrderByCategory,
} from '../../wardrobe/generator';
import {
  type ActivewearGap,
  activewearGap,
  occasionDemands,
  type Occasion,
} from '../../wardrobe/occasions';
import { FORECAST_DAYS, forecastDay } from '../../weather/forecast';
import { type PickedLocation, zonedIn } from '../../weather/location';
import {
  isActivewearFor,
  matchGarment,
  type WeatherNeeds,
  weatherNeeds,
  withRainGear,
} from '../../weather/match';
import { normalsOn, typicalDay } from '../../weather/normals';
import type { TemperatureUnit } from '../../weather/temperature';
import { addDays, type IsoDate } from '../../calendar-date';
import {
  type CapsuleDetail,
  capsuleNamesSql,
  type CapsuleRef,
  capsuleRefSql,
  findCapsule,
} from '../capsules/queries';
import { capsuleNotFound } from '../capsules/capsule-actions';
import { OUTFIT_NAME_MAX } from '../outfits/queries';
import { categoryLabel } from '../wardrobe/garment';
import { type ScalarValues, selectScalars } from '../../db/select-scalars';
import {
  rainGearFor,
  readWeatherWithForecast,
  type WeatherSettings,
  weatherWithForecastSql,
  type WeatherWithForecast,
  type WeatherWithForecastJson,
} from '../weather/queries';
import {
  type UserWeather,
  userWeatherFrom,
  type WeatherService,
} from '../weather/service';
import {
  type BestOutfits,
  bestOutfits,
  goesWith,
  type GoesWith,
  nearDuplicates,
  type OutfitCount,
  outfitCount,
} from '../../wardrobe/goes-with';
import {
  type ClosetGarment,
  generatorMemorySql,
  type GoesWithInputs,
  goesWithInputs,
  closetKindsSql,
  ideaPoolSql,
  type ManyGoesWithInputs,
  type PoolGarment,
  readGeneratorMemory,
  readPool,
  styledGarment,
  styledGarmentsSql,
  type WishlistGarment,
} from './queries';
import { NotFound } from '../refusals';
import type { Actor } from '../sharing/access';
import { garmentNotFound } from '../wardrobe/garment-access';

/**
 * Ideas for a person, a day and an occasion: the generator
 * (src/wardrobe/generator.ts) fed from the database and the forecast. The
 * one entry point every surface calls, so none grows its own suggestion
 * logic (docs/plans/2026-09-26-redesign.md, section 1): the gallery's Ideas
 * (routes.tsx), the MCP tool suggest_outfits, Today (#15: its occasions, a
 * page of 3) and Styling's Shuffle (#42: its locked rows are `locked`, the
 * first idea fills the rest). Two siblings below draw from another pool:
 * goesWithCloset ("Goes with my closet", #18b: the whole closet with a
 * wishlist item locked, never in a pool, so ideasFor, Today and pickIdea
 * never see one) and browseIdea (Styling's Shuffle over a shared
 * wardrobe). And pickIdea, the one way an idea becomes an outfit.
 */

/** Cards a gallery page holds: one on screen at phone width, the next few ready. */
export const IDEAS_PAGE_SIZE = 6;

/** The last page a gallery goes to (ideasPage): 50 pages of 6 is more than anyone swipes. */
export const MAX_IDEAS_PAGE = 50;

/** Seeds are non-negative 31-bit integers (they travel in URLs). */
export const MAX_SEED = 2_147_483_647;

/** A seed from a URL or a form (navigation state): undefined when it is not one. */
export function parseSeed(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,10}$/.test(value)) return undefined;
  const seed = Number(value);
  return seed <= MAX_SEED ? seed : undefined;
}

/** The seed a gallery opens with: one a day, so the ideas change daily and a reload keeps them. */
export function dailySeed(today: IsoDate): number {
  return Math.floor(seededRandom('gallery-day', today).next() * MAX_SEED);
}

/** "Shuffle": the next seed after `seed`, deterministic like everything else. */
export function shuffledSeed(seed: number): number {
  return Math.floor(seededRandom('gallery-shuffle', seed).next() * MAX_SEED);
}

export interface IdeasInput {
  /** Today in APP_TIMEZONE: how long each garment has rested. */
  today: IsoDate;
  /** The day and occasion dressed for (the weather's window, the formality). */
  day: IsoDate;
  occasion: Occasion;
  /**
   * Where the day's weather is: absent for the person's own (home, or the
   * phone's location while fresh); a trip's located destination (#10); null
   * for a trip whose destination is not located, which has no weather
   * rather than home's.
   */
  place?: PickedLocation | null;
  /** The trip these ideas are for: its packing list's rain gear, not the closet's (rainGearFor). */
  tripId?: number;
  /**
   * The person's own weather, when the caller has read it already (Today
   * reads it with its entries for its line, #158): not read again. Only
   * for the person's own days (`place` absent).
   */
  ownWeather?: UserWeather;
  /** Only this capsule's garments (the owner's own capsule; the route checks). */
  capsuleId?: number;
  /**
   * Also read the owner's capsules for a scope menu (the gallery page's),
   * in the same statement as the pool: IdeasResult.capsules.
   */
  capsuleMenu?: boolean;
  /** In every idea: `?with=`'s garment, Styling's locked rows (styledGarments). */
  locked?: readonly PoolGarment[];
  seed: number;
  offset: number;
  limit: number;
}

/** A gallery's scope, resolved: the capsule it draws from and the garment in every idea. */
export interface IdeasScope {
  capsule: CapsuleDetail | undefined;
  styled: PoolGarment | undefined;
}

/**
 * `?capsule=` and `?with=` (the page, suggest_outfits) as rows: the owner's
 * own capsule, the owner's garment in the closet. Either named and not
 * found is a 404 like an unknown id (outfits are private, so another
 * person's capsule or garment is never one).
 */
export async function ideasScope(
  db: Db,
  ownerId: number,
  asked: { capsuleId?: number; withId?: number; today: IsoDate },
): Promise<IdeasScope> {
  const [capsule, styled] = await Promise.all([
    asked.capsuleId === undefined
      ? undefined
      : findCapsule(db, asked.capsuleId, ownerId),
    asked.withId === undefined
      ? undefined
      : styledGarment(db, ownerId, asked.withId, asked.today),
  ]);
  if (asked.capsuleId !== undefined && !capsule) throw capsuleNotFound();
  if (asked.withId !== undefined && !styled) {
    throw garmentNotFound();
  }
  return { capsule, styled };
}

/** The weather an ideas page was matched to, for its header and the "too warm" buttons. */
export interface IdeasWeather {
  needs: WeatherNeeds;
  unit: TemperatureUnit;
  /** From the destination's climate normals (a trip day past the forecast), not a forecast. */
  typical: boolean;
}

export interface IdeasResult {
  ideas: Idea<PoolGarment>[];
  more: boolean;
  /** Null: no weather service, no location, no forecast for the day. */
  weather: IdeasWeather | null;
  /** The owner's capsules by name, with `capsuleMenu`; else undefined. */
  capsules: CapsuleRef[] | undefined;
  /**
   * Why a workout has no idea, when it is the closet's activewear
   * (activewearGap); undefined otherwise, and whenever there are ideas.
   */
  emptyReason: ActivewearGap | undefined;
}

export async function ideasFor(
  deps: { db: Db; weather: WeatherService | undefined },
  ownerId: number,
  input: IdeasInput,
  now: Date,
): Promise<IdeasResult> {
  const row = await selectScalars(
    deps.db,
    ideasColumns(deps, ownerId, input, now),
  );
  return ideasFrom(deps, ownerId, input, row, now);
}

/**
 * ideasFor's one statement, as selectScalars columns: for a caller that
 * reads its own columns in the same round trip and answers with ideasFrom
 * (Styling, #163: its rows, and the garments it locks, which it only knows
 * from that statement; so `input.locked` may be filled in between, as it
 * is not read here). Its keys (pool, saved, avoid, rules, weather,
 * capsules) are taken: a caller's own columns need other names.
 */
export function ideasColumns(
  deps: { weather: WeatherService | undefined },
  ownerId: number,
  input: IdeasInput,
  now: Date,
) {
  return {
    pool: ideaPoolSql(ownerId, {
      today: input.today,
      capsuleId: input.capsuleId,
    }),
    ...generatorMemorySql(ownerId),
    weather: weatherColumn(deps, ownerId, input, now),
    capsules: input.capsuleMenu ? capsuleNamesSql(ownerId) : undefined,
    // Only an active occasion tells why it is empty (ideasFrom).
    closetKinds: occasionDemands(input.occasion).active
      ? closetKindsSql(ownerId)
      : undefined,
  };
}

/** ideasColumns' row, as selectScalars answers it. */
export type IdeasRow = ScalarValues<ReturnType<typeof ideasColumns>>;

/** ideasFor's answer from its statement's row (ideasColumns). */
export async function ideasFrom(
  deps: { db: Queryable; weather: WeatherService | undefined },
  ownerId: number,
  input: IdeasInput,
  row: IdeasRow,
  now: Date,
): Promise<IdeasResult> {
  const { saved, avoid, rules } = readGeneratorMemory(row);
  const pool = readPool(row.pool);
  const weather = await withClosetRainGear(
    deps.db,
    ownerId,
    await weatherFrom(deps, input, row.weather, now),
    input.tripId,
  );
  const demands = occasionDemands(input.occasion);
  const page = generateIdeas({
    seed: input.seed,
    pool,
    locked: input.locked ?? [],
    needs: weather?.needs ?? null,
    ...demands,
    avoid,
    rules,
    saved,
    offset: input.offset,
    limit: input.limit,
  });
  return {
    ...page,
    weather,
    capsules: row.capsules,
    emptyReason:
      page.ideas.length === 0
        ? activewearGap(
            demands.active,
            (row.closetKinds ?? []).map((kind) => ({
              category: kind.category,
              type: kind.type,
              weather: matchGarment({ ...kind, waterResistant: false }),
            })),
            pool,
            (garment) => isActivewearFor(weather?.needs, garment),
          )
        : undefined,
  };
}

/**
 * The day's needs with the closet's rain gear (rainGearFor, never narrowed
 * by `?capsule=`): what the cards are judged by is what "Take the umbrella"
 * and every other surface read of the same day. One more read only on a day
 * that asks the outfit for water resistance.
 */
async function withClosetRainGear(
  db: Queryable,
  ownerId: number,
  weather: IdeasWeather | null,
  tripId: number | undefined,
): Promise<IdeasWeather | null> {
  if (!weather) return null;
  const gear = await rainGearFor(db, ownerId, [weather.needs], tripId);
  return { ...weather, needs: withRainGear(weather.needs, gear) };
}

/**
 * Page `page` (1-based) of `pageSize` ideas, for the surfaces that page
 * (the Ideas strip, suggest_outfits): ideasFor, with `more` false on
 * MAX_IDEAS_PAGE, the last page they go to, so neither offers a page its
 * own input refuses (the strip's sentinel would fetch page 1 again).
 */
export async function ideasPage(
  deps: { db: Db; weather: WeatherService | undefined },
  ownerId: number,
  input: Omit<IdeasInput, 'offset' | 'limit'> & {
    page: number;
    pageSize: number;
  },
  now: Date,
): Promise<IdeasResult> {
  const { page, pageSize, ...rest } = input;
  const result = await ideasFor(
    deps,
    ownerId,
    { ...rest, offset: (page - 1) * pageSize, limit: pageSize },
    now,
  );
  return { ...result, more: result.more && page < MAX_IDEAS_PAGE };
}

/**
 * Ideas with any of the owner's closet garments in every one (`lockIds`):
 * the API's GET /ideas (#193c), which asks what Styling's Shuffle does (its
 * locked rows) and the gallery's `?with=` (one). ideasFor's one statement,
 * with the capsule's check and the locked garments beside ideasColumns as
 * Styling reads them (ideaReads), judged after it: reading before the
 * check shows nothing, since inCapsule matches no garment of another's
 * capsule. A capsule not the owner's is a 404, and so is a garment not in
 * their closet, as ideasScope refuses them (ideas are private: a share
 * never reaches one).
 */
export async function ideasWith(
  deps: { db: Db; weather: WeatherService | undefined },
  ownerId: number,
  input: Omit<IdeasInput, 'locked' | 'capsuleMenu'> & {
    lockIds: readonly number[];
  },
  now: Date,
): Promise<IdeasResult> {
  const { lockIds, ...ask } = input;
  const wanted = [...new Set(lockIds)];
  const row = await selectScalars(deps.db, {
    ...ideasColumns(deps, ownerId, ask, now),
    capsule:
      ask.capsuleId === undefined
        ? undefined
        : capsuleRefSql(ask.capsuleId, ownerId),
    lockable:
      wanted.length === 0
        ? undefined
        : styledGarmentsSql(ownerId, wanted, ask.today),
  });
  if (ask.capsuleId !== undefined && !row.capsule) throw capsuleNotFound();
  const locked = row.lockable ? readPool(row.lockable) : [];
  if (locked.length !== wanted.length) throw garmentNotFound();
  return ideasFrom(deps, ownerId, { ...ask, locked }, row, now);
}

/** What the aimed day's weather is read for: IdeasInput's day, occasion and place. */
export type WeatherAsk = Pick<
  IdeasInput,
  'today' | 'day' | 'occasion' | 'place' | 'ownWeather'
>;

/**
 * The person's weather row (weatherWithForecastSql) as a statement's
 * column, when weatherFrom could use it (the service on, a day from today
 * on) and the caller has not read it already (`ownWeather`); undefined
 * otherwise. A trip reads it too, for the offset and the unit; one past
 * its forecast without a destination reads it for nothing, a column in a
 * statement it sends anyway. ideasFor's own (ideasColumns), and Styling's
 * fit line (#468b), which judges the rows' outfit against the same day.
 */
export function weatherColumn(
  deps: { weather: WeatherService | undefined },
  ownerId: number,
  ask: WeatherAsk,
  now: Date,
): SQL<WeatherWithForecastJson | null> | undefined {
  const { weather } = deps;
  const reads =
    weather !== undefined &&
    ask.day >= ask.today &&
    ask.ownWeather === undefined;
  return reads
    ? weatherWithForecastSql(ownerId, now, weather.timeZone)
    : undefined;
}

/**
 * The aimed day's weather from weatherColumn's value (undefined when it
 * was not read): what ideasFor matches its ideas to, and what Styling's
 * fit line judges the rows by, so both read one day the same way.
 */
export async function weatherFrom(
  deps: { weather: WeatherService | undefined },
  ask: WeatherAsk,
  column: WeatherWithForecastJson | null | undefined,
  now: Date,
): Promise<IdeasWeather | null> {
  return dayWeather(
    deps,
    ask,
    column === undefined
      ? ask.ownWeather && { settings: ask.ownWeather.settings, forecast: null }
      : readWeatherWithForecast(column, now),
    now,
  );
}

/**
 * What the day's weather asks for the occasion, with the person's offset.
 * The forecast only for days it covers (today to FORECAST_DAYS ahead), so a
 * past day never makes the request wait on Open-Meteo; it is the person's
 * own location's, or `input.place`'s (a trip's destination) through the
 * same cache. Past the forecast, a trip's destination has its typical day
 * (climate normals, src/weather/normals.ts) and nothing else does: the
 * person's own days (the gallery, Today) stay forecast-only. `own` is the
 * person's weather row as ideasFor read it (weatherColumn), or the settings
 * of the caller's `ownWeather`; undefined when no weather applies.
 */
async function dayWeather(
  deps: { weather: WeatherService | undefined },
  input: WeatherAsk,
  own: WeatherWithForecast | undefined,
  now: Date,
): Promise<IdeasWeather | null> {
  const { weather } = deps;
  if (!weather || !own || input.day < input.today) return null;
  if (input.day <= addDays(input.today, FORECAST_DAYS - 1)) {
    return forecastWeather(weather, input, own, now);
  }
  const { place } = input;
  return place ? typicalWeather(weather, input, own.settings, place) : null;
}

/** A day the forecast covers: the person's own location's, or the trip's. */
async function forecastWeather(
  weather: WeatherService,
  input: WeatherAsk,
  own: WeatherWithForecast,
  now: Date,
): Promise<IdeasWeather | null> {
  const { place } = input;
  const { settings, cached } =
    place === undefined
      ? (input.ownWeather ?? (await userWeatherFrom(weather, own, now)))
      : {
          settings: own.settings,
          cached:
            place &&
            (await weather.forecastFor(zonedIn(place, weather.timeZone))),
        };
  const forecast = cached && forecastDay(cached.forecast, input.day);
  // Across the date line the destination's forecast can lack a day home's
  // today counts as covered (#678): it reads the typical day, as the trip's
  // own forecast does, never no weather.
  if (cached && !forecast && place) {
    return typicalWeather(weather, input, settings, place);
  }
  const needs =
    forecast && weatherNeeds(forecast, input.occasion, settings.offset);
  return needs ? { needs, unit: settings.unit, typical: false } : null;
}

/** A trip day past the forecast: the destination's typical day for it. */
async function typicalWeather(
  weather: WeatherService,
  input: WeatherAsk,
  settings: WeatherSettings,
  place: PickedLocation,
): Promise<IdeasWeather | null> {
  const cached = await weather.normalsFor(zonedIn(place, weather.timeZone));
  const normals = cached && normalsOn(cached.normals, input.day);
  const needs =
    normals &&
    weatherNeeds(
      typicalDay(input.day, normals),
      input.occasion,
      settings.offset,
    );
  return needs ? { needs, unit: settings.unit, typical: true } : null;
}

/**
 * Styling's Shuffle over a wardrobe shared with the requester (#42): one
 * idea from the owner's closet with `locked` in it, for nobody's day. Only
 * what the share shows goes in: the closet (closetGarments, so no wash or
 * away state, which are the owner's own records), no rotation (idle days
 * nulled: when a garment was last worn is a wear), and none of the owner's
 * saved outfits, clashes, outfit rules or weather, which are theirs alone. Undefined when
 * nothing fits the locks. Pure: Styling reads the closet
 * (closetGarmentsSql, readCloset) and the locked garments
 * (styledGarmentsSql without a day) in its own statement (#163).
 */
export function browseIdea(input: {
  closet: readonly ClosetGarment[];
  locked: readonly PoolGarment[];
  seed: number;
}): Idea<PoolGarment> | undefined {
  // The closet is never rotated, nor are the locked garments over a share.
  const unworn = (g: PoolGarment): PoolGarment => ({ ...g, idleDays: null });
  const [idea] = generateIdeas<PoolGarment>({
    seed: input.seed,
    pool: input.closet,
    locked: input.locked.map(unworn),
    offset: 0,
    limit: 1,
  }).ideas;
  return idea;
}

/**
 * The name a picked idea is saved with, changeable later: its garments top
 * to toe, by name or else their category ("Olive chore coat, White tee,
 * Raw jeans, Boots"), within the outfit form's cap.
 */
export function ideaName(
  garments: readonly { name: string | null; category: string }[],
): string {
  const name = inOutfitOrderByCategory(garments)
    .map((g) => g.name ?? categoryLabel(g.category))
    .join(', ');
  return name.length <= OUTFIT_NAME_MAX
    ? name
    : `${name.slice(0, OUTFIT_NAME_MAX - 1)}…`;
}

export interface NearDuplicate extends ClosetGarment {
  /** The garment the item is on the wishlist to replace: like for like, not a second one. */
  replaced: boolean;
}

/** "Goes with my closet" for one wishlist item: what the page and goes_with_closet show. */
export interface GoesWithCloset extends GoesWith<ClosetGarment> {
  item: WishlistGarment;
  nearDuplicates: NearDuplicate[];
}

/**
 * "Goes with my closet" (#18b): the actor's wishlist item `itemId` judged
 * against their whole closet (closetGarments: dirty and away included),
 * their avoided pairs and their outfit rules, by the generator with the item locked
 * (src/wardrobe/goes-with.ts says what is judged: no weather, the item's
 * own formality, no rotation), and the closet garments near-identical to
 * it. Not one of the actor's wishlist items is a 404 (#188). The owner's
 * own, like ideas: a grantee who can see the wishlist never gets this, as
 * it reads the owner's closet and clashes. Display only: an
 * outfit with the item cannot be picked (pickIdea takes closet garments),
 * which "Bought it" changes. Seeded by the item's id, so the same closet
 * answers the same. One statement (goesWithInputs) and one search.
 */
export async function goesWithCloset(
  db: Queryable,
  actor: Actor,
  itemId: number,
): Promise<GoesWithCloset> {
  const judged = judgeGoesWithCloset(
    await goesWithInputs(db, actor.userId, itemId),
  );
  if (!judged) throw new NotFound('wishlistItem');
  return judged;
}

/**
 * goesWithCloset's search over inputs already read: a wishlist item's page
 * reads them with its other lists (garmentContext,
 * src/web/wardrobe/garment-context.ts).
 */
export function judgeGoesWithCloset({
  item,
  closet,
  avoid,
  rules,
}: GoesWithInputs): GoesWithCloset | undefined {
  if (!item) return undefined;
  return {
    item,
    ...goesWith({ item, closet, avoid, rules, seed: item.id }),
    nearDuplicates: nearDuplicates(item, closet).map((garment) => ({
      ...garment,
      replaced: garment.id === item.replacesGarmentId,
    })),
  };
}

/**
 * "Unlocks N" for many wishlist items over one closet read
 * (goesWithManyInputsSql): each item's outfitCount, by garment id. The
 * The agent inbox's option thumbs (src/web/wishlist/inbox.ts). One search each,
 * about 3 ms over the demo closet (#333: 120 options in ~360 ms).
 */
export function unlocksOf({
  items,
  closet,
  avoid,
  rules,
}: ManyGoesWithInputs): Map<number, OutfitCount> {
  return new Map(
    items.map((item) => [
      item.id,
      outfitCount({ item, closet, avoid, rules, seed: item.id }),
    ]),
  );
}

/**
 * Each item's count and best few outfits (bestOutfits) over one closet
 * read, by garment id: an agent need's options side by side (C,
 * src/web/wishlist/group-page.tsx). The same search and seed as the item's
 * own page, so the counts agree.
 */
export function bestOutfitsOf({
  items,
  closet,
  avoid,
  rules,
}: ManyGoesWithInputs): Map<number, BestOutfits<ClosetGarment>> {
  return new Map(
    items.map((item) => [
      item.id,
      bestOutfits({ item, closet, avoid, rules, seed: item.id }),
    ]),
  );
}
