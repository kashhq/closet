import { type Static, Type } from '@sinclair/typebox';
import type { FieldErrors } from '../auth/validation';
import { type IsoDate, parseIsoDate } from '../../calendar-date';
import { t, type Translated } from '../i18n';
import { choice, pick, RowId } from '../schemas';
import {
  NEVER_WASH,
  QUANTITY_MAX,
  WASH_AFTER_CHOICES,
} from '../../wardrobe/availability';
import {
  applyPresets,
  type Condition,
  CONDITIONS,
  FABRIC_WEIGHT_GSM,
  type Fit,
  FITS,
  type Formality,
  FORMALITIES,
  findType,
  GARMENT_COLORS,
  type GarmentColor,
  type GarmentProperty,
  gsmToOz,
  isGarmentColor,
  type Length,
  LENGTHS,
  type Material,
  MATERIALS,
  ozToGsm,
  type Pattern,
  PATTERNS,
  type PresetSource,
  propertyApplies,
  type Sleeve,
  SLEEVES,
  storedSet,
  type Warmth,
  WARMTHS,
} from '../../wardrobe/properties';
import {
  applyCarePresets,
  CARE_BLEACH,
  CARE_DRY,
  CARE_DRY_CLEAN,
  CARE_IRON,
  CARE_WASH,
  type CareLabel,
} from '../../wardrobe/care';
import { normalizeCategory, normalizeSize } from './garment';

/**
 * The garment input model: the garment form's TypeBox body (GarmentBody), the
 * form values it shows, and the checks. Two layers, as in
 * src/web/auth/validation.ts: the schema is the route's Fastify schema (a body
 * longer than a field allows never reaches the handler: a 400 error page),
 * and readGarmentForm checks what a well-formed form can still get wrong (a
 * blank category, a colour outside GARMENT_COLORS, a date that is not one),
 * which re-renders the form with a 400 and the messages under the fields.
 * The inputs carry the same maxlength, so a person never meets the caps.
 * Shared by the form's routes, the MCP garment tools (mcp/tools/) and the
 * seed (seed/persona.ts), so each saves a garment through the same parser.
 */

export const NAME_MAX = 200;
export const CATEGORY_MAX = 60;
export const BRAND_MAX = 100;
export const SIZE_MAX = 40;
export const TEXT_MAX = 4000;
/** Product pages' URLs run long (tracking parameters); browsers take ~2k. */
export const SOURCE_URL_MAX = 2048;
/** "$12,345,678.90" and a little room: numeric(10, 2) holds 8 digits before the point. */
export const PRICE_INPUT_MAX = 20;
/** "Hole in the left elbow", "At the cobbler on Fulton St": a line, not a story. */
export const CARE_NOTE_MAX = 200;

// Every material's name, comma-joined, with room to spare.
const PRESET_MATERIALS_MAX = 400;

// Room for a hostile value to reach readGarmentForm and be named in its
// message; every real colour is a few letters.
export const ColorValue = Type.String({ maxLength: 40 });

/**
 * The duplicate check's "Not the same" ids (readIdList). A form grows it
 * by the few matches shown per dismissal; the cap only bounds a hand-made
 * request.
 */
export const LookalikesDismissed = Type.Optional(
  Type.String({ maxLength: 400 }),
);

/**
 * The draft queue's saved garments (readIdList): one id per draft of a
 * batch, at most MAX_DRAFTS_PER_USER of them.
 */
export const DraftsSaved = Type.Optional(Type.String({ maxLength: 400 }));

const FabricWeightUnit = Type.Union([Type.Literal('oz'), Type.Literal('gsm')]);
type FabricWeightUnit = Static<typeof FabricWeightUnit>;

/**
 * The property fields as the form posts them; shared by the garment form's
 * body and the properties fragment's query. A type is checked against the
 * posted category in readProperties (it is a free choice of the category's
 * list, which the schema cannot see).
 */
export const PropertyFields = {
  type: Type.Optional(Type.String({ maxLength: 40 })),
  warmth: choice(WARMTHS),
  formality: choice(FORMALITIES),
  materials: Type.Optional(
    Type.Array(
      Type.Union(MATERIALS.map((material) => Type.Literal(material))),
      { maxItems: MATERIALS.length * 2 },
    ),
  ),
  pattern: choice(PATTERNS),
  fit: choice(FITS),
  sleeve: choice(SLEEVES),
  length: choice(LENGTHS),
  fabricWeight: Type.Optional(Type.String({ maxLength: 12 })),
  fabricWeightUnit: Type.Optional(FabricWeightUnit),
  waterResistant: Type.Optional(Type.Literal('true')),
  // The care label (#23, src/wardrobe/care.ts): read by a save only beside
  // its own marker (GarmentBody.careLabel).
  careWash: choice(CARE_WASH),
  careBleach: choice(CARE_BLEACH),
  careDry: choice(CARE_DRY),
  careIron: choice(CARE_IRON),
  careDryClean: choice(CARE_DRY_CLEAN),
  // Hidden: the category, type and weight (gsm) the shown presets came
  // from, so a type change replaces only values still at their preset
  // (applyPresets, src/wardrobe/properties.ts), and the materials the care
  // label's presets came from (comma-joined; applyCarePresets). Never stored.
  presetCategory: Type.Optional(Type.String({ maxLength: CATEGORY_MAX })),
  presetType: Type.Optional(Type.String({ maxLength: 40 })),
  presetWeight: Type.Optional(Type.String({ maxLength: 12 })),
  presetMaterials: Type.Optional(
    Type.String({ maxLength: PRESET_MATERIALS_MAX }),
  ),
};
const PostedProperties = Type.Object(PropertyFields);
type PostedProperties = Static<typeof PostedProperties>;

