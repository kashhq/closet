import { CloneType, type Static, type TSchema, Type } from '@sinclair/typebox';
import {
  NEVER_WASH,
  QUANTITY_MAX,
  WASH_AFTER_CHOICES,
} from '../../wardrobe/availability';
import {
  CARE_BLEACH,
  CARE_DRY,
  CARE_DRY_CLEAN,
  CARE_IRON,
  CARE_WASH,
  REPAIR_KINDS,
} from '../../wardrobe/care';
import {
  CONDITIONS,
  FITS,
  FORMALITIES,
  GARMENT_COLORS,
  LENGTHS,
  MATERIALS,
  PATTERNS,
  SLEEVES,
  WARMTHS,
} from '../../wardrobe/properties';
import { ENTRY_STATUSES, type EntryStatus } from '../../wardrobe/status';
import { refusedBody } from '../api/refused-body';
import { literals, Nullable } from '../api/resource';
import type { FieldErrors } from '../auth/validation';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { IsoDateSchema, ROW_ID_MAX, RowId } from '../schemas';
import type { GarmentChanges, PropertyChanges } from './garment-changes';
import {
  BRAND_MAX,
  CARE_NOTE_MAX,
  CATEGORY_MAX,
  type GarmentField,
  NAME_MAX,
  SIZE_MAX,
  SOURCE_URL_MAX,
  TEXT_MAX,
} from './garment-input';
import { OWNED_STATUSES } from './garment-actions';
import type { BulkChange, TagBody } from './grid-schemas';
import { LINK_INPUT_MAX } from './link-import/link-text';
import type { RepairField } from './repairs';
import type { RotateDirection } from './writes';

/**
 * The API's garment write bodies (#192b; docs/plans/2026-11-12-json-api.md
 * section 6): JSON shaped as the Garment resource reads
 * (garment-resource.ts: `properties`, `careLabel`, `care`), each mapped to
 * what the page's own writer takes. A garment's fields become
 * GarmentChanges (garment-changes.ts, shared with MCP's update_garment),
 * so they are saved by the garment form's rules; absent leaves a field,
 * null clears it.
 */

const text = (maxLength: number, description?: string) =>
  Nullable(Type.String({ maxLength }), { description });

/** Money as a client sends it: dollars, at most two decimals (numeric(10, 2)). */
export const MoneyInput = Type.String({
  pattern: '^\\d{1,8}(\\.\\d{1,2})?$',
  description: 'A decimal amount in the household currency, e.g. "49.90"',
});

const PropertiesInput = Type.Object(
  {
    type: Nullable(Type.String({ maxLength: 40 }), {
      description:
        "A type of the garment's category; a new one presets warmth, formality, sleeve and length where they were unset or still at the old type's",
    }),
    warmth: Nullable(literals(WARMTHS)),
    formality: Nullable(literals(FORMALITIES)),
    materials: Nullable(
      Type.Array(literals(MATERIALS), { maxItems: MATERIALS.length }),
      {
        description:
          "The whole set; new materials preset the care label where it was unset or still at the old materials' care",
      },
    ),
    pattern: Nullable(literals(PATTERNS)),
    fit: Nullable(literals(FITS)),
    sleeve: Nullable(literals(SLEEVES)),
    length: Nullable(literals(LENGTHS)),
    fabricWeightGsm: Nullable(Type.Integer({ minimum: 1, maximum: 10_000 })),
    waterResistant: Type.Optional(Type.Boolean()),
  },
  {
    title: 'GarmentPropertiesInput',
    description:
      "A property the garment's role does not have (a sleeve on shoes) is not kept",
  },
);

const CareLabelInput = Type.Object(
  {
    wash: Nullable(literals(CARE_WASH)),
    bleach: Nullable(literals(CARE_BLEACH)),
    dry: Nullable(literals(CARE_DRY)),
    iron: Nullable(literals(CARE_IRON)),
    dryClean: Nullable(literals(CARE_DRY_CLEAN)),
    notes: text(TEXT_MAX),
  },
  { title: 'CareLabelInput' },
);

