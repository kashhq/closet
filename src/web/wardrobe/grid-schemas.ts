import { type Static, Type } from '@sinclair/typebox';
import {
  applyPresets,
  type Condition,
  type Fit,
  FITS,
  FORMALITIES,
  findType,
  GARMENT_COLORS,
  type Formality,
  type Length,
  LENGTHS,
  type Material,
  MATERIALS,
  type Pattern,
  PATTERNS,
  type PresetValues,
  propertyApplies,
  type Sleeve,
  SLEEVES,
  type Warmth,
  WARMTHS,
} from '../../wardrobe/properties';
import { CARE_WASH } from '../../wardrobe/care';
import { choice, OwnerQuery, pick, RowId } from '../schemas';
import { GridCursorParam } from './grid-cursor';
import {
  CATEGORY_MAX,
  ConditionValue,
  DraftsSaved,
  type GarmentPropertyFields,
  orEmpty,
  SIZE_MAX,
} from './garment-input';

/**
 * The grid's, bulk edit's and tagging mode's request schemas and readers
 * (the routes in routes.tsx; select-and-tag.md).
 */

// The grid's filters are navigation state from its own links, the search
// form and the filter modal. A colour outside GARMENT_COLORS is a 400: no
// garment can hold one.
const GridFilters = {
  keyword: Type.Optional(Type.String({ maxLength: 200 })),
  category: Type.Optional(Type.String({ maxLength: CATEGORY_MAX })),
  color: Type.Optional(
    Type.Union([
      Type.Literal(''),
      ...GARMENT_COLORS.map((color) => Type.Literal(color)),
    ]),
  ),
  size: Type.Optional(Type.String({ maxLength: SIZE_MAX })),
  // A type outside the chosen category is dropped (gridSearch); the scales
  // and the material are matched as stored values, so outside their sets
  // they are a 400 like a colour.
  type: Type.Optional(Type.String({ maxLength: 40 })),
  warmth: choice(WARMTHS),
  formality: choice(FORMALITIES),
  material: Type.Optional(
    Type.Union([
      Type.Literal(''),
      ...MATERIALS.map((material) => Type.Literal(material)),
    ]),
  ),
  // The care label's wash (#23), a stored value like the material.
  wash: choice(CARE_WASH),
  archived: Type.Optional(Type.String({ maxLength: 10 })),
  // 'true' filters, like archived: garments with a copy that needs a wash
  // (the owner's own wardrobe only: a share never reveals wears; gridSearch
  // drops it), and those whose condition is not good.
  needsWash: Type.Optional(Type.String({ maxLength: 10 })),
  attention: Type.Optional(Type.String({ maxLength: 10 })),
  // A capsule of the addressed wardrobe (src/web/capsules): a 400 when not
  // an id, a 404 when not one of the wardrobe's capsules (the route). Empty
  // is no scope (URL state: a hand-cleared `?capsule=` is the closet).
  capsule: Type.Optional(Type.Union([Type.Literal(''), RowId])),
};

/**
 * The longest `selected` a verb's redirect carries (about 400 ids); a
 * longer selection comes back unchecked rather than as a 400 (selectedParam).
 */
export const SELECTED_MAX_LENGTH = 4000;

export const GridQuery = Type.Object({
  ...OwnerQuery.properties,
  ...GridFilters,
  // Select mode: tiles are checkboxes of the bulk form. Navigation state.
  select: Type.Optional(Type.String({ maxLength: 5 })),
  // The capsule picker: select mode whose checkboxes are this capsule's
  // membership (POST /capsules/:id/garments). Owner and MANAGE only.
  pick: Type.Optional(RowId),
  // Select mode's selection after a verb (#677): the ids it acted on,
  // checked again (readIdList), or every garment of the filters ("Select
  // all N"). Navigation state.
  selected: Type.Optional(Type.String({ maxLength: SELECTED_MAX_LENGTH })),
  all: Type.Optional(Type.String({ maxLength: 5 })),
  // One-shot flags from select mode's verbs' redirects (the toast).
  bulkUpdated: Type.Optional(Type.Integer({ minimum: 0 })),
  bulkSkipped: Type.Optional(Type.Integer({ minimum: 0 })),
  // Mark washed's other skips (#819): wishlist items, and ids that are no
  // garment of the owner's.
  bulkWishlist: Type.Optional(Type.Integer({ minimum: 0 })),
  bulkUnseen: Type.Optional(Type.Integer({ minimum: 0 })),
  bulkArchived: Type.Optional(Type.Integer({ minimum: 0 })),
  bulkWashed: Type.Optional(Type.Integer({ minimum: 0 })),
  bulkAdded: Type.Optional(Type.Integer({ minimum: 0 })),
  // Select mode after a batch of drafts (#200): the garments it saved,
  // checked on the first page (readIdList; navigation state).
  checked: DraftsSaved,
});
export type GridQuery = Static<typeof GridQuery>;

