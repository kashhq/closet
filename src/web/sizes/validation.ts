import { type Static, Type } from '@sinclair/typebox';
import { brandSpelling } from '../../wardrobe/brands';
import {
  inUnit,
  LENGTH_MAX_CM,
  LENGTH_MIN_CM,
  LENGTH_UNITS,
  lengthText,
  type LengthUnit,
  type Measurement,
  type Measurements,
  MEASUREMENTS,
  toCentimetres,
} from '../../wardrobe/measurements';
import type { FieldErrors } from '../auth/validation';
import { t, type Translated } from '../i18n';
import { normalizeSize } from '../wardrobe/garment';
import { BRAND_MAX, SIZE_MAX } from '../wardrobe/garment-input';

/**
 * The Sizes editor's forms (#24) and their readers, which the seed posts
 * through too. Two layers, as the garment form: TypeBox caps shape and
 * length (a 400 error page; the inputs carry the same maxlength), then the
 * readers re-render the editor 400 with a message per field.
 */

/** A brand note's cap: a line, not an essay. */
export const BRAND_NOTE_MAX = 200;
/** A length as typed: `32.25`; a few characters more are the reader's to refuse. */
export const LENGTH_INPUT_MAX = 8;

const UnitField = Type.Union(LENGTH_UNITS.map((u) => Type.Literal(u)));

export const LengthUnitBody = Type.Object({ unit: UnitField });
export type LengthUnitBody = Static<typeof LengthUnitBody>;

/**
 * The measurements, each as typed, and the unit they were shown in (the
 * form's hidden `unit`, never the preference read at save time: a unit
 * changed in another tab must not turn 32 in into 32 cm).
 */
const LengthField = Type.Optional(Type.String({ maxLength: LENGTH_INPUT_MAX }));

export const MeasurementsBody = Type.Object({
  unit: UnitField,
  ...(Object.fromEntries(MEASUREMENTS.map((m) => [m, LengthField])) as Record<
    Measurement,
    typeof LengthField
  >),
});
export type MeasurementsBody = Static<typeof MeasurementsBody>;

/** A length typed with at most two decimals, a comma or a point. */
const LENGTH = /^\d{1,3}([.,]\d{1,2})?$/;

export type MeasurementsForm =
  | { ok: true; lengths: Measurements }
  | { ok: false; errors: FieldErrors<Measurement> };

/**
 * The posted measurements in cm. A value posted as the form showed it
 * (lengthText of the stored one, in the posted unit) keeps the stored cm,
 * so a Save never moves a length it did not change: 81.28 cm shown as
 * 81.3 would otherwise be stored as 81.3.
 */
export function readMeasurementsForm(
  body: MeasurementsBody,
  stored: Measurements,
): MeasurementsForm {
  const { unit } = body;
  const lengths = {} as Measurements;
  const errors: FieldErrors<Measurement> = {};
  for (const measurement of MEASUREMENTS) {
    const typed = (body[measurement] ?? '').trim();
    const before = stored[measurement];
    if (!typed) {
      lengths[measurement] = null;
    } else if (before !== null && typed === lengthText(before, unit)) {
      lengths[measurement] = before;
    } else {
      const read = readLength(typed, unit);
      if (typeof read === 'number') lengths[measurement] = read;
      else errors[measurement] = [read.message];
    }
  }
  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : { ok: true, lengths };
}

function readLength(
  typed: string,
  unit: LengthUnit,
): number | { message: Translated } {
  if (!LENGTH.test(typed)) return { message: t('sizes.LENGTH_INVALID') };
  const cm = toCentimetres(Number(typed.replace(',', '.')), unit);
  if (cm < LENGTH_MIN_CM || cm > LENGTH_MAX_CM) {
    return {
      message: t('sizes.LENGTH_RANGE', {
        // Rounded up and down into the range, so both ends are allowed.
        min: Math.ceil(inUnit(LENGTH_MIN_CM, unit)),
        max: Math.floor(inUnit(LENGTH_MAX_CM, unit)),
        unit: t(`sizes.unit.${unit}`),
      }),
    };
  }
  return cm;
}

/** The measurements as the form shows them: each in `unit`, '' for none. */
export function measurementsPost(
  lengths: Measurements,
  unit: LengthUnit,
): Record<Measurement, string> {
  return Object.fromEntries(
    MEASUREMENTS.map((m) => {
      const cm = lengths[m];
      return [m, cm === null ? '' : lengthText(cm, unit)];
    }),
  ) as Record<Measurement, string>;
}

export const BrandSizeBody = Type.Object({
  brand: Type.String({ maxLength: BRAND_MAX }),
  size: Type.Optional(Type.String({ maxLength: SIZE_MAX })),
  note: Type.Optional(Type.String({ maxLength: BRAND_NOTE_MAX })),
});
export type BrandSizeBody = Static<typeof BrandSizeBody>;
export type BrandSizeField = keyof BrandSizeBody;

/** A brand's row as stored: the brand's spelling, the size normalized like a garment's. */
export interface BrandSizeFields {
  brand: string;
  size: string | null;
  note: string | null;
}

export type BrandSizeForm =
  | { ok: true; fields: BrandSizeFields }
  | { ok: false; errors: FieldErrors<BrandSizeField> };

export function readBrandSizeForm(body: BrandSizeBody): BrandSizeForm {
  const brand = brandSpelling(body.brand);
  const size = normalizeSize(body.size ?? '') ?? null;
  const note = body.note?.trim() || null;
  const errors: FieldErrors<BrandSizeField> = {};
  if (!brand) errors.brand = [t('sizes.BRAND_REQUIRED')];
  if (!size && !note) errors.size = [t('sizes.SIZE_OR_NOTE')];
  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : { ok: true, fields: { brand, size, note } };
}

// Navigation state for a fragment: a brand too long for the field is a 400
// (the input carries the same maxlength), anything else answers.
export const BrandSizeHintQuery = Type.Object({
  brand: Type.Optional(Type.String({ maxLength: BRAND_MAX })),
});
