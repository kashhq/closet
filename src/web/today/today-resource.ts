import { CloneType, type Static, Type } from '@sinclair/typebox';
import { agentNameOf } from '../write-origin';
import { DEFAULT_OCCASION, OCCASIONS } from '../../wardrobe/occasions';
import type { MatchGarment } from '../../weather/match';
import { literals, withoutNulls } from '../api/resource';
import {
  CalendarEntryResource,
  toCalendarEntryResource,
} from '../calendar/entry-resource';
import { dailySeed } from '../gallery/ideas';
import {
  ideasCursor,
  IdeaResource,
  IdeaWeather,
  toIdeaResource,
  toIdeaWeather,
} from '../gallery/idea-resource';
import { IsoDateSchema } from '../schemas';
import {
  toWeatherResource,
  WeatherResource,
} from '../weather/weather-resource';
import type { NeedsToDecide } from '../wishlist/inbox';
import type { AgentRound } from '../wishlist/rounds';
import { TODAY_IDEAS, type TodayModel } from './today';

/**
 * GET /api/v1/today (#195a): the home screen as data, mapped from the
 * model the page renders (todayFor), so a native client and the page never
 * disagree about what is planned or suggested.
 */

const TodayRow = Type.Object(
  {
    kind: literals(['planned', 'ideas'] as const),
    occasion: literals(OCCASIONS),
    entries: Type.Optional(
      Type.Array(CalendarEntryResource, {
        description: "`planned`: the occasion's entries today",
      }),
    ),
    ideas: Type.Optional(
      Type.Array(IdeaResource, {
        description: `\`ideas\`: a page of ${TODAY_IDEAS} for today, the day's seed (Wear this: POST /outfit-wears)`,
      }),
    ),
    weather: Type.Optional(IdeaWeather),
    nextCursor: Type.Optional(
      Type.String({
        description: `\`ideas\`: Refresh, the next ${TODAY_IDEAS}: GET /ideas?limit=${TODAY_IDEAS}&cursor=<this>; absent after the last`,
      }),
    ),
  },
  {
    title: 'TodayRow',
    description:
      'A part of the day: what is planned for an occasion, or (while nothing that dresses the day is planned) an all-day row of ideas, first',
  },
);
type TodayRow = Static<typeof TodayRow>;

const TodayAgent = Type.Object(
  {
    kind: CloneType(literals(['round', 'needs'] as const), {
      description:
        '`round`: the agent’s latest round while any of it waits; `needs`: else its needs with an option to choose (GET /wishlist)',
    }),
    agent: Type.Optional(
      Type.String({ description: 'The agent’s token name; absent once gone' }),
    ),
    roundId: Type.Optional(Type.Integer()),
    summary: Type.Optional(Type.String()),
    outfits: Type.Optional(
      Type.Integer({ minimum: 0, description: 'Its outfits not decided yet' }),
    ),
    pieces: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: 'Its options of needs still open (GET /wishlist)',
      }),
    ),
    needs: Type.Optional(
      Type.Integer({ minimum: 1, description: 'Needs waiting on your choice' }),
    ),
  },
  {
    title: 'TodayAgent',
    description:
      "Today's one agent card, counted live: it shrinks as you decide and goes at zero",
  },
);

export const TodayResource = Type.Object(
  {
    today: IsoDateSchema,
    weather: Type.Optional(WeatherResource),
    agent: Type.Optional(TodayAgent),
    rows: Type.Array(TodayRow),
  },
  {
    title: 'Today',
    description:
      "The home screen: the household's day, your weather today (its `days` today's alone; absent with the weather off), the agent’s card while one waits, and a row per part of the day",
  },
);
type TodayResource = Static<typeof TodayResource>;

function toAgent(
  round: AgentRound | null | undefined,
  needs: NeedsToDecide | null | undefined,
): Static<typeof TodayAgent> | undefined {
  // The page's AgentCard: the waiting round's, else the needs'.
  if (round) {
    return {
      kind: 'round',
      roundId: round.id,
      outfits: round.outfits,
      pieces: round.pieces,
      ...withoutNulls({
        agent: agentNameOf(round.agent),
        summary: round.summary,
      }),
    };
  }
  if (needs) {
    return {
      kind: 'needs',
      needs: needs.count,
      ...withoutNulls({ agent: agentNameOf(needs.agent) }),
    };
  }
  return undefined;
}

function toTodayRow(row: TodayModel['rows'][number], model: TodayModel) {
  if (row.kind === 'planned') {
    return {
      kind: row.kind,
      occasion: row.occasion,
      entries: row.entries.map(toCalendarEntryResource),
    } satisfies TodayRow;
  }
  return {
    kind: row.kind,
    occasion: row.occasion,
    ideas: row.ideas.map(toIdeaResource),
    ...(row.weather && { weather: toIdeaWeather(row.weather) }),
    // todayIdeas' next page, as GET /ideas' cursor reads it (seed, offset).
    ...(row.nextPage > row.page && {
      nextCursor: ideasCursor({
        seed: dailySeed(model.today),
        offset: (row.nextPage - 1) * TODAY_IDEAS,
      }),
    }),
  } satisfies TodayRow;
}

export function toTodayResource(
  model: TodayModel,
  rainGear: readonly MatchGarment[],
): TodayResource {
  const agent = toAgent(model.round, model.needs);
  return {
    today: model.today,
    ...(model.weather && {
      weather: toWeatherResource(
        model.weather,
        [model.today],
        DEFAULT_OCCASION,
        rainGear,
      ),
    }),
    ...(agent && { agent }),
    rows: model.rows.map((row) => toTodayRow(row, model)),
  };
}