/** The "load more" sentinel's request: the same filters, and where the last page ended. */
export const TilesQuery = Type.Object({
  ...GridQuery.properties,
  before: GridCursorParam,
});

/** The properties bulk edit can set: not type or weight, which are per garment. */
export const BULK_PROPERTIES = [
  'warmth',
  'formality',
  'materials',
  'pattern',
  'fit',
  'sleeve',
  'length',
  'waterResistant',
  'condition',
] as const;
export type BulkProperty = (typeof BULK_PROPERTIES)[number];

/**
 * POST /wardrobe/bulk: the selection (none is a no-op), the
 * property (the dialog's tab), and that property's value field, as the
 * garment form names it. The other tabs' fields may ride along and are
 * ignored. '' clears a property; materials add `material`.
 */
/**
 * What every select-mode verb posts (#677): the checked tiles' `ids`, or
 * `all=1` ("Select all N"), which means every garment of the filters in the
 * action's query and ignores `ids`. Neither is a no-op.
 */
const Selection = {
  ids: Type.Optional(Type.Array(RowId, { maxItems: 2000 })),
  all: Type.Optional(Type.Literal('1')),
};

/** Select mode's Archive and Mark washed: the selection alone. */
export const SelectionBody = Type.Object(Selection);
export type SelectionBody = Static<typeof SelectionBody>;

/** Select mode's "Add to capsule": the selection and the capsule. */
export const CapsuleBulkBody = Type.Object({
  ...Selection,
  capsuleId: RowId,
});
export type CapsuleBulkBody = Static<typeof CapsuleBulkBody>;

export const BulkBody = Type.Object({
  ...Selection,
  property: Type.Union(BULK_PROPERTIES.map((name) => Type.Literal(name))),
  warmth: choice(WARMTHS),
  formality: choice(FORMALITIES),
  material: Type.Optional(
    Type.Union(MATERIALS.map((material) => Type.Literal(material))),
  ),
  pattern: choice(PATTERNS),
  fit: choice(FITS),
  sleeve: choice(SLEEVES),
  length: choice(LENGTHS),
  waterResistant: Type.Optional(
    Type.Union([Type.Literal('true'), Type.Literal('false')]),
  ),
  // Never cleared: 'good' is the reset.
  condition: Type.Optional(ConditionValue),
});
export type BulkBody = Static<typeof BulkBody>;

/** One property's new value for every selected garment (bulkSetProperty). */
export type BulkChange =
  | { property: 'warmth'; value: Warmth | null }
  | { property: 'formality'; value: Formality | null }
  | { property: 'materials'; value: Material }
  | { property: 'pattern'; value: Pattern | null }
  | { property: 'fit'; value: Fit | null }
  | { property: 'sleeve'; value: Sleeve | null }
  | { property: 'length'; value: Length | null }
  | { property: 'waterResistant'; value: boolean }
  | { property: 'condition'; value: Condition };

// The field each bulk property's chips post.
const BULK_FIELDS: Record<BulkProperty, keyof BulkBody> = {
  warmth: 'warmth',
  formality: 'formality',
  materials: 'material',
  pattern: 'pattern',
  fit: 'fit',
  sleeve: 'sleeve',
  length: 'length',
  waterResistant: 'waterResistant',
  condition: 'condition',
};

/**
 * The change a bulk post asks for, or undefined when the chosen tab's
 * chips were left alone. A radio group with nothing picked posts no key at
 * all, which is not the "Not set" chip (the key with ''): reading the two
 * alike would clear the property on every selected garment when someone
 * switched tabs and tapped Apply without choosing.
 */
export function readBulkChange(body: BulkBody): BulkChange | undefined {
  return body[BULK_FIELDS[body.property]] === undefined
    ? undefined
    : bulkChangeOf(body);
}

/** The chosen tab's posted value as its change ('' is "Not set"). */
function bulkChangeOf(body: BulkBody): BulkChange | undefined {
  return BULK_CHANGES[body.property](body);
}

// Each bulk property's reader of its posted value.
const BULK_CHANGES: Record<
  BulkProperty,
  (body: BulkBody) => BulkChange | undefined
