import type {
  CareBleach,
  CareDry,
  CareDryClean,
  CareIron,
  CareWash,
} from '../../wardrobe/care';
import {
  type Condition,
  type Fit,
  type Formality,
  type GarmentColor,
  type GarmentProperty,
  type Length,
  type Material,
  type Pattern,
  propertyApplies,
  type Sleeve,
  type Warmth,
} from '../../wardrobe/properties';
import type { FieldErrors } from '../auth/validation';
import { normalizeCategory } from './garment';
import {
  type FormAudience,
  formPost,
  type GarmentField,
  type GarmentFields,
  type GarmentForm,
  type GarmentFormValues,
  orEmpty,
  type PropertyFormValues,
  readGarmentForm,
  storedFormValues,
  withCarePresets,
  withPresets,
} from './garment-input';
import { checkedType } from './garment-search';
import type { GarmentDetail } from './queries';
import { withPrivateFields } from './private-fields';

/**
 * A garment's changes as a caller without a form names them (#192b): MCP's
 * update_garment and the API's writes (PATCH /garments/{id}, POST /garments
 * and its clones). Each becomes the garment form's own post over a base
 * (the stored garment's edit form, or a new one's) and goes through
 * readGarmentForm, so every surface saves by the form's rules: presets,
 * the role's properties, the owner-only wash limit. Absent leaves a value
 * as the base has it, null clears it (a category never: a blank one is the
 * form's refusal).
 */

export interface PropertyChanges {
  type?: string | null;
  warmth?: Warmth | null;
  formality?: Formality | null;
  materials?: Material[] | null;
  pattern?: Pattern | null;
  fit?: Fit | null;
  sleeve?: Sleeve | null;
  length?: Length | null;
  fabricWeightGsm?: number | null;
  waterResistant?: boolean;
  careWash?: CareWash | null;
  careBleach?: CareBleach | null;
  careDry?: CareDry | null;
  careIron?: CareIron | null;
  careDryClean?: CareDryClean | null;
}

export interface GarmentChanges extends PropertyChanges {
  name?: string | null;
  category?: string;
  colors?: GarmentColor[];
  size?: string | null;
  brand?: string | null;
  notes?: string | null;
  /** As typed ('49.9'): readPrice judges it. */
  price?: string | null;
  acquiredOn?: string | null;
  sourceUrl?: string | null;
  /** The care label's free text (washing_details). */
  careNotes?: string | null;
  quantity?: number;
  /** null: the role's default; NEVER_WASH: never. Read for the owner only. */
  washAfterWears?: number | null;
  condition?: Condition;
  /** Kept only while the condition is a problem (readCondition). */
  conditionNote?: string | null;
}

/** The changes' property names as the garment model names them. */
const PROPERTY_OF: Record<keyof PropertyChanges, GarmentProperty> = {
  type: 'type',
  warmth: 'warmth',
  formality: 'formality',
  materials: 'materials',
  pattern: 'pattern',
  fit: 'fit',
  sleeve: 'sleeve',
  length: 'length',
  fabricWeightGsm: 'fabricWeight',
  waterResistant: 'waterResistant',
  careWash: 'careWash',
  careBleach: 'careBleach',
  careDry: 'careDry',
  careIron: 'careIron',
  careDryClean: 'careDryClean',
};

export type GarmentEdit =
  | {
      ok: true;
      /** Only the fields whose stored value changes: nothing else is written. */
      fields: Partial<GarmentFields>;
      /** The property names the save did not keep (ignoredProperties). */
      ignored: (keyof PropertyChanges)[];
    }
  | { ok: false; errors: FieldErrors<GarmentField> };

/**
 * An edit of `garment` as the garment form's own save: its edit form's
 * values for `audience` (so a MANAGE grantee's edit leaves the owner-only
 * wash limit as stored), the changes made to them, then formPost and
 * readGarmentForm.
 */
export function readGarmentEdit(
  garment: GarmentDetail,
  changes: GarmentChanges,
  audience: FormAudience,
): GarmentEdit {
  // Every field the edit posts back is written: one read without the
  // price and notes would clear them (#680).
  const stored = withPrivateFields(garment);
  const values = withChanges(
    storedFormValues(stored, audience),
    garment.fabricWeight,
    changes,
  );
  const read = readGarmentForm(formPost(values), audience);
  if (!read.ok) return { ok: false, errors: read.errors };
  return {
    ok: true,
    fields: changedFields(stored, read.fields),
    ignored: ignoredProperties(garment, read.fields, changes),
  };
}

/**
 * A new garment's fields: `base` (a blank form, or a clone's prefilled
 * from its source, whose weight in grams is `baseGsm`) with the changes,
 * read as the form's post.
 */
export function readNewGarment(
  base: GarmentFormValues,
  baseGsm: number | null,
  changes: GarmentChanges,
  audience: FormAudience,
): GarmentForm {
  return readGarmentForm(
    formPost(withChanges(base, baseGsm, changes)),
    audience,
  );
}

