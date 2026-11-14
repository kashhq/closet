import { type Static, Type } from '@sinclair/typebox';
import { OutfitListQuery } from '../outfits/outfit-list';
import { OutfitCursor } from '../outfits/schemas';
import type { FieldErrors } from '../auth/validation';
import { daysBetween, parseIsoDate } from '../../calendar-date';
import { checklistBody } from '../checklist';
import { t } from '../i18n';
import {
  LocationBody,
  type PickedPlace,
  PlaceBody,
  pickedPlace,
} from '../weather/place-picker';
import { OccasionSchema, RowId } from '../schemas';
import type { TripFields } from './queries';

/**
 * The trip routes' input (#10). Trips are the owner's own, like outfits: no
 * route takes `?ownerId=` (who may reach a trip is trip-actions.ts's). The
 * trip form is two layers, as the capsule and plan forms: TypeBox caps
 * shape and length (a 400 page; the inputs carry the same maxlength), then
 * readTripForm re-renders the form with a message for what a person can
 * get wrong (a blank name, a missing or backward date, a trip longer
 * than MAX_TRIP_DAYS). The other writes post ids and values the pages
 * built, so anything malformed is a 400.
 */

export const TRIP_NAME_MAX = 80;
/** The weather's place names are this long at most (PLACE_NAME_MAX). */
export const TRIP_DESTINATION_MAX = 200;
export const TRIP_NOTES_MAX = 2000;
export const TRIP_ITEM_MAX = 80;
/** The longest trip: a packing list for more is a move, not a trip. */
const MAX_TRIP_DAYS = 60;
/** Ids one checklist post may carry: more than any trip holds. */
const MAX_IDS = 500;

export const TripParams = Type.Object({ id: RowId });

export const TripOutfitParams = Type.Object({
  id: RowId,
  tripOutfitId: RowId,
});

export const TripItemParams = Type.Object({ id: RowId, itemId: RowId });

// Dates arrive as the date inputs' strings: readTripForm judges them, so a
// blank one is a message on the form, not an error page.
const tripBodyFields = {
  name: Type.String({ maxLength: TRIP_NAME_MAX }),
  destination: Type.Optional(Type.String({ maxLength: TRIP_DESTINATION_MAX })),
  startsOn: Type.String({ maxLength: 10 }),
  endsOn: Type.String({ maxLength: 10 }),
  notes: Type.Optional(Type.String({ maxLength: TRIP_NOTES_MAX })),
};
export const TripBody = Type.Object(tripBodyFields);
export type TripBody = Static<typeof TripBody>;

/**
 * POST /trips: the form and, when its picker chose one (#684), the place's
 * coordinates and zone (PlaceBody's) beside the destination, which is the
 * place's name then. All or none: a partial place is a 400.
 */
export const NewTripBody = Type.Object(
  {
    ...tripBodyFields,
    latitude: Type.Optional(LocationBody.properties.latitude),
    longitude: Type.Optional(LocationBody.properties.longitude),
    timeZone: PlaceBody.properties.timeZone,
  },
  {
    // A place needs its name: a blank destination beside coordinates is refused.
    dependencies: {
      latitude: {
        required: ['destination', 'longitude'],
        properties: { destination: { pattern: '\\S' } },
      },
      longitude: ['latitude'],
      timeZone: ['latitude'],
    },
  },
);
export type NewTripBody = Static<typeof NewTripBody>;

/** The new-trip form's Find: its destination field, as typed (routes.tsx judges the length). */
export const NewTripPlacesQuery = Type.Object({
  destination: Type.String({ maxLength: TRIP_DESTINATION_MAX }),
});

/** The picker's Change: back to the text, the picked name in it. */
export const NewTripDestinationQuery = Type.Object({
  destination: Type.Optional(Type.String({ maxLength: TRIP_DESTINATION_MAX })),
});