export const ConditionValue = Type.Union(
  CONDITIONS.map((condition) => Type.Literal(condition)),
);

/** A condition and what is wrong, as the form and the garment page post them. */
export const PostedConditionFields = {
  condition: Type.Optional(ConditionValue),
  conditionNote: Type.Optional(Type.String({ maxLength: CARE_NOTE_MAX })),
};

/**
 * The care fields (#7): identical copies, wears before a wash ('' the
 * role's default, NEVER_WASH never) and the condition. Quantity is typed,
 * so it is the one with a message (readCareFields); the rest are choices.
 */
const PostedCareFields = {
  quantity: Type.Optional(Type.String({ maxLength: 6 })),
  washAfterWears: choice([NEVER_WASH, ...WASH_AFTER_CHOICES]),
  ...PostedConditionFields,
};

/** Where a new garment lands (EntryStatus, src/wardrobe/status.ts). */
export const Destination = Type.Union([
  Type.Literal('closet'),
  Type.Literal('wishlist'),
]);

/**
 * One garment form post (new, edit, clone). The form posts every text field,
 * '' when left empty; `color` is one value per checked box (none when no box
 * is checked; ajv's coerceTypes 'array' makes a single one a list).
 * `dateAquired` keeps the form's historical field name (cached pages of the
 * installed app still post it); it is stored as garment.acquired_on.
 */
export const GarmentBody = Type.Object({
  name: Type.Optional(Type.String({ maxLength: NAME_MAX })),
  category: Type.String({ maxLength: CATEGORY_MAX }),
  brand: Type.Optional(Type.String({ maxLength: BRAND_MAX })),
  color: Type.Optional(
    Type.Array(ColorValue, { maxItems: GARMENT_COLORS.length * 2 }),
  ),
  size: Type.Optional(Type.String({ maxLength: SIZE_MAX })),
  washingDetails: Type.Optional(Type.String({ maxLength: TEXT_MAX })),
  dateAquired: Type.Optional(Type.String({ maxLength: 32 })),
  notes: Type.Optional(Type.String({ maxLength: TEXT_MAX })),
  ...PropertyFields,
  // '1' from every form that renders the properties. A form the installed
  // app cached before they existed posts none, and its save must leave the
  // stored ones alone rather than clear them (an edit writes every field).
  props: Type.Optional(Type.Literal('1')),
  // '1' from every form that renders the care label (#23), for the same
  // reason: forms cached before it post props=1 without its fields.
  careLabel: Type.Optional(Type.Literal('1')),
  sourceUrl: Type.Optional(Type.String({ maxLength: SOURCE_URL_MAX })),
  price: Type.Optional(Type.String({ maxLength: PRICE_INPUT_MAX })),
  // '1' from every form that renders the product link and price, for the
  // same reason as props: forms cached before them (props=1 included) post
  // neither, and must not clear them.
  product: Type.Optional(Type.Literal('1')),
  // A new garment's form prefilled from a link: the stored name of the
  // photo fetched with it, claimed on save (POST /wardrobe only; judged by
  // parseStoredName there, the one definition of a stored name).
  linkPhoto: Type.Optional(Type.String({ maxLength: 64 })),
  ...PostedCareFields,
  // '1' from every form that renders the care fields: forms cached before
  // them post none, and must not reset a garment to one copy in good shape.
  care: Type.Optional(Type.Literal('1')),
  // A new garment's destination (the wishlist's "Add" and "Find a
  // replacement"); absent is the closet, as every form before #18 posts.
  to: Type.Optional(Destination),
  // What a wishlist item replaces ('' for nothing), read only beside its
  // marker `wishlist=1`: the wishlist forms render both, and every other
  // form (a closet garment's, one cached before #18) must leave it alone.
  replaces: Type.Optional(Type.Union([Type.Literal(''), RowId])),
  wishlist: Type.Optional(Type.Literal('1')),
  // A new closet garment's order item (#25, "From your orders"): marked
  // added with it (POST /wardrobe only; the requester's own pending item,
  // else a 404).
  orderItem: Type.Optional(Type.Union([Type.Literal(''), RowId])),
  // A new closet garment's Muse need (#333, "Bought a different one"):
  // settled by it in its transaction (POST /wardrobe only; the requester's
  // own open need, else a 404).
  forNeed: Type.Optional(Type.Union([Type.Literal(''), RowId])),
  // The duplicate check's "Not the same" list (#20, lookalikes.ts): never
  // stored, only carried back into a refused form's region.
  lookalikesDismissed: LookalikesDismissed,
  // A draft's form (#200): the garments its batch saved so far, carried on
  // to the next draft and, after the last, into select mode. Never stored.
  draftsSaved: DraftsSaved,
});
export type GarmentBody = Static<typeof GarmentBody>;

