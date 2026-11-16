import { CloneType, type Static, Type } from '@sinclair/typebox';
import { IDEA_PROBLEMS, type Idea } from '../../wardrobe/generator';
import type { IsoDate } from '../../calendar-date';
import { DEFAULT_OCCASION, OCCASIONS } from '../../wardrobe/occasions';
import { categoryRole, GARMENT_ROLES } from '../../wardrobe/properties';
import { needsWaterResistance } from '../../weather/match';
import {
  ListCursor,
  ListLimit,
  ListOf,
  literals,
  withoutNulls,
} from '../api/resource';
import { HttpError } from '../errors';
import { imageUrl } from '../files/image-url';
import { t } from '../i18n';
import { OUTFIT_NAME_MAX } from '../outfits/queries';
import { IsoDateSchema, RowId } from '../schemas';
import { brokenRuleLabels } from '../style/labels';
import {
  dailySeed,
  IDEAS_PAGE_SIZE,
  ideaName,
  type IdeasResult,
  type ideasWith,
  type IdeasWeather,
  MAX_IDEAS_PAGE,
  MAX_SEED,
} from './ideas';
import type { PickResult } from '../outfits/pick';
import { MAX_PICKED, type PickDestination } from './pick';
import type { PoolGarment } from './queries';

/**
 * The API's ideas, picks and clashes (#193c; docs/plans/2026-11-12-json-
 * api.md section 6), mapped from what the Ideas cards and suggest_outfits
 * read (ideasFor). Ideas are the token's user's own: their closet, their
 * capsules, their weather; a share never reaches one.
 */

const Occasion = literals(OCCASIONS);

/**
 * How deep a client may page: the gallery's own (MAX_IDEAS_PAGE of
 * IDEAS_PAGE_SIZE), so no surface asks the generator for more than the
 * strip ever shows.
 */
export const IDEAS_DEPTH = MAX_IDEAS_PAGE * IDEAS_PAGE_SIZE;

/** GET /ideas. */
export const IdeaQuery = Type.Object({
  day: Type.Optional(
    CloneType(IsoDateSchema, {
      description:
        'The day to dress for: today unless given. The weather counts from today to 15 days ahead',
    }),
  ),
  occasion: Type.Optional(
    CloneType(Occasion, { description: 'All day unless given' }),
  ),
  capsuleId: Type.Optional(
    CloneType(RowId, {
      description: 'Only garments of this capsule of yours; another is a 404',
    }),
  ),
  with: Type.Optional(
    Type.Array(RowId, {
      maxItems: MAX_PICKED,
      description:
        'Garments of your closet every idea holds, repeated (`with=3&with=9`): "Style this", or Styling\'s locked rows. One not in your closet is a 404',
    }),
  ),
  seed: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: MAX_SEED,
      description:
        "Which ideas: the day's unless given (the answer says which). The same seed and page are the same ideas; Shuffle is another seed",
    }),
  ),
  // Its note (resend the rest) is the route's: CloneType keeps ListCursor's own description.
  cursor: Type.Optional(ListCursor),
  limit: ListLimit(IDEAS_PAGE_SIZE),
});

export const IdeaGarment = Type.Object(
  {
    id: Type.Integer(),
    name: Type.Optional(Type.String()),
    category: Type.String(),
    role: literals(GARMENT_ROLES),
    thumbUrl: Type.Optional(
      Type.String({
        description:
          'Signed, relative, immutable: from the cutout when it shows',
      }),
    ),
    daysUnworn: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: 'Days since it was last worn; absent when never',
      }),
    ),
  },
  { title: 'IdeaGarment' },
);

export const IdeaResource = Type.Object(
  {
    name: Type.String({
      description: 'Its garments named top to toe: the name a pick saves',
    }),
    garments: Type.Array(IdeaGarment, { description: 'Top to toe' }),
    fits: Type.Boolean({
      description: 'No problem: it meets the weather and the occasion',
    }),
    problems: Type.Array(literals(IDEA_PROBLEMS), {
      description:
        'What is off, the weather against its warmth and the occasion against its formality; `breaks-rule` when the garments sent in `with` break one of your outfit rules between them',
    }),
    brokenRules: Type.Array(Type.String(), {
      description: "Each outfit rule it breaks, in the app's words",
    }),
    rested: Type.Array(Type.Integer(), {
      description:
        'Its garments unworn the longest, which the rotation brought back',
    }),
  },
  {
    title: 'Idea',
    description:
      'A whole outfit from your closet: clean, at home, at most two colours beyond the neutrals and one pattern, never a pair you said clashes nor one of your saved outfits',
  },
);
type IdeaResource = Static<typeof IdeaResource>;