const CareInput = Type.Object(
  {
    washAfterWears: Nullable(literals([NEVER_WASH, ...WASH_AFTER_CHOICES]), {
      description: "Wears before a wash; 0 never, null the role's default",
    }),
  },
  {
    title: 'GarmentCareInput',
    description: "The owner's own: ignored on a wardrobe shared with you",
  },
);

/** Every field a garment write may set but the category. */
const fields = {
  name: text(NAME_MAX),
  brand: text(BRAND_MAX),
  colors: Type.Optional(
    Type.Array(literals(GARMENT_COLORS), {
      maxItems: GARMENT_COLORS.length,
      description: 'The whole set; [] clears it',
    }),
  ),
  size: text(SIZE_MAX, 'As on the label (XL is stored as X-Large)'),
  notes: text(TEXT_MAX),
  price: Nullable(MoneyInput, { description: 'What one copy cost' }),
  acquiredOn: Nullable(IsoDateSchema),
  sourceUrl: text(SOURCE_URL_MAX, 'An http(s) link to the product'),
  quantity: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: QUANTITY_MAX,
      description: 'Identical copies',
    }),
  ),
  condition: Type.Optional(literals(CONDITIONS)),
  conditionNote: text(
    CARE_NOTE_MAX,
    'What is wrong: kept only while the condition is not good',
  ),
  properties: Type.Optional(PropertiesInput),
  careLabel: Type.Optional(CareLabelInput),
  care: Type.Optional(CareInput),
};

const Category = (options: { minLength?: number } = {}) =>
  Type.String({
    ...options,
    maxLength: CATEGORY_MAX,
    description:
      'tops, bottoms, dresses, outerwear, footwear, accessories, bags, other, or your own; a new role drops the properties it does not have',
  });

/** PATCH /garments/{id}: only what changes. */
export const GarmentPatch = Type.Object(
  { category: Type.Optional(Category({ minLength: 1 })), ...fields },
  {
    title: 'GarmentPatch',
    description:
      'Absent leaves a field as stored, null clears it; a category is never cleared',
  },
);
export type GarmentPatch = Static<typeof GarmentPatch>;

const Destination = Type.Optional(literals(ENTRY_STATUSES));

const ReplacesGarmentId = Type.Optional(
  CloneType(RowId, {
    description:
      "The garment of this wardrobe a wishlist item would replace: `destination` wishlist only (another wardrobe's is not stored)",
  }),
);

/**
 * `?ownerId=`: a wardrobe shared with the caller; absent, their own. Every
 * share-aware garment route's query, the owner-only records' too (wears,
 * washes, away: a grantee naming the owner is a 403, plan section 2).
 */
export const OwnerId = Type.Optional(
  Type.Integer({
    minimum: 1,
    maximum: ROW_ID_MAX,
    description:
      "A wardrobe shared with you (its owner's id); absent, your own",
  }),
);

export const GarmentQuery = Type.Object({ ownerId: OwnerId });

/**
 * POST /garments: a new garment without a photo (the photo is its own
 * upload). `clientId` is the offline create's (plan section 2), stored on
 * the row (createGarmentOnce): a retry answers the first row.
 */
export const NewGarment = Type.Object(
  {
    category: Category(),
    ...fields,
    destination: Destination,
    replacesGarmentId: ReplacesGarmentId,
    boughtForNeedId: Type.Optional(
      CloneType(RowId, {
        description:
          '"Bought a different one": your own Muse need this closet garment was bought for instead of its options, settled by it in the same write. A need settled or set aside is a 404, one settled meanwhile a 409; `destination` closet only',
      }),
    ),
    clientId: Type.Optional(
      Type.String({
        format: 'uuid',
        description:
          'Your id for this create, for retrying it offline: a retry answers the first garment of that id (200), the id of one deleted since is a 410',
      }),
    ),
  },
  {
    title: 'NewGarment',
    description:
      "Lands in the closet unless `destination` says the wishlist. Saved by the garment form's rules (a new type brings its presets)",
  },
);
export type NewGarment = Static<typeof NewGarment>;