/** What the form shows: the posted strings, or a stored garment's. */
export interface GarmentFormValues {
  name: string;
  category: string;
  brand: string;
  colors: string[];
  size: string;
  washingDetails: string;
  dateAquired: string;
  notes: string;
  sourceUrl: string;
  price: string;
  properties: PropertyFormValues;
  care: CareFormValues;
  /** A wishlist item's replaced garment id, '' for none. */
  replaces: string;
}

/** The care fields as the form shows them (strings as posted). */
export interface CareFormValues {
  quantity: string;
  washAfterWears: string;
  condition: Condition;
  conditionNote: string;
}

export const BLANK_CARE: CareFormValues = {
  quantity: '1',
  washAfterWears: '',
  condition: 'good',
  conditionNote: '',
};

/** The care label's fields as the form shows them: none chosen. */
export const BLANK_CARE_LABEL = {
  careWash: '',
  careBleach: '',
  careDry: '',
  careIron: '',
  careDryClean: '',
} as const satisfies Record<keyof CareLabel, string>;

/** The property fields as the form shows them (strings as posted). */
export interface PropertyFormValues {
  type: string;
  warmth: string;
  formality: string;
  materials: string[];
  pattern: string;
  fit: string;
  sleeve: string;
  length: string;
  /** As typed, in `fabricWeightUnit`. */
  fabricWeight: string;
  fabricWeightUnit: FabricWeightUnit;
  waterResistant: boolean;
  careWash: string;
  careBleach: string;
  careDry: string;
  careIron: string;
  careDryClean: string;
  /** Where the shown presets came from (hidden fields; see PropertyFields). */
  preset: { category: string; type: string; weight: string; materials: string };
}

export const BLANK_PROPERTIES: PropertyFormValues = {
  type: '',
  warmth: '',
  formality: '',
  materials: [],
  pattern: '',
  fit: '',
  sleeve: '',
  length: '',
  fabricWeight: '',
  fabricWeightUnit: 'oz',
  waterResistant: false,
  ...BLANK_CARE_LABEL,
  preset: { category: '', type: '', weight: '', materials: '' },
};

/** A new garment's form: every field empty. */
export const BLANK_GARMENT_VALUES: GarmentFormValues = {
  name: '',
  category: '',
  brand: '',
  colors: [],
  size: '',
  washingDetails: '',
  dateAquired: '',
  notes: '',
  sourceUrl: '',
  price: '',
  properties: BLANK_PROPERTIES,
  care: BLANK_CARE,
  replaces: '',
};

export type GarmentField =
  | 'category'
  | 'color'
  | 'dateAquired'
  | 'fabricWeight'
  | 'sourceUrl'
  | 'price'
  | 'linkPhoto'
  | 'quantity';

/** The properties as stored (null for not set, or not applying to the role). */
export interface GarmentPropertyFields {
  type: string | null;
  warmth: Warmth | null;
  formality: Formality | null;
  materials: Material[] | null;
  pattern: Pattern | null;
  fit: Fit | null;
  sleeve: Sleeve | null;
  length: Length | null;
  /** Grams per square metre. */
  fabricWeight: number | null;
  waterResistant: boolean;
}

/** Where the garment can be bought and what it cost, as stored. */
export interface ProductFields {
  /** An http(s) URL (readSourceUrl). */
  sourceUrl: string | null;
  /** numeric(10, 2) as text, always two decimals ('24.90'). */
  price: string | null;
}

/** A garment's condition as stored: the note only with a problem. */
export interface ConditionFields {
  condition: Condition;
  conditionNote: string | null;
}

/** Copies, wash limit and condition, as stored. */
export interface CareFields extends ConditionFields {
  /** 1 to QUANTITY_MAX. */
  quantity: number;
  /** null: the role's default; NEVER_WASH: never. */
  washAfterWears: number | null;
}

/**
 * A garment's fields as stored: trimmed, null when blank. The properties,
 * the care label, the product fields and the care fields are absent (left
 * as stored) when the posting form predates them.
 */
export interface GarmentFields
  extends
    Partial<GarmentPropertyFields>,
    Partial<CareLabel>,
    Partial<ProductFields>,
    Partial<CareFields> {
  name: string | null;
  category: string;
  brand: string | null;
  /** A set in GARMENT_COLORS order; null for none. */
  colors: GarmentColor[] | null;
  size: string | null;
  notes: string | null;
  washingDetails: string | null;
  acquiredOn: IsoDate | null;
  /**
   * The garment a wishlist item replaces (null for none); absent (left as
   * stored) unless the form was a wishlist form (GarmentBody.wishlist).
   * Stored only when it is the same owner's (replacementOf, queries.ts).
   */
  replacesGarmentId?: number | null;
}