> = {
  warmth: (body) => ({
    property: 'warmth',
    value: pick(WARMTHS, orEmpty(body.warmth)),
  }),
  formality: (body) => ({
    property: 'formality',
    value: pick(FORMALITIES, orEmpty(body.formality)),
  }),
  // Added, never cleared: no value is no change.
  materials: (body) =>
    body.material ? { property: 'materials', value: body.material } : undefined,
  pattern: (body) => ({
    property: 'pattern',
    value: pick(PATTERNS, orEmpty(body.pattern)),
  }),
  fit: (body) => ({ property: 'fit', value: pick(FITS, orEmpty(body.fit)) }),
  sleeve: (body) => ({
    property: 'sleeve',
    value: pick(SLEEVES, orEmpty(body.sleeve)),
  }),
  length: (body) => ({
    property: 'length',
    value: pick(LENGTHS, orEmpty(body.length)),
  }),
  waterResistant: (body) => ({
    property: 'waterResistant',
    value: body.waterResistant === 'true',
  }),
  // Good is the reset: no value is no change.
  condition: (body) =>
    body.condition
      ? { property: 'condition', value: body.condition }
      : undefined,
};

/** GET /wardrobe/tag: the wardrobe, and where Next left off. */
export const TagQuery = Type.Object({
  ...OwnerQuery.properties,
  before: Type.Optional(RowId),
});

/**
 * POST /wardrobe/:id/tag: the tagging card's chips, posted whole on every
 * tap, and by Next with `next=1`. A field the card never showed or the user
 * never tapped is absent and leaves the stored value; a type outside the
 * garment's category is a 400 (the card only offers its own).
 */
export const TagBody = Type.Object({
  type: Type.Optional(Type.String({ maxLength: 40 })),
  warmth: choice(WARMTHS),
  formality: choice(FORMALITIES),
  next: Type.Optional(Type.Literal('1')),
});
export type TagBody = Static<typeof TagBody>;

/** What the tagging card reads and writes of a garment. */
type Taggable = Pick<
  GarmentPropertyFields,
  | 'type'
  | 'warmth'
  | 'formality'
  | 'sleeve'
  | 'length'
  | 'waterResistant'
  | 'fabricWeight'
> & { category: string };

/**
 * What a post of the tagging card changes, or undefined for a type the
 * category does not have: only the fields whose value differs from the
 * stored one, so a post that changes nothing (Next on a card nobody
 * touched, whose checked chips are posted all the same) writes nothing.
 * The tapped values replace the stored ones; a **new** type brings its
 * presets into properties still unset or still at the stored type's
 * presets (applyPresets from the stored type): the first tag never
 * overwrites what the garment form set, the heavy tee's warmth included,
 * and changing one's mind about the type moves what the first type
 * filled. The same type posted again brings nothing: its presets had their
 * chance when it was chosen, and a property left unset since is the
 * person's to fill. Properties outside the garment's role stay as stored.
 */
export function readTags(
  body: TagBody,
  stored: Taggable,
): Partial<GarmentPropertyFields> | undefined {
  const { category } = stored;
  const type = body.type ? findType(category, body.type)?.value : stored.type;
  if (type === undefined) return undefined;
  // A value for a property the role lacks (never on the card) is ignored;
  // presets only fill properties the role has (the type table's rule).
  const tapped = (property: 'warmth' | 'formality', posted?: string) =>
    posted !== undefined && propertyApplies(property, category)
      ? posted
      : undefined;
  const warmth = tapped('warmth', body.warmth);
  const formality = tapped('formality', body.formality);
  const current: PresetValues = {
    warmth: warmth === undefined ? stored.warmth : pick(WARMTHS, warmth),
    formality:
      formality === undefined ? stored.formality : pick(FORMALITIES, formality),
    sleeve: stored.sleeve,
    length: stored.length,
    waterResistant: stored.waterResistant,
  };
  // From the stored type: a tap on another type moves the values still at
  // the first type's presets (the card saves every tap, so they are
  // stored); the first tag has no source and fills only what is unset. The
  // same rule as the form's hidden presetType.
  const source =
    stored.type === null
      ? null
      : { category, type: stored.type, fabricWeight: stored.fabricWeight };
  const next =
    type === stored.type
      ? current
      : applyPresets(current, source, {
          category,
          type,
          fabricWeight: stored.fabricWeight,
        });
  const all = { type, ...next };
  return Object.fromEntries(
    Object.entries(all).filter(
      ([field, value]) => value !== stored[field as keyof typeof all],
    ),
  );
}