/** POST /garments/{id}/clones: the source's fields, with these changed. */
export const GarmentClone = Type.Union(
  [
    Type.Object(
      { category: Type.Optional(Category({ minLength: 1 })), ...fields },
      {
        title: 'GarmentClone',
        description:
          'What differs from the source; an absent field keeps its value, but an absent name becomes "<the source\'s name> (cloned)"',
      },
    ),
    Type.Null(),
  ],
  { description: 'None: a copy of the source as it is' },
);

/** The body's garment fields as GarmentChanges (garment-changes.ts). */
export function garmentChangesOf(
  body: Omit<GarmentPatch, 'category'> & { category?: string },
): GarmentChanges {
  const { properties = {}, careLabel = {}, care = {} } = body;
  return {
    name: body.name,
    category: body.category,
    brand: body.brand,
    colors: body.colors,
    size: body.size,
    notes: body.notes,
    price: body.price,
    acquiredOn: body.acquiredOn,
    sourceUrl: body.sourceUrl,
    quantity: body.quantity,
    condition: body.condition,
    conditionNote: body.conditionNote,
    washAfterWears: care.washAfterWears,
    careNotes: careLabel.notes,
    type: properties.type,
    warmth: properties.warmth,
    formality: properties.formality,
    materials: properties.materials,
    pattern: properties.pattern,
    fit: properties.fit,
    sleeve: properties.sleeve,
    length: properties.length,
    fabricWeightGsm: properties.fabricWeightGsm,
    waterResistant: properties.waterResistant,
    careWash: careLabel.wash,
    careBleach: careLabel.bleach,
    careDry: careLabel.dry,
    careIron: careLabel.iron,
    careDryClean: careLabel.dryClean,
  };
}

/** A change's property name where the body put it (`properties.sleeve`, `careLabel.wash`). */
const PATH_OF_PROPERTY: Record<keyof PropertyChanges, string> = {
  type: 'properties.type',
  warmth: 'properties.warmth',
  formality: 'properties.formality',
  materials: 'properties.materials',
  pattern: 'properties.pattern',
  fit: 'properties.fit',
  sleeve: 'properties.sleeve',
  length: 'properties.length',
  fabricWeightGsm: 'properties.fabricWeightGsm',
  waterResistant: 'properties.waterResistant',
  careWash: 'careLabel.wash',
  careBleach: 'careLabel.bleach',
  careDry: 'careLabel.dry',
  careIron: 'careLabel.iron',
  careDryClean: 'careLabel.dryClean',
};

export function ignoredPaths(names: (keyof PropertyChanges)[]): string[] {
  return names.map((name) => PATH_OF_PROPERTY[name]);
}

/** A form field readGarmentForm refused, where the JSON body holds it. */
const POINTER_OF_FIELD: Record<GarmentField, string> = {
  category: '/category',
  color: '/colors',
  dateAquired: '/acquiredOn',
  fabricWeight: '/properties/fabricWeightGsm',
  sourceUrl: '/sourceUrl',
  price: '/price',
  // Never posted by the API (a garment's photo is its own upload).
  linkPhoto: '',
  quantity: '/quantity',
};

/** The garment form's refusal as the API's 400 (refusedBody). */
export function refusedGarmentBody(
  errors: FieldErrors<GarmentField>,
): HttpError {
  return refusedBody(errors, POINTER_OF_FIELD);
}

/**
 * A wishlist item's replaced garment, given for anywhere else: a 400
 * naming the field (POST /garments, POST /garments/link-imports).
 */
