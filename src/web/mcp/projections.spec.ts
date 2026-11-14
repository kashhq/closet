import { KindGuard, type TObject, type TSchema } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import { project } from '../api/resource';
import { CalendarEntryResource } from '../calendar/entry-resource';
import { Capsule, CapsuleListItem } from '../capsules/capsule-resource';
import {
  OutfitGarmentResource,
  OutfitListItem,
} from '../outfits/outfit-resource';
import { Trip, TripListItem } from '../trips/trip-resource';
import { Garment, GarmentListItem } from '../wardrobe/garment-resource';
import {
  CALENDAR_ENTRY_FOR_MCP,
  CALENDAR_ENTRY_OUTFIT_FOR_MCP,
} from './tools/calendar';
import { CAPSULE_FOR_MCP, CAPSULE_LIST_ITEM_FOR_MCP } from './tools/capsules';
import { GARMENT_FOR_MCP, GARMENT_SUMMARY_FOR_MCP } from './tools/garments';
import { OUTFIT_FOR_MCP, OUTFIT_GARMENT_FOR_MCP } from './tools/outfits';
import {
  PACKING_FOR_MCP,
  PACKING_GARMENT_FOR_MCP,
  PACKING_GROUP_FOR_MCP,
  TRIP_DAY_FOR_MCP,
  TRIP_FOR_MCP,
  TRIP_LIST_ITEM_FOR_MCP,
  TRIP_OUTFIT_FOR_MCP,
} from './tools/trips';

/*
 * Every MCP projection decides every field of its API resource (#711): the
 * compiler holds a projection to its mapper's record (Projection<T>), and
 * this holds it to the resource's schema, so a field the API gains is
 * either answered to the agent or omitted on purpose, never dropped. And
 * a kept field answers only its schema's keys at every level (a stored
 * row's other columns, a trip's extras, never reach the agent).
 */

const packing = Trip.properties.packing;
const packingGroup = packing.properties.groups.items;

const PROJECTIONS: [string, TObject, Record<string, string>][] = [
  ['Garment', Garment, GARMENT_FOR_MCP],
  ['GarmentListItem', GarmentListItem, GARMENT_SUMMARY_FOR_MCP],
  ['Trip', Trip, TRIP_FOR_MCP],
  ['TripDay', Trip.properties.days.items, TRIP_DAY_FOR_MCP],
  ['TripOutfit', Trip.properties.anyDay.items, TRIP_OUTFIT_FOR_MCP],
  ['Packing', packing, PACKING_FOR_MCP],
  ['PackingGroup', packingGroup, PACKING_GROUP_FOR_MCP],
  [
    'PackingGarment',
    packingGroup.properties.garments.items,
    PACKING_GARMENT_FOR_MCP,
  ],
  ['TripListItem', TripListItem, TRIP_LIST_ITEM_FOR_MCP],
  ['OutfitListItem', OutfitListItem, OUTFIT_FOR_MCP],
  ['OutfitGarment', OutfitGarmentResource, OUTFIT_GARMENT_FOR_MCP],
  ['CalendarEntry', CalendarEntryResource, CALENDAR_ENTRY_FOR_MCP],
  [
    'CalendarEntryOutfit',
    CalendarEntryResource.properties.outfit,
    CALENDAR_ENTRY_OUTFIT_FOR_MCP,
  ],
  ['CapsuleListItem', CapsuleListItem, CAPSULE_LIST_ITEM_FOR_MCP],
  ['Capsule', Capsule, CAPSULE_FOR_MCP],
];

describe('MCP projections', () => {
  it.each(PROJECTIONS)(
    "%s's projection lists exactly the resource's fields",
    (_name, schema, projection) => {
      expect(Object.keys(projection).sort()).toEqual(
        Object.keys(schema.properties).sort(),
      );
    },
  );

  it.each(PROJECTIONS)(
    "%s's kept fields answer only the resource's keys, however deep",
    (_name, schema, projection) => {
      const own = Object.fromEntries(
        Object.entries(projection)
          .filter(([, as]) => as === 'own')
          .map(([field]) => [field, 'own']),
      );
      const answer = project(
        sampleOf(schema) as object,
        schema,
        projection as never,
        own as never,
      );
      expect(JSON.stringify(answer)).not.toContain(INTERNAL);
    },
  );
});

const INTERNAL = 'internal_column';

/** A value of `schema` with every optional field set and, in every object, a column the schema lacks. */
function sampleOf(schema: TSchema): unknown {
  if (KindGuard.IsObject(schema)) {
    return {
      ...Object.fromEntries(
        Object.entries(schema.properties).map(([key, field]) => [
          key,
          sampleOf(field),
        ]),
      ),
      [INTERNAL]: true,
    };
  }
  if (KindGuard.IsArray(schema)) return [sampleOf(schema.items)];
  if (KindGuard.IsUnion(schema)) return sampleOf(schema.anyOf[0]);
  if (KindGuard.IsLiteral(schema)) return schema.const;
  if (KindGuard.IsInteger(schema) || KindGuard.IsNumber(schema)) return 1;
  if (KindGuard.IsBoolean(schema)) return true;
  if (KindGuard.IsString(schema)) return 'text';
  throw new Error(`no sample for ${String(schema.type)}`);
}