export type GarmentForm =
  | { ok: true; fields: GarmentFields }
  | { ok: false; values: GarmentFormValues; errors: FieldErrors<GarmentField> };

/** One-line fields: trimmed, and null when blank. */
function line(value: string | undefined): string | null {
  return value?.trim() || null;
}

/** Multi-line text: kept as typed, null when blank. */
function text(value: string | undefined): string | null {
  return value?.trim() ? value : null;
}

export function formValues(body: GarmentBody): GarmentFormValues {
  return {
    name: body.name ?? '',
    category: body.category,
    brand: body.brand ?? '',
    colors: body.color ?? [],
    size: body.size ?? '',
    washingDetails: body.washingDetails ?? '',
    dateAquired: body.dateAquired ?? '',
    notes: body.notes ?? '',
    sourceUrl: body.sourceUrl ?? '',
    price: body.price ?? '',
    properties: propertyFormValues(body),
    care: careFormValues(body),
    replaces: replacesShown(body.replaces),
  };
}

/**
 * What the garment form posts when it shows `values` (formValues'
 * inverse), every marker set: for a writer that has form values but no
 * browser, so its garment goes through readGarmentForm like any other
 * (the MCP tools add_garment_from_link, which saves a link import's
 * prefilled form, and update_garment, which saves the stored garment's
 * edit form with its changes). The caller's values stay bounded by
 * GarmentBody's caps; readGarmentForm judges the rest.
 */
export function formPost(values: GarmentFormValues): GarmentBody {
  const { properties, care } = values;
  return {
    name: values.name,
    category: values.category,
    brand: values.brand,
    color: values.colors,
    size: values.size,
    washingDetails: values.washingDetails,
    dateAquired: values.dateAquired,
    notes: values.notes,
    props: '1',
    type: properties.type,
    warmth: choiceValue(WARMTHS, properties.warmth),
    formality: choiceValue(FORMALITIES, properties.formality),
    materials: MATERIALS.filter((m) => properties.materials.includes(m)),
    pattern: choiceValue(PATTERNS, properties.pattern),
    fit: choiceValue(FITS, properties.fit),
    sleeve: choiceValue(SLEEVES, properties.sleeve),
    length: choiceValue(LENGTHS, properties.length),
    fabricWeight: properties.fabricWeight,
    fabricWeightUnit: properties.fabricWeightUnit,
    ...(properties.waterResistant && { waterResistant: 'true' }),
    careLabel: '1',
    careWash: choiceValue(CARE_WASH, properties.careWash),
    careBleach: choiceValue(CARE_BLEACH, properties.careBleach),
    careDry: choiceValue(CARE_DRY, properties.careDry),
    careIron: choiceValue(CARE_IRON, properties.careIron),
    careDryClean: choiceValue(CARE_DRY_CLEAN, properties.careDryClean),
    product: '1',
    sourceUrl: values.sourceUrl,
    price: values.price,
    care: '1',
    wishlist: '1',
    replaces: values.replaces === '' ? '' : Number(values.replaces),
    quantity: care.quantity,
    washAfterWears: choiceValue(
      [NEVER_WASH, ...WASH_AFTER_CHOICES],
      care.washAfterWears,
    ),
    condition: care.condition,
    conditionNote: care.conditionNote,
  };
}

/**
 * A choice field's text as the schema types it: one of `set` (as text), or
 * '' (the reset chip) for anything else.
 */
function choiceValue<T extends string | number>(
  set: readonly T[],
  shown: string,
): `${T}` | '' {
  const found = pick(set, shown);
  return found === null ? '' : (String(found) as `${T}`);
}

/** A wishlist form's posted "Replaces" as the form shows it ('' for nothing). */
function replacesShown(posted: GarmentBody['replaces']): string {
  return posted === undefined ? '' : String(posted);
}

/** The posted care fields as the form shows them; a new garment's without them. */
function careFormValues(body: GarmentBody): CareFormValues {
  if (body.care !== '1') return BLANK_CARE;
  return {
    quantity: body.quantity ?? '',
    washAfterWears: body.washAfterWears ?? '',
    condition: body.condition ?? 'good',
    conditionNote: body.conditionNote ?? '',
  };
}

/**
 * Who a garment form is read or written for. `owner`: the requester owns the
 * garment (resolveWardrobeAccess's isOwner, the predicate the garment page's
 * garmentContext reads the wears by). The wash limit is the owner's own record,
 * like the wears and washes it counts (src/web/wears/AGENTS.md): a MANAGE
 * grantee edits the garment's properties, quantity and condition, never the
 * owner's laundry, so for anyone else the form is not given the stored limit
 * (storedFormValues) and a posted one is ignored, left as stored
 * (readGarmentForm).
 */
export interface FormAudience {
  owner: boolean;
}