export function refuseReplacesOffWishlist(
  destination: EntryStatus,
  replacesGarmentId: number | undefined,
): void {
  if (replacesGarmentId === undefined || destination === 'wishlist') return;
  const message = t('api.REPLACES_ON_WISHLIST_ONLY');
  throw new HttpError(400, message, {
    validation: [{ path: 'body/replacesGarmentId', message }],
  });
}

/**
 * A need bought for, given for a wishlist item: a 400 naming the field
 * (POST /garments). "Bought a different one" puts a garment in the closet.
 */
export function refuseBoughtForOffCloset(
  destination: EntryStatus,
  boughtForNeedId: number | undefined,
): void {
  if (boughtForNeedId === undefined || destination === 'closet') return;
  const message = t('api.BOUGHT_FOR_IN_CLOSET_ONLY');
  throw new HttpError(400, message, {
    validation: [{ path: 'body/boughtForNeedId', message }],
  });
}

/** PUT /garments/{id}/status (putGarmentStatus). */
export const StatusInput = Type.Object(
  {
    status: literals(OWNED_STATUSES),
  },
  { title: 'GarmentStatusInput' },
);

/** PUT /garments/{id}/condition: the garment page's condition control. */
export const ConditionInput = Type.Object(
  {
    condition: literals(CONDITIONS),
    conditionNote: text(
      CARE_NOTE_MAX,
      'What is wrong: kept only while the condition is not good',
    ),
  },
  { title: 'GarmentConditionInput' },
);

/** POST /garments/{id}/copies: how many more identical copies. */
export const CopiesInput = Type.Union([
  Type.Object(
    {
      copies: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: QUANTITY_MAX - 1,
          // Not a schema default: ajv ignores one inside anyOf (the handler's `?? 1`).
          description: 'How many more: 1 unless sent',
        }),
      ),
    },
    { title: 'GarmentCopiesInput' },
  ),
  Type.Null(),
]);

/**
 * PATCH /garments/{id}/tags: the tagging card's tap. Only what differs is
 * written; a new type's presets fill what is unset or at the old type's.
 */
export const TagsInput = Type.Object(
  {
    type: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 40,
        description: "A type of the garment's category",
      }),
    ),
    warmth: Nullable(literals(WARMTHS)),
    formality: Nullable(literals(FORMALITIES)),
  },
  { title: 'GarmentTagsInput' },
);

/** A chip as the card posts it: absent untouched, '' the reset chip. */
function chip<T extends number>(
  value: T | null | undefined,
): `${T}` | '' | undefined {
  if (value === undefined) return undefined;
  return value === null ? '' : `${value}`;
}

/** The tap as the tagging card posts it. */
export function tagBodyOf(
  input: Static<typeof TagsInput>,
): Omit<TagBody, 'next'> {
  return {
    type: input.type,
    warmth: chip(input.warmth),
    formality: chip(input.formality),
  };
}

const BulkIds = Type.Array(RowId, {
  maxItems: 2000,
  description:
    'The garments to change; one this wardrobe does not hold, or whose role lacks the property, is skipped',
});

/** One property and its value for every garment named. */
const bulk = <P extends string, V extends TSchema>(property: P, value: V) =>
  Type.Object({ ids: BulkIds, property: Type.Literal(property), value });

/** PATCH /garments: select mode's "Set…" (bulkSetProperty). */
export const BulkInput = Type.Union(
  [
    bulk('warmth', Type.Union([literals(WARMTHS), Type.Null()])),
    bulk('formality', Type.Union([literals(FORMALITIES), Type.Null()])),
    bulk('materials', literals(MATERIALS)),
    bulk('pattern', Type.Union([literals(PATTERNS), Type.Null()])),
    bulk('fit', Type.Union([literals(FITS), Type.Null()])),
    bulk('sleeve', Type.Union([literals(SLEEVES), Type.Null()])),
    bulk('length', Type.Union([literals(LENGTHS), Type.Null()])),
    bulk('waterResistant', Type.Boolean()),
    bulk('condition', literals(CONDITIONS)),
  ],
  {
    title: 'GarmentsBulkInput',
    description:
      'Sets one property on many garments: null clears it; materials adds one',
  },
);