/** The place the new-trip form's picker chose, or null (an unlocated trip: the trip page offers Find). */
export function formPlace(body: NewTripBody): PickedPlace | null {
  const { destination, latitude, longitude, timeZone } = body;
  // NewTripBody's dependencies send all three or none.
  if (destination === undefined || latitude === undefined) return null;
  if (longitude === undefined) return null;
  return pickedPlace({ name: destination, latitude, longitude, timeZone });
}

export type TripField = 'name' | 'startsOn' | 'endsOn';

export type TripForm =
  | { ok: true; fields: TripFields }
  | { ok: false; values: TripBody; errors: FieldErrors<TripField> };

/**
 * The form as stored: trimmed, blank destination and notes null; a blank
 * name, a missing date, an end before the start or a trip past
 * MAX_TRIP_DAYS are refused with their message.
 */
export function readTripForm(body: TripBody): TripForm {
  const name = body.name.trim();
  const { startsOn, endsOn, errors } = readDates(body);
  if (!name) errors.name = [t('trips.NAME_REQUIRED')];
  if (!startsOn || !endsOn || Object.keys(errors).length > 0) {
    return { ok: false, values: body, errors };
  }
  return {
    ok: true,
    fields: {
      name,
      destination: body.destination?.trim() || null,
      startsOn,
      endsOn,
      notes: body.notes?.trim() || null,
    },
  };
}

/** The first and last day, and what is wrong with them. */
function readDates(body: TripBody): {
  startsOn: string | undefined;
  endsOn: string | undefined;
  errors: FieldErrors<TripField>;
} {
  const startsOn = parseIsoDate(body.startsOn);
  const endsOn = parseIsoDate(body.endsOn);
  const errors: FieldErrors<TripField> = {};
  if (!startsOn) errors.startsOn = [t('trips.DATE_REQUIRED')];
  if (!endsOn) errors.endsOn = [t('trips.DATE_REQUIRED')];
  if (startsOn && endsOn) {
    const days = daysBetween(startsOn, endsOn) + 1;
    if (days < 1) errors.endsOn = [t('trips.ENDS_BEFORE_START')];
    else if (days > MAX_TRIP_DAYS) {
      errors.endsOn = [t('trips.TOO_LONG', { days: MAX_TRIP_DAYS })];
    }
  }
  return { startsOn, endsOn, errors };
}

/**
 * POST /trips/:id/outfits (the add page's saved outfits): the outfit and,
 * optionally, the trip day and occasion it is for ('' for none: the page's
 * "Any day"). A day outside the trip is refused by planTripOutfit (400).
 */
export const AddOutfitBody = Type.Object({
  outfitId: RowId,
  day: Type.Optional(
    Type.Union([Type.Literal(''), Type.String({ format: 'date' })]),
  ),
  occasion: Type.Optional(Type.Union([Type.Literal(''), OccasionSchema])),
});

/** `?day=&occasion=` on the add page: navigation state, lenient. */
export const AddOutfitQuery = Type.Object({
  day: Type.Optional(Type.String()),
  occasion: Type.Optional(Type.String()),
  ...OutfitListQuery,
});

/** The add page's next page of saved outfits (#660): its query and the keyset cursor its sentinel names. */
export const AddOutfitMoreQuery = Type.Object({
  ...AddOutfitQuery.properties,
  before: OutfitCursor,
});

/**
 * A checklist's autosave (the packing list, the extras): the checked ids
 * and every id it showed. Shown and unchecked is unpacked; ids it never
 * showed (a garment added meanwhile) are left alone: src/web/checklist.tsx.
 */
export const ChecklistBody = checklistBody('packed', MAX_IDS);

export const ItemBody = Type.Object({
  label: Type.String({ minLength: 1, maxLength: TRIP_ITEM_MAX }),
});

export const CopyItemsBody = Type.Object({ from: RowId });

/** The trip page's one-shot flags: after a create, a gallery pick and a copy of extras. */
export const TripPageQuery = Type.Object({
  created: Type.Optional(Type.String({ maxLength: 5 })),
  picked: Type.Optional(Type.String({ maxLength: 5 })),
  copied: Type.Optional(Type.Integer({ minimum: 0 })),
});