/**
 * Who owns the garment a form saves: the requester in their own wardrobe
 * (`viewOwner` undefined: authorizeWardrobe's isOwner), and always for a
 * clone, which lands there. The one rule for both sides of the owner-only
 * fields (FormAudience): the form renders them only for the
 * owner, and the routes read them from the post only for the owner.
 */
export function formAudience(
  mode: { kind: 'new' | 'edit' | 'clone' },
  viewOwner: number | undefined,
): FormAudience {
  return { owner: mode.kind === 'clone' || viewOwner === undefined };
}

/** A stored garment's care fields as the form shows them to `audience`. */
function storedCareValues(
  stored: CareFields,
  audience: FormAudience,
): CareFormValues {
  return {
    quantity: String(stored.quantity),
    washAfterWears: audience.owner ? asText(stored.washAfterWears) : '',
    condition: stored.condition,
    conditionNote: orEmpty(stored.conditionNote),
  };
}

/**
 * The condition as stored: the note trimmed, and only with a problem (a
 * garment in good shape has nothing to note; the column's check agrees).
 */
export function readCondition(posted: {
  condition?: Condition;
  conditionNote?: string;
}): ConditionFields {
  const condition = posted.condition ?? 'good';
  return {
    condition,
    conditionNote: condition === 'good' ? null : line(posted.conditionNote),
  };
}

/**
 * The care fields as stored, or the quantity's message; none (left as
 * stored) when the posting form predates them (GarmentBody.care). A blank
 * quantity is one copy. The wash limit only from the owner (FormAudience).
 */
function readCareFields(
  posted: Pick<
    GarmentBody,
    'care' | 'quantity' | 'washAfterWears' | 'condition' | 'conditionNote'
  >,
  audience: FormAudience,
):
  | { ok: true; fields: Partial<CareFields> }
  | { ok: false; error: Translated } {
  if (posted.care !== '1') return { ok: true, fields: {} };
  const typed = posted.quantity?.trim() || '1';
  const quantity = Number(typed);
  if (!/^\d+$/.test(typed) || quantity < 1 || quantity > QUANTITY_MAX) {
    return {
      ok: false,
      error: t('validation.QUANTITY_RANGE', { max: QUANTITY_MAX }),
    };
  }
  return {
    ok: true,
    fields: {
      quantity,
      ...(audience.owner && {
        washAfterWears: pick(
          [NEVER_WASH, ...WASH_AFTER_CHOICES],
          posted.washAfterWears ?? '',
        ),
      }),
      ...readCondition(posted),
    },
  };
}

/** The posted property fields as the form shows them. */
export function propertyFormValues(
  posted: PostedProperties,
): PropertyFormValues {
  return {
    type: orEmpty(posted.type),
    warmth: orEmpty(posted.warmth),
    formality: orEmpty(posted.formality),
    materials: posted.materials ?? [],
    pattern: orEmpty(posted.pattern),
    fit: orEmpty(posted.fit),
    sleeve: orEmpty(posted.sleeve),
    length: orEmpty(posted.length),
    fabricWeight: orEmpty(posted.fabricWeight),
    fabricWeightUnit: posted.fabricWeightUnit ?? 'oz',
    waterResistant: posted.waterResistant === 'true',
    careWash: orEmpty(posted.careWash),
    careBleach: orEmpty(posted.careBleach),
    careDry: orEmpty(posted.careDry),
    careIron: orEmpty(posted.careIron),
    careDryClean: orEmpty(posted.careDryClean),
    preset: {
      category: orEmpty(posted.presetCategory),
      type: orEmpty(posted.presetType),
      weight: orEmpty(posted.presetWeight),
      materials: orEmpty(posted.presetMaterials),
    },
  };
}

/** A stored garment's properties and care label as the form shows them (weight in oz). */
export function storedPropertyValues(
  stored: GarmentPropertyFields & CareLabel & { category: string },
): PropertyFormValues {
  return {
    type: orEmpty(stored.type),
    warmth: asText(stored.warmth),
    formality: asText(stored.formality),
    materials: stored.materials ?? [],
    pattern: orEmpty(stored.pattern),
    fit: orEmpty(stored.fit),
    sleeve: orEmpty(stored.sleeve),
    length: orEmpty(stored.length),
    fabricWeight: asText(stored.fabricWeight, gsmToOz),
    fabricWeightUnit: 'oz',
    waterResistant: stored.waterResistant,
    careWash: orEmpty(stored.careWash),
    careBleach: orEmpty(stored.careBleach),
    careDry: orEmpty(stored.careDry),
    careIron: orEmpty(stored.careIron),
    careDryClean: orEmpty(stored.careDryClean),
    // The stored values that still equal the stored type's (and
    // materials') presets follow a change; the rest were chosen.
    preset: {
      category: stored.category,
      type: orEmpty(stored.type),
      weight: asText(stored.fabricWeight),
      materials: presetMaterialsText(stored.materials ?? []),
    },
  };
}

/** The materials the care presets came from, as the hidden field carries them. */
function presetMaterialsText(materials: readonly Material[]): string {
  return materials.join(',');
}