export const IdeaWeather = Type.Object(
  {
    feelsLikeC: Type.Object(
      { min: Type.Number(), max: Type.Number() },
      {
        title: 'IdeaFeelsLike',
        description:
          "The occasion's hours, °C, your temperature offset included",
      },
    ),
    needsLayer: Type.Boolean(),
    needsWaterResistance: Type.Boolean({
      description:
        'Rain the umbrella does not answer: each idea is judged on a water-resistant layer, footwear or accessory',
    }),
    takeUmbrella: Type.Boolean({
      description:
        'Rain is likely and is answered beside the outfit: every rain hour is warm (feels-like above 22 °C), or the closet holds a water-resistant hat or cap. Advice for the day, no idea is judged on it; false when there is no rain',
    }),
    typical: Type.Boolean({
      description: "A typical day's, not a forecast",
    }),
  },
  {
    title: 'IdeaWeather',
    description:
      'The weather the ideas were matched to. Absent: no forecast that day (weather off, no location, a past day or one past the forecast)',
  },
);

export const IdeaList = ListOf(IdeaResource, {
  title: 'IdeaList',
  description:
    'Ideas for a day and an occasion, those that fit first, then the near misses best first. Seeded, never stored: the same seed and page are the same ideas, and page 1 never changes when page 3 is read',
  extra: {
    day: IsoDateSchema,
    occasion: Occasion,
    seed: Type.Integer({ description: 'The seed these ideas were drawn by' }),
    weather: Type.Optional(IdeaWeather),
    emptyReason: Type.Optional(
      Type.Union(
        [Type.Literal('no-activewear'), Type.Literal('none-available')],
        {
          description:
            "Present only when there are no ideas and the occasion is dressed for moving (a workout), which takes running shoes and athletic bottoms: 'no-activewear' when the closet has none (set garment types), 'none-available' when it has but none is clean and at home that day",
        },
      ),
    ),
  },
});

const round1 = (value: number) => Math.round(value * 10) / 10;

export function toIdeaWeather(
  weather: IdeasWeather,
): Static<typeof IdeaWeather> {
  const { needs, typical } = weather;
  return {
    feelsLikeC: {
      min: round1(needs.feelsLike.min),
      max: round1(needs.feelsLike.max),
    },
    needsLayer: needs.layer,
    needsWaterResistance: needsWaterResistance(needs),
    takeUmbrella: needs.umbrella,
    typical,
  };
}

export function toIdeaGarment(garment: PoolGarment) {
  return withoutNulls({
    id: garment.id,
    name: garment.name,
    category: garment.category,
    role: categoryRole(garment.category),
    thumbUrl: garment.photo && imageUrl(garment.photo, 'thumb'),
    daysUnworn: garment.idleDays,
  });
}

export function toIdeaResource(idea: Idea<PoolGarment>): IdeaResource {
  return {
    name: ideaName(idea.garments),
    garments: idea.garments.map(toIdeaGarment),
    // As the Ideas card: a flagged idea (breaks-rule) does not fit.
    fits: idea.problems.length === 0,
    problems: idea.problems,
    brokenRules: brokenRuleLabels(idea),
    rested: idea.rested,
  };
}

/**
 * The ideas' cursor: the seed and how many ideas came before, base64url
 * like every cursor (opaque to a client). The seed rides in it so a page
 * read after midnight continues the day's ideas it started from.
 */
const IDEAS_CURSOR = /^ideas:(\d{1,10}):(\d{1,4})$/;

export interface IdeasPosition {
  seed: number;
  offset: number;
}

export function ideasCursor({ seed, offset }: IdeasPosition): string {
  return Buffer.from(`ideas:${seed}:${offset}`).toString('base64url');
}

/** The position an ideasCursor names; any other string is a 400 `validation`. */
function readIdeasCursor(cursor: string): IdeasPosition {
  const match = IDEAS_CURSOR.exec(Buffer.from(cursor, 'base64url').toString());
  const seed = match ? Number(match[1]) : -1;
  const offset = match ? Number(match[2]) : -1;
  if (seed < 0 || seed > MAX_SEED || offset < 1 || offset >= IDEAS_DEPTH) {
    throw new HttpError(400, t('api.BAD_CURSOR'));
  }
  return { seed, offset };
}

/** What GET /ideas asks of ideasWith: the query with its defaults, at the cursor's position. */
export type AskedIdeas = Parameters<typeof ideasWith>[2];

export function askedIdeas(
  query: Static<typeof IdeaQuery>,
  today: IsoDate,
): AskedIdeas {
  const position = query.cursor
    ? readIdeasCursor(query.cursor)
    : { seed: query.seed ?? dailySeed(today), offset: 0 };
  return {
    today,
    day: query.day ?? today,
    occasion: query.occasion ?? DEFAULT_OCCASION,
    capsuleId: query.capsuleId,
    lockIds: query.with ?? [],
    ...position,
    // Never past the gallery's depth.
    limit: Math.min(
      query.limit ?? IDEAS_PAGE_SIZE,
      IDEAS_DEPTH - position.offset,
    ),
  };
}

