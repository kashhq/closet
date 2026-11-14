import { CloneType, type Static, Type } from '@sinclair/typebox';
import { DAY_OCCASIONS } from '../../wardrobe/occasions';
import {
  AROUND_OCCASIONS,
  type TemplateSlot,
  templateDays,
  WEEKDAYS,
} from '../../wardrobe/week';
import { literals, withoutNulls } from '../api/resource';

/**
 * The week template as /api/v1 answers it: GET and PUT /week-template
 * (api-routes.ts) and the changes feed's `weekTemplate` (#716,
 * src/web/sync/feed.ts), the same shape: nothing in it is derived.
 */

const TemplateDayResource = Type.Object(
  {
    weekday: CloneType(literals(WEEKDAYS), {
      description: '0 is Sunday … 6 Saturday',
    }),
    day: Type.Optional(
      CloneType(literals(DAY_OCCASIONS), {
        description:
          "The day's outfit: at most one of all day, work, daytime; absent, none",
      }),
    ),
    around: Type.Array(literals(AROUND_OCCASIONS), {
      description:
        'The occasions around it (a workout, an evening, a night out)',
    }),
  },
  { title: 'WeekTemplateDay' },
);

export const WeekTemplate = Type.Object(
  { days: Type.Array(TemplateDayResource, { minItems: 7, maxItems: 7 }) },
  {
    title: 'WeekTemplate',
    description:
      'Your week, Sunday first: the slots Plan my week fills. Empty on every day until you set it',
  },
);

/** A template's slots as the resource: every weekday, empty ones too. */
export function toWeekTemplate(
  slots: readonly TemplateSlot[],
): Static<typeof WeekTemplate> {
  return {
    days: templateDays(slots).map(({ weekday, day, around }) =>
      withoutNulls({ weekday, day, around }),
    ),
  };
}