/** The hidden field's materials; anything not a material is dropped. */
function presetMaterials(text: string): Material[] {
  return storedSet(MATERIALS, text.split(',')) ?? [];
}

/**
 * A stored garment as its edit and clone forms show it to `audience`. The
 * price and notes must be there (#680): an edit's through
 * withPrivateFields, which refuses a garment read without them (an omitted
 * field would be saved as cleared); a clone's through withoutUnread (a VIEW
 * grantee's starts without them).
 */
export function storedFormValues(
  stored: Required<GarmentFields>,
  audience: FormAudience,
): GarmentFormValues {
  return {
    name: orEmpty(stored.name),
    category: stored.category,
    brand: orEmpty(stored.brand),
    colors: stored.colors ?? [],
    size: orEmpty(stored.size),
    washingDetails: orEmpty(stored.washingDetails),
    dateAquired: orEmpty(stored.acquiredOn),
    notes: orEmpty(stored.notes),
    sourceUrl: orEmpty(stored.sourceUrl),
    price: orEmpty(stored.price),
    properties: storedPropertyValues(stored),
    care: storedCareValues(stored, audience),
    replaces: asText(stored.replacesGarmentId),
  };
}

/** A form field's text for an optional value: '' for none. */
export function orEmpty(value: string | null | undefined): string {
  return value ?? '';
}

/** A number as a form field's text, through `show` (e.g. gsm to oz); '' for none. */
function asText(
  value: number | null,
  show: (value: number) => number = (n) => n,
): string {
  return value === null ? '' : String(show(value));
}

/**
 * A posted weight's grams. `shownGsm` is the hidden `presetWeight`: the
 * grams behind the weight the form showed. Ounces are shown to 0.1 (about
 * 3.4 gsm), so 202 gsm shows as 6.0 oz and `ozToGsm(6)` is 203: ounces that
 * still read as `shownGsm` keep it, or every save and every properties
 * fragment would move a weight nobody touched (#472).
 */
function postedGsm(
  value: number,
  unit: FabricWeightUnit,
  shownGsm: string,
): number {
  if (unit === 'gsm') return Math.round(value);
  const shown = Number(shownGsm);
  const untouched =
    shownGsm !== '' && Number.isInteger(shown) && gsmToOz(shown) === value;
  return untouched ? shown : ozToGsm(value);
}

/**
 * A typed weight in grams per square metre (through `postedGsm`): null when
 * empty, a message when it is not a number or outside FABRIC_WEIGHT_GSM
 * (named in the unit the person typed).
 */
function readFabricWeight(
  posted: string,
  unit: FabricWeightUnit,
  shownGsm: string,
): { gsm: number | null } | { error: Translated } {
  const typed = posted.trim();
  if (!typed) return { gsm: null };
  const value = Number(typed.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) {
    return { error: t('validation.FABRIC_WEIGHT_NUMBER') };
  }
  const gsm = postedGsm(value, unit, shownGsm);
  if (gsm < FABRIC_WEIGHT_GSM.min || gsm > FABRIC_WEIGHT_GSM.max) {
    const [min, max] =
      unit === 'gsm'
        ? [FABRIC_WEIGHT_GSM.min, FABRIC_WEIGHT_GSM.max]
        : [gsmToOz(FABRIC_WEIGHT_GSM.min), gsmToOz(FABRIC_WEIGHT_GSM.max)];
    return {
      error: t('validation.FABRIC_WEIGHT_RANGE', {
        min,
        max,
        unit: t(unit === 'gsm' ? 'UNIT_GSM' : 'UNIT_OZ'),
      }),
    };
  }
  return { gsm };
}

/**
 * The posted properties as stored for a garment of `category`: a type
 * outside the category's list and every property its role does not have
 * are null (so recategorising a tee as shorts drops its sleeve), and
 * materials are a set, null for none. The weight is the only field a
 * person types, so the only one with a message.
 */
function readProperties(
  values: PropertyFormValues,
  category: string,
):
  | { ok: true; fields: GarmentPropertyFields }
  | { ok: false; error: Translated } {
  const weight = readFabricWeight(
    values.fabricWeight,
    values.fabricWeightUnit,
    values.preset.weight,
  );
  if ('error' in weight) return { ok: false, error: weight.error };
  /** `value` when the category's role has `property`, else not set. */
  const only = <T>(property: GarmentProperty, value: T | null): T | null =>
    propertyApplies(property, category) ? value : null;
  return {
    ok: true,
    fields: {
      type: findType(category, values.type)?.value ?? null,
      warmth: only('warmth', pick(WARMTHS, values.warmth)),
      formality: only('formality', pick(FORMALITIES, values.formality)),
      materials: only('materials', storedSet(MATERIALS, values.materials)),
      pattern: only('pattern', pick(PATTERNS, values.pattern)),
      fit: only('fit', pick(FITS, values.fit)),
      sleeve: only('sleeve', pick(SLEEVES, values.sleeve)),
      length: only('length', pick(LENGTHS, values.length)),
      fabricWeight: only('fabricWeight', weight.gsm),
      waterResistant: only('waterResistant', values.waterResistant) === true,
    },
  };
}