export function toIdeaList(
  asked: AskedIdeas,
  result: IdeasResult,
): Static<typeof IdeaList> {
  const next = asked.offset + asked.limit;
  const more = result.more && next < IDEAS_DEPTH;
  return {
    data: result.ideas.map(toIdeaResource),
    pagination: {
      ...(more && {
        nextCursor: ideasCursor({ seed: asked.seed, offset: next }),
      }),
      limit: asked.limit,
    },
    day: asked.day,
    occasion: asked.occasion,
    seed: asked.seed,
    ...(result.weather && { weather: toIdeaWeather(result.weather) }),
    ...(result.emptyReason && { emptyReason: result.emptyReason }),
  };
}

/** GET /ideas' debug line: what was asked and how many came back. */
export function ideasNote(asked: AskedIdeas, result: IdeasResult): string {
  const scope = [
    `seed ${asked.seed}`,
    `${asked.day} ${asked.occasion}`,
    ...(asked.capsuleId ? [`capsule ${asked.capsuleId}`] : []),
    ...(asked.lockIds.length > 0
      ? [`with garments ${asked.lockIds.join(', ')}`]
      : []),
    ...(result.weather ? ['weather'] : []),
  ];
  return `${result.ideas.length} from ${asked.offset} (${scope.join(', ')})`;
}

/** POST /outfit-picks. */
export const OutfitPickInput = Type.Object(
  {
    garmentIds: Type.Array(RowId, {
      minItems: 1,
      maxItems: MAX_PICKED,
      description:
        "An idea's garments, of your closet. One not in your closet refuses the pick, nothing written: a 404 when any is not yours, else a 409 naming those archived or not bought yet",
    }),
    name: Type.Optional(
      Type.String({
        maxLength: OUTFIT_NAME_MAX,
        description:
          "A new outfit's name: the idea's (its garments) unless sent",
      }),
    ),
    plan: Type.Optional(
      Type.Object(
        {
          day: IsoDateSchema,
          occasion: Type.Optional(
            CloneType(Occasion, { description: 'All day unless given' }),
          ),
        },
        {
          title: 'OutfitPickPlan',
          description:
            'Also plans it on a day (once: a day holds an outfit once)',
        },
      ),
    ),
    clientId: Type.Optional(
      Type.String({
        format: 'uuid',
        description:
          'Your id for this pick, for retrying it offline: accepted, not yet stored (the same garments are the same outfit anyway)',
      }),
    ),
  },
  {
    title: 'OutfitPick',
    description:
      "An idea's garments saved as an outfit, and planned on a day when asked. To put them in a calendar entry's place, PUT /calendar-entries/{id}/outfit with them; on a trip, POST /trips/{id}/outfits",
  },
);

const SCHEDULE_OUTCOMES = ['scheduled', 'already-scheduled'] as const;

export const OutfitPicked = Type.Object(
  {
    id: Type.Integer({ description: 'The outfit' }),
    alreadySaved: Type.Boolean({
      description:
        'The garments were an outfit of yours already: it is the answer, nothing was created (a retry)',
    }),
    schedule: Type.Optional(
      CloneType(literals(SCHEDULE_OUTCOMES), {
        description: 'With `plan`: planned now, or on that day already',
      }),
    ),
    adopted: Type.Optional(
      Type.Boolean({
        description:
          "Plan my week's outfit or entry, which this pick made yours: out of the re-plan's and Undo's reach",
      }),
    ),
  },
  { title: 'OutfitPicked' },
);

/** PUT and DELETE /garments/{id}/clashes/{otherId}: the pair, in either order. */
export const ClashParams = Type.Object({
  id: RowId,
  otherId: CloneType(RowId, {
    description: 'Another garment of yours (the pair is the same either way)',
  }),
});

export const ClashSet = Type.Object(
  {
    changed: Type.Boolean({
      description: 'False: the pair was avoided already (a retry)',
    }),
  },
  { title: 'GarmentClash' },
);

/** Where a pick goes: planned on a day, or only saved. */
export function pickDestinationOf(
  input: Static<typeof OutfitPickInput>,
): PickDestination {
  const { plan } = input;
  return plan
    ? {
        kind: 'day',
        day: plan.day,
        occasion: plan.occasion ?? DEFAULT_OCCASION,
      }
    : { kind: 'none' };
}

export function toOutfitPicked(
  outfit: PickResult,
): Static<typeof OutfitPicked> {
  return {
    id: outfit.id,
    alreadySaved: outfit.alreadySaved,
    schedule: outfit.schedule,
    ...(outfit.adopted && { adopted: true }),
  };
}