/** The body's change (BulkChange: the page's reader answers the same shape). */
export function bulkChangeOf({ ids, ...change }: Static<typeof BulkInput>): {
  ids: number[];
  change: BulkChange;
} {
  return { ids, change };
}

/** PUT /garments/{id}/photo: the photo sheet's upload, as multipart parts. */
export const PhotoUpload = Type.Object(
  {
    photo: Type.String({
      format: 'binary',
      description:
        'JPEG, PNG, WebP, HEIC or AVIF, at most 64 megapixels; stored at 1080 px',
    }),
  },
  { title: 'GarmentPhotoUpload' },
);

/** PUT /garments/{id}/photo/cutout: the mask editor's save, as multipart parts. */
export const CutoutUpload = Type.Object(
  {
    cutout: Type.String({
      format: 'binary',
      description:
        "The garment on a transparent background (a PNG with alpha), the original photo's size",
    }),
  },
  { title: 'GarmentCutoutUpload' },
);

/** POST /garments/{id}/photo/rotations: the photo sheet's quarter turn. */
export const RotateInput = Type.Object(
  {
    direction: literals<RotateDirection>(['left', 'right']),
  },
  {
    title: 'GarmentPhotoRotation',
    description: 'A quarter turn: left anticlockwise, right clockwise',
  },
);

/** POST /garments/{id}/repairs: the repair log's entry, as its form takes it. */
export const RepairInput = Type.Object(
  {
    day: Type.String({
      format: 'date',
      description: 'The household day it was done: today or before',
    }),
    kind: literals(REPAIR_KINDS),
    note: Type.String({
      minLength: 1,
      maxLength: CARE_NOTE_MAX,
      description: 'What was done',
    }),
    cost: Type.Optional(MoneyInput),
  },
  { title: 'RepairInput' },
);

/** A repair form field readRepairForm refused, where the JSON body holds it. */
const POINTER_OF_REPAIR_FIELD: Record<RepairField, string> = {
  day: '/day',
  note: '/note',
  cost: '/cost',
};

/** The repair form's refusal as the API's 400 (a day after today, a blank note). */
export function refusedRepairBody(errors: FieldErrors<RepairField>): HttpError {
  return refusedBody(errors, POINTER_OF_REPAIR_FIELD);
}

/**
 * POST /garments/link-imports: the link, and what the caller says instead
 * of the page (MCP's add_garment_from_link takes the same).
 */
export const LinkImportInput = Type.Object(
  {
    url: Type.String({
      minLength: 1,
      maxLength: LINK_INPUT_MAX,
      description:
        'A product page or an image, http(s); text around the link (a share sheet\'s "Title https://…") is read for it',
    }),
    destination: Destination,
    replacesGarmentId: ReplacesGarmentId,
    name: Type.Optional(Type.String({ maxLength: NAME_MAX })),
    category: Type.Optional(Category({ minLength: 1 })),
    properties: Type.Optional(
      Type.Object(
        {
          type: Type.Optional(
            Type.String({
              maxLength: 40,
              description:
                'A type of the category; it presets warmth, formality, sleeve and length',
            }),
          ),
        },
        { title: 'LinkImportProperties' },
      ),
    ),
    size: Type.Optional(Type.String({ maxLength: SIZE_MAX })),
    price: Type.Optional(MoneyInput),
    notes: Type.Optional(Type.String({ maxLength: TEXT_MAX })),
  },
  {
    title: 'LinkImportInput',
    description:
      "Lands in the closet unless `destination` says the wishlist. Any field given replaces what the page says (give `category` when the page does not make it clear; an image link never does); the rest is the link import's prefill, saved by the garment form's rules",
  },
);
export type LinkImportInput = Static<typeof LinkImportInput>;