/**
 * The posted care label as stored for a garment of `category`: every
 * instruction null when the role has no label (shoes, bags), so
 * recategorising drops it. Only the form's own chips post these (the
 * schema), so there is nothing to message.
 */
function readCareLabel(
  values: PropertyFormValues,
  category: string,
): CareLabel {
  const labelled = propertyApplies('careWash', category);
  const only = <T extends string>(set: readonly T[], posted: string) =>
    labelled ? pick(set, posted) : null;
  return {
    careWash: only(CARE_WASH, values.careWash),
    careBleach: only(CARE_BLEACH, values.careBleach),
    careDry: only(CARE_DRY, values.careDry),
    careIron: only(CARE_IRON, values.careIron),
    careDryClean: only(CARE_DRY_CLEAN, values.careDryClean),
  };
}

/**
 * The form's care label after the materials changed: instructions still at
 * the previous materials' presets (the hidden presetMaterials) follow the
 * new ones, unset ones are filled (applyCarePresets), and the hidden field
 * moves to the materials now shown. Nothing is preset for a role without a
 * label. Also update_garment's, when it changes the materials.
 */
export function withCarePresets(
  values: PropertyFormValues,
  category: string,
): PropertyFormValues {
  const materials = storedSet(MATERIALS, values.materials) ?? [];
  const preset = {
    ...values.preset,
    materials: presetMaterialsText(materials),
  };
  if (!propertyApplies('careWash', category)) return { ...values, preset };
  const next = applyCarePresets(
    readCareLabel(values, category),
    values.preset.materials ? presetMaterials(values.preset.materials) : null,
    materials,
  );
  return {
    ...values,
    careWash: orEmpty(next.careWash),
    careBleach: orEmpty(next.careBleach),
    careDry: orEmpty(next.careDry),
    careIron: orEmpty(next.careIron),
    careDryClean: orEmpty(next.careDryClean),
    preset,
  };
}

/**
 * The form's properties after the category, type, weight or materials
 * changed (the properties fragment): a type outside the category is
 * dropped, values still at the previous presets follow the new ones
 * (applyPresets, and withCarePresets for the care label), and the hidden
 * preset fields move to what the presets now come from. An unreadable
 * weight counts as none here; the save names it.
 */
export function withPresets(
  values: PropertyFormValues,
  category: string,
): PropertyFormValues {
  const type = findType(category, values.type)?.value ?? null;
  const weight = readFabricWeight(
    values.fabricWeight,
    values.fabricWeightUnit,
    values.preset.weight,
  );
  const gsm = 'gsm' in weight ? weight.gsm : null;
  const next = applyPresets(
    {
      warmth: pick(WARMTHS, values.warmth),
      formality: pick(FORMALITIES, values.formality),
      sleeve: pick(SLEEVES, values.sleeve),
      length: pick(LENGTHS, values.length),
      waterResistant: values.waterResistant,
    },
    presetSource(values.preset),
    { category, type, fabricWeight: gsm },
  );
  return withCarePresets(
    {
      ...values,
      type: orEmpty(type),
      warmth: asText(next.warmth),
      formality: asText(next.formality),
      sleeve: orEmpty(next.sleeve),
      length: orEmpty(next.length),
      waterResistant: next.waterResistant,
      preset: {
        ...values.preset,
        category,
        type: orEmpty(type),
        weight: asText(gsm),
      },
    },
    category,
  );
}

/** The hidden preset fields as applyPresets reads them; null before any. */
function presetSource(
  preset: PropertyFormValues['preset'],
): PresetSource | null {
  if (!preset.category) return null;
  const gsm = Number(preset.weight);
  return {
    category: normalizeCategory(preset.category),
    type: preset.type || null,
    fabricWeight: preset.weight && Number.isInteger(gsm) ? gsm : null,
  };
}

/**
 * The posted colours as stored (a set in GARMENT_COLORS order, null for
 * none), and a message for each posted value not built in.
 */
function readColors(posted: string[] = []): {
  colors: GarmentColor[] | null;
  errors: Translated[];
} {
  return {
    colors: storedSet(GARMENT_COLORS, posted),
    errors: [...new Set(posted)]
      .filter((color) => !isGarmentColor(color))
      .map((color) => t('validation.UNKNOWN_COLOR', { color })),
  };
}

/** The date input's value: null when empty, undefined when not a real date. */
function readDay(posted: string | undefined): IsoDate | null | undefined {
  const value = posted?.trim();
  return value ? parseIsoDate(value) : null;
}

/**
 * A product page's address as stored: the URL as the parser writes it, or
 * null when blank; a message for anything that is not an absolute http(s)
 * URL (a `javascript:` link would run on the garment page's "View product").
 */
function readSourceUrl(
  posted: string | undefined,
): { url: string | null } | { error: Translated } {
  const typed = posted?.trim();
  if (!typed) return { url: null };
  const url = URL.parse(typed);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return { error: t('validation.SOURCE_URL_INVALID') };
  }
  return { url: url.href };
}

