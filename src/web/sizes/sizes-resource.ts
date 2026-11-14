import { CloneType, type Static, type TSchema, Type } from '@sinclair/typebox';
import {
  LENGTH_MAX_CM,
  LENGTH_MIN_CM,
  LENGTH_UNITS,
  type Measurement,
  type Measurements,
  MEASUREMENTS,
} from '../../wardrobe/measurements';
import { literals, Nullable, withoutNulls } from '../api/resource';
import { BRAND_MAX } from '../wardrobe/garment-input';
import type { BrandSize, BodyMeasurements } from './queries';
import { BrandSizeBody, type BrandSizeField } from './validation';

/**
 * Sizes on /api/v1 (#588): the measurements and brand notes as data, in
 * centimetres whatever the unit (the unit is how a person reads them, as
 * on the page), and the editor's form bodies as JSON.
 */

const Unit = CloneType(literals(LENGTH_UNITS), {
  description:
    'How you read and type lengths; every length here stays centimetres',
});

const lengthCm = (measurement: Measurement) =>
  Type.Number({
    minimum: LENGTH_MIN_CM,
    maximum: LENGTH_MAX_CM,
    description: `Your ${measurement}, in centimetres (two decimals kept)`,
  });

/** One field per measurement, each `field(measurement)`. */
function lengthFields<T extends TSchema>(
  field: (measurement: Measurement) => T,
): Record<Measurement, T> {
  return Object.fromEntries(MEASUREMENTS.map((m) => [m, field(m)])) as Record<
    Measurement,
    T
  >;
}

export const MeasurementsResource = Type.Object(
  lengthFields((m) => Type.Optional(lengthCm(m))),
  {
    title: 'Measurements',
    description:
      'Each body measurement you set, in centimetres; absent: not set',
  },
);
type MeasurementsResource = Static<typeof MeasurementsResource>;

/** The measurements, replaced whole as the page's form saves them. */
export const MeasurementsInput = Type.Object(
  lengthFields((m) => Nullable(lengthCm(m))),
  {
    title: 'MeasurementsInput',
    description:
      'Every measurement, in centimetres, replaced whole: one absent or null is cleared',
  },
);

export const UnitInput = Type.Object({ unit: Unit }, { title: 'LengthUnit' });

export const BrandSizeResource = Type.Object(
  {
    id: Type.Integer(),
    brand: Type.String({ description: 'The brand as you spelled it' }),
    size: Type.Optional(
      Type.String({ description: 'The size you wear in it' }),
    ),
    note: Type.Optional(
      Type.String({ description: 'How it runs ("runs small, size up")' }),
    ),
  },
  {
    title: 'BrandSize',
    description: 'Your size in a brand: a size, a note, or both',
  },
);
type BrandSizeResource = Static<typeof BrandSizeResource>;

export const BrandSizeInput = CloneType(BrandSizeBody, {
  title: 'BrandSizeInput',
  description:
    'A brand note, replaced whole: the brand (one row per brand, whatever the case) and a size or a note, at least one; a size is normalized like a garment’s (XL is X-Large)',
});

export const NewBrandSize = Type.Composite(
  [
    BrandSizeInput,
    Type.Object({
      clientId: Type.Optional(
        Type.String({
          format: 'uuid',
          description:
            'Your id for this create, for retrying it offline: a retry answers the first note of that id (200), the id of one deleted since is a 410',
        }),
      ),
    }),
  ],
  { title: 'NewBrandSize', description: BrandSizeInput.description },
);

/** Where each brand field sits in the body, for a refusal's `errors`. */
export const POINTER_OF_BRAND_FIELD: Record<BrandSizeField, string> = {
  brand: '/brand',
  size: '/size',
  note: '/note',
};

export const SizesResource = Type.Object(
  {
    unit: Unit,
    measurements: MeasurementsResource,
    brands: Type.Array(BrandSizeResource, {
      description: 'By brand, whatever the case',
    }),
  },
  {
    title: 'Sizes',
    description:
      'Your own body measurements and brand notes, for choosing a size; never anyone else’s, and never shown on a shared wardrobe',
  },
);
type SizesResource = Static<typeof SizesResource>;

/**
 * The changes feed's measurements (#196b-2, GET /changes): the one row a
 * user has once they save any, the `id` of its change the user's. Nothing
 * dropped; a brand note is its own resource (`BrandSize` as GET answers it).
 */
export const SyncedMeasurements = Type.Object(
  { unit: Unit, measurements: MeasurementsResource },
  {
    title: 'SyncedMeasurements',
    description:
      'Your body measurements and how you read them: never anyone else’s',
  },
);

export function toSyncedMeasurements({
  unit,
  lengths,
}: BodyMeasurements): Static<typeof SyncedMeasurements> {
  return { unit, measurements: toMeasurementsResource(lengths) };
}

export const BrandSizeQuery = Type.Object({
  brand: Type.Optional(
    Type.String({
      maxLength: BRAND_MAX,
      description:
        'Only this brand’s note, matched whatever the case and spacing ("UNIQLO" is Uniqlo); every note unless given',
    }),
  ),
});

export function toMeasurementsResource(
  lengths: Measurements,
): MeasurementsResource {
  return withoutNulls(lengths);
}

export function toBrandSizeResource(row: BrandSize): BrandSizeResource {
  return withoutNulls(row);
}

export function toSizesResource(
  { unit, lengths }: BodyMeasurements,
  brands: readonly BrandSize[],
): SizesResource {
  return {
    unit,
    measurements: toMeasurementsResource(lengths),
    brands: brands.map(toBrandSizeResource),
  };
}

/**
 * The lengths a body sends, as stored: body_measurements keeps two
 * decimals (numeric(5, 2)), so the answer is what was kept.
 */
export function postedLengths(
  body: Static<typeof MeasurementsInput>,
): Measurements {
  return Object.fromEntries(
    MEASUREMENTS.map((m) => {
      const cm = body[m];
      return [m, cm == null ? null : Math.round(cm * 100) / 100];
    }),
  ) as Measurements;
}