/** `base` with the changes; null clears a field. */
function withChanges(
  base: GarmentFormValues,
  baseGsm: number | null,
  changes: GarmentChanges,
): GarmentFormValues {
  const category =
    changes.category === undefined
      ? base.category
      : normalizeCategory(changes.category);
  const text = (change: string | null | undefined, kept: string) =>
    change === undefined ? kept : (change ?? '');
  return {
    ...base,
    name: text(changes.name, base.name),
    category,
    brand: text(changes.brand, base.brand),
    colors: changes.colors ?? base.colors,
    size: text(changes.size, base.size),
    notes: text(changes.notes, base.notes),
    price: text(changes.price, base.price),
    dateAquired: text(changes.acquiredOn, base.dateAquired),
    sourceUrl: text(changes.sourceUrl, base.sourceUrl),
    washingDetails: text(changes.careNotes, base.washingDetails),
    properties: changedProperties(base.properties, baseGsm, category, changes),
    // Each as the base has it unless given; the reader keeps the note only
    // with a problem (readCondition), so `good` clears it.
    care: {
      ...base.care,
      ...(changes.quantity !== undefined && {
        quantity: String(changes.quantity),
      }),
      ...(changes.washAfterWears !== undefined && {
        washAfterWears:
          changes.washAfterWears === null ? '' : String(changes.washAfterWears),
      }),
      ...(changes.condition !== undefined && { condition: changes.condition }),
      ...(changes.conditionNote !== undefined && {
        conditionNote: changes.conditionNote ?? '',
      }),
    },
  };
}

/**
 * The base's properties with the changes, for a garment of `category` (the
 * new one, if it changes): a new type first brings its presets
 * (withPresets, as the form's type chip), new materials the care label's
 * (withCarePresets, as the form's material chips), then the explicit
 * values win. A new category alone presets nothing.
 */
function changedProperties(
  base: PropertyFormValues,
  baseGsm: number | null,
  category: string,
  changes: PropertyChanges,
): PropertyFormValues {
  // The weight in grams as stored: the form shows ounces to one decimal,
  // which need not read back to the same grams.
  let values: PropertyFormValues = {
    ...base,
    fabricWeight: orEmpty(baseGsm?.toString()),
    fabricWeightUnit: 'gsm',
  };
  if (changes.type !== undefined) {
    values = withPresets(
      {
        ...values,
        type: changes.type === null ? '' : checkedType(category, changes.type),
      },
      category,
    );
  }
  if (changes.materials !== undefined) {
    values = withCarePresets(
      { ...values, materials: changes.materials ?? [] },
      category,
    );
  }
  return { ...values, ...explicitValues(changes) };
}

/**
 * The read fields whose value differs from the stored garment's: the one
 * update writes these alone. The stored replaced garment is posted back as
 * it is, so it is never among them.
 */
function changedFields(
  stored: GarmentDetail,
  read: GarmentFields,
): Partial<GarmentFields> {
  const changed: Partial<GarmentFields> = {};
  for (const key of Object.keys(read) as (keyof GarmentFields)[]) {
    if (!sameValue(stored[key], read[key])) {
      Object.assign(changed, { [key]: read[key] });
    }
  }
  return changed;
}

/** Sets (colours, materials) by their members, in order; the rest by value. */
function sameValue(stored: unknown, read: unknown): boolean {
  if (Array.isArray(stored) && Array.isArray(read)) {
    return (
      stored.length === read.length &&
      stored.every((value, i) => value === read[i])
    );
  }
  return stored === read;
}

/**
 * The property names the save did not keep: a value given (not a clear:
 * null, false, no materials) that the garment's role (the new one, if the
 * category changes) does not have; or, not given, set before and dropped
 * by a new category, whose role does not have it or whose types do not
 * include the stored type. A type given that is not of the category was
 * refused before (checkedType).
 */
function ignoredProperties(
  garment: GarmentDetail,
  read: GarmentFields,
  changes: PropertyChanges,
): (keyof PropertyChanges)[] {
  return (Object.keys(PROPERTY_OF) as (keyof PropertyChanges)[]).filter(
    (name) => {
      const property = PROPERTY_OF[name];
      if (property === 'type') {
        return (
          changes.type === undefined && garment.type !== null && !read.type
        );
      }
      return (
        !propertyApplies(property, read.category) &&
        hasValue(
          changes[name] === undefined ? garment[property] : changes[name],
        )
      );
    },
  );
}

/** A property value that is set: not null, not false, not an empty set. */
function hasValue(value: unknown): boolean {
  return (
    value !== null &&
    value !== false &&
    !(Array.isArray(value) && value.length === 0)
  );
}

/** The single-choice properties, posted as text like the form's chips. */
const CHOICES = [
  'warmth',
  'formality',
  'pattern',
  'fit',
  'sleeve',
  'length',
  'careWash',
  'careBleach',
  'careDry',
  'careIron',
  'careDryClean',
] as const;

/** The given changes but the type, as the form's values; null is the reset chip. */
function explicitValues(changes: PropertyChanges): Partial<PropertyFormValues> {
  const values: Partial<PropertyFormValues> = {};
  for (const name of CHOICES) {
    const value = changes[name];
    if (value !== undefined) values[name] = value === null ? '' : String(value);
  }
  if (changes.materials !== undefined) {
    values.materials = changes.materials ?? [];
  }
  if (changes.fabricWeightGsm !== undefined) {
    values.fabricWeight = String(changes.fabricWeightGsm ?? '');
    values.fabricWeightUnit = 'gsm';
  }
  if (changes.waterResistant !== undefined) {
    values.waterResistant = changes.waterResistant;
  }
  return values;
}