// Dollars and cents as people type them ("49.9", "$1,299.00"): the symbol
// and thousands separators are dropped, then at most 8 digits before the
// point (numeric(10, 2)) and 2 after. No sign: a price is never negative.
const PRICE = /^(\d{1,8})(?:\.(\d{1,2}))?$/;

/** A typed price as stored ('49.90'), null when blank, or a message. */
export function readPrice(
  posted: string | undefined,
): { price: string | null } | { error: Translated } {
  const typed = posted
    ?.trim()
    .replace(/^\$\s*/, '')
    .replaceAll(',', '');
  if (!typed) return { price: null };
  const match = PRICE.exec(typed);
  if (!match) return { error: t('validation.PRICE_INVALID') };
  const [, whole, cents = ''] = match;
  return { price: `${Number(whole)}.${cents.padEnd(2, '0')}` };
}

/**
 * The product link and price as stored, or the messages for them; neither
 * (left as stored) when the posting form predates them (GarmentBody.product).
 */
function readProductFields(
  posted: Pick<GarmentBody, 'product' | 'sourceUrl' | 'price'>,
):
  | { ok: true; fields: Partial<ProductFields> }
  | { ok: false; errors: FieldErrors<'sourceUrl' | 'price'> } {
  if (posted.product !== '1') return { ok: true, fields: {} };
  const sourceUrl = readSourceUrl(posted.sourceUrl);
  const price = readPrice(posted.price);
  if ('url' in sourceUrl && 'price' in price) {
    return {
      ok: true,
      fields: { sourceUrl: sourceUrl.url, price: price.price },
    };
  }
  return {
    ok: false,
    errors: {
      ...('error' in sourceUrl && { sourceUrl: [sourceUrl.error] }),
      ...('error' in price && { price: [price.error] }),
    },
  };
}

/**
 * The posted properties as stored for `category`; none (left as stored)
 * when the posting form predates them (GarmentBody.props).
 */
function readPostedProperties(
  body: GarmentBody,
  category: string,
): ReturnType<typeof readProperties> | undefined {
  return body.props === '1'
    ? readProperties(propertyFormValues(body), category)
    : undefined;
}

/**
 * The posted form as the garment to store, or what to show the person. The
 * owner-only fields are read only for the owner (FormAudience).
 */
export function readGarmentForm(
  body: GarmentBody,
  audience: FormAudience,
): GarmentForm {
  const category = normalizeCategory(body.category);
  const colors = readColors(body.color);
  const acquiredOn = readDay(body.dateAquired);
  const properties = readPostedProperties(body, category);
  // Beside its own marker only (GarmentBody.careLabel).
  const careLabel =
    body.careLabel === '1'
      ? readCareLabel(propertyFormValues(body), category)
      : {};
  const product = readProductFields(body);
  const care = readCareFields(body, audience);
  const errors = formErrors({
    category,
    colors,
    acquiredOn,
    properties,
    product,
    care,
  });
  // (The date check repeats formErrors' to narrow acquiredOn for the store.)
  if (Object.keys(errors).length > 0 || acquiredOn === undefined) {
    return { ok: false, values: formValues(body), errors };
  }
  return {
    ok: true,
    fields: {
      ...(properties?.ok ? properties.fields : {}),
      ...careLabel,
      ...(product.ok && product.fields),
      ...(care.ok && care.fields),
      ...readReplaces(body),
      name: line(body.name),
      category,
      brand: line(body.brand),
      colors: colors.colors,
      size: normalizeSize(body.size ?? '') ?? null,
      notes: text(body.notes),
      washingDetails: text(body.washingDetails),
      acquiredOn,
    },
  };
}

/**
 * What a wishlist item replaces (null for nothing); nothing (left as
 * stored) unless the form was a wishlist form (GarmentBody.wishlist).
 */
function readReplaces(
  body: Pick<GarmentBody, 'wishlist' | 'replaces'>,
): Pick<GarmentFields, 'replacesGarmentId'> {
  return body.wishlist === '1'
    ? { replacesGarmentId: body.replaces || null }
    : {};
}

/** The messages for what a well-formed garment form can still get wrong. */
function formErrors(read: {
  category: string;
  colors: { errors: Translated[] };
  acquiredOn: IsoDate | null | undefined;
  properties: ReturnType<typeof readProperties> | undefined;
  product: ReturnType<typeof readProductFields>;
  care: ReturnType<typeof readCareFields>;
}): FieldErrors<GarmentField> {
  const errors: FieldErrors<GarmentField> = read.product.ok
    ? {}
    : { ...read.product.errors };
  if (!read.category) errors.category = [t('validation.CATEGORY_REQUIRED')];
  if (read.colors.errors.length > 0) errors.color = read.colors.errors;
  if (read.acquiredOn === undefined) {
    errors.dateAquired = [t('validation.INVALID_DATE')];
  }
  if (read.properties?.ok === false) {
    errors.fabricWeight = [read.properties.error];
  }
  if (!read.care.ok) errors.quantity = [read.care.error];
  return errors;
}
