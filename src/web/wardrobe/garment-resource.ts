import { type Static, Type } from '@sinclair/typebox';
import { CUTOUT_STATUSES, showsCutout } from '../../cutout/state';
import { AWAY_REASONS } from '../../wardrobe/availability';
import {
  CARE_BLEACH,
  CARE_DRY,
  CARE_DRY_CLEAN,
  CARE_IRON,
  CARE_WASH,
  REPAIR_KINDS,
} from '../../wardrobe/care';
import { perWearCost, totalCost } from '../../wardrobe/insights';
import {
  categoryRole,
  CONDITIONS,
  FITS,
  FORMALITIES,
  GARMENT_COLORS,
  GARMENT_ROLES,
  LENGTHS,
  MATERIALS,
  PATTERNS,
  SLEEVES,
  WARMTHS,
} from '../../wardrobe/properties';
import { GARMENT_STATUSES } from '../../wardrobe/status';
import { asResource, literals } from '../api/resource';
import { shownPhoto } from './cutout-shown';
import { imageUrl } from '../files/image-url';
import { IsoDateSchema } from '../schemas';
import { PublicShareUrl, publicShareUrl } from '../share/urls';
import type { GarmentContext } from './garment-context';
import type {
  GarmentDetail,
  GarmentPhoto,
  GarmentSummary,
  SyncedGarmentRow,
} from './queries';
import type { RepairEntry } from './repairs';
import type { SwappedCutout } from './writes';
import {
  type AgentLabel,
  AgentResource,
  toAgentResource,
} from '../write-origin';

/**
 * The API's garment resources (#192a; docs/plans/2026-11-12-json-api.md
 * section 2), mapped from what the pages read: a list's summary
 * (searchGarments) and the garment in full (requireGarment and
 * garmentContext, the garment page's own reads). camelCase, null fields left
 * out, money a decimal string, a day `YYYY-MM-DD`. Each resource is a
 * record with its nulls kept (`garmentRecord`, `garmentListRecord`), which
 * the API sends through asResource and MCP's garment tools project
 * (nulls kept: an agent reads "null"; src/web/mcp/tools/garments.ts).
 */

const MONEY_PATTERN = '^\\d+\\.\\d{2}$';

/** An amount as every resource answers it (the wishlist's too). */
export const Money = Type.String({
  pattern: MONEY_PATTERN,
  description: 'A decimal amount in the household currency',
});

/** Said on the price and the notes: the `private` capability (#680). */
const NEVER_TO_VIEW =
  'never to a VIEW share, which gets the garment without it';

/** A garment's price where it is answered (garments, the wishlist, the feed). */
export const PrivatePrice = Type.String({
  pattern: MONEY_PATTERN,
  description: `In the household currency, one copy's (a wishlist item's as listed); ${NEVER_TO_VIEW}`,
});

export const GarmentPhotoResource = Type.Object(
  {
    cutoutStatus: literals(CUTOUT_STATUSES),
    /** Bumped by every new photo set; the URLs carry it. */
    version: Type.Integer(),
    originalUrl: Type.String(),
    /** 400 px, from the cutout when it shows. */
    thumbUrl: Type.String(),
    /** Only while the cutout shows (showsCutout): pending, failed and unwanted have none. */
    cutoutUrl: Type.Optional(Type.String()),
  },
  {
    title: 'GarmentPhoto',
    description:
      "A garment's photo: signed /file URLs, relative to the server, immutable (a new photo, cutout or turn is a new URL). Never build or edit one",
  },
);

/** A garment's photo as the API shows it (also the mask editor's save's answer). */
export function toGarmentPhoto(
  photo: GarmentPhoto,
): Static<typeof GarmentPhotoResource> {
  return {
    cutoutStatus: photo.cutoutStatus,
    version: photo.version,
    originalUrl: imageUrl(photo, 'original'),
    thumbUrl: imageUrl(photo, 'thumb'),
    ...(showsCutout(photo.cutoutStatus) && {
      cutoutUrl: imageUrl(photo, 'nobg'),
    }),
  };
}

/** What every garment resource says it is. */
const identity = {
  id: Type.Integer(),
  name: Type.Optional(Type.String()),
  category: Type.String(),
  role: literals(GARMENT_ROLES),
  status: literals(GARMENT_STATUSES),
  brand: Type.Optional(Type.String()),
  colors: Type.Array(literals(GARMENT_COLORS)),
  size: Type.Optional(Type.String()),
  price: Type.Optional(PrivatePrice),
  quantity: Type.Integer({ minimum: 1 }),
  condition: literals(CONDITIONS),
  photo: Type.Optional(GarmentPhotoResource),
  photoMissingSince: Type.Optional(
    Type.String({
      format: 'date-time',
      description:
        'Since when nothing of the photo is stored (a database restored ahead of its photos): `photo` is then absent, and comes back with its bytes',
    }),
  ),
};

export const GarmentListItem = Type.Object(
  {
    ...identity,
    type: Type.Optional(Type.String()),
    warmth: Type.Optional(literals(WARMTHS)),
    formality: Type.Optional(literals(FORMALITIES)),
  },
  {
    title: 'GarmentListItem',
    description:
      'A garment as a list shows it: GET /garments/{id} has the rest',
  },
);
type GarmentListItem = Static<typeof GarmentListItem>;

/** A list's garment, nulls kept: the API's GarmentListItem, search_garments' hits. */
export function garmentListRecord(
  summary: GarmentSummary,
  cutoutsEnabled: boolean,
) {
  return {
    id: summary.id,
    name: summary.name,
    category: summary.category,
    role: categoryRole(summary.category),
    status: summary.status,
    brand: summary.brand,
    colors: summary.colors ?? [],
    size: summary.size,
    price: summary.price,
    quantity: summary.quantity,
    condition: summary.condition,
    photo:
      summary.photo &&
      toGarmentPhoto(shownPhoto(summary.photo, cutoutsEnabled)),
    photoMissingSince: summary.photoMissingSince?.toISOString() ?? null,
    type: summary.type,
    warmth: summary.warmth,
    formality: summary.formality,
  };
}
export type GarmentListRecord = ReturnType<typeof garmentListRecord>;

export function toGarmentListItem(
  summary: GarmentSummary,
  cutoutsEnabled: boolean,
): GarmentListItem {
  return asResource(
    GarmentListItem,
    garmentListRecord(summary, cutoutsEnabled),
  );
}

const Properties = Type.Object(
  {
    type: Type.Optional(Type.String()),
    warmth: Type.Optional(literals(WARMTHS)),
    formality: Type.Optional(literals(FORMALITIES)),
    materials: Type.Array(literals(MATERIALS)),
    pattern: Type.Optional(literals(PATTERNS)),
    fit: Type.Optional(literals(FITS)),
    sleeve: Type.Optional(literals(SLEEVES)),
    length: Type.Optional(literals(LENGTHS)),
    fabricWeightGsm: Type.Optional(Type.Integer()),
    waterResistant: Type.Boolean(),
  },
  { title: 'GarmentProperties' },
);

const CareLabel = Type.Object(
  {
    wash: Type.Optional(literals(CARE_WASH)),
    bleach: Type.Optional(literals(CARE_BLEACH)),
    dry: Type.Optional(literals(CARE_DRY)),
    iron: Type.Optional(literals(CARE_IRON)),
    dryClean: Type.Optional(literals(CARE_DRY_CLEAN)),
    notes: Type.Optional(Type.String()),
  },
  { title: 'CareLabel' },
);

/** The owner's care records as stored on the garment (a wash, "Where it is"). */
const storedCare = {
  /** Absent: the role's default; 0: never washed. */
  washAfterWears: Type.Optional(Type.Integer({ minimum: 0 })),
  lastWashedOn: Type.Optional(IsoDateSchema),
  /** When on lastWashedOn, if known (#676): a wear that day after it counts toward the next wash. */
  washedAt: Type.Optional(
    Type.String({
      format: 'date-time',
      description:
        'When on `lastWashedOn` it was washed, if known: a wear that day after it counts toward the next wash; absent, every wear that day counts before it',
    }),
  ),
  away: Type.Optional(literals(AWAY_REASONS)),
  awayNote: Type.Optional(Type.String()),
};

const OwnerCare = Type.Object(
  {
    ...storedCare,
    worn: Type.Integer({ minimum: 0 }),
    wornSinceWash: Type.Integer({ minimum: 0 }),
    lastWorn: Type.Optional(IsoDateSchema),
    /** Price per piece × copies, plus its repairs; absent without a price. */
    cost: Type.Optional(Money),
    /** `cost` over the days worn; absent until worn. */
    costPerWear: Type.Optional(Money),
  },
  {
    title: 'GarmentCare',
    description:
      "The owner's own records of how it is worn: only on their own wardrobe",
  },
);

const StoredCare = Type.Object(storedCare, {
  title: 'SyncedGarmentCare',
  description:
    "The owner's own care records as stored: only on their own wardrobe. What the wears and repairs add up to is the client's to derive",
});

const Repair = Type.Object(
  {
    id: Type.Integer(),
    day: IsoDateSchema,
    kind: literals(REPAIR_KINDS),
    note: Type.String(),
    cost: Type.Optional(Money),
  },
  { title: 'Repair' },
);

/**
 * A garment's public link as a reader is shown it (#959): only to whoever
 * may stop it, the owner and a MANAGE grantee, as its page's "Shared
 * publicly" panel; null while not shared.
 */
export function garmentShareUrl(
  shareableId: string | null,
  canManage: boolean,
  siteUrl: string,
): string | null {
  return shareableId !== null && canManage
    ? publicShareUrl(siteUrl, 'garment', shareableId)
    : null;
}

/** A garment's stored fields beyond its identity: the page's and the feed's. */
const recordFields = {
  ...identity,
  notes: Type.Optional(
    Type.String({ description: `The owner's notes; ${NEVER_TO_VIEW}` }),
  ),
  acquiredOn: Type.Optional(IsoDateSchema),
  /** A wishlist item's (or a bought one's) garment it replaces. */
  replacesGarmentId: Type.Optional(Type.Integer()),
  sourceUrl: Type.Optional(Type.String()),
  conditionNote: Type.Optional(Type.String()),
  properties: Properties,
  careLabel: CareLabel,
  /** The owner's repair and alteration log: only on their own wardrobe. */
  repairs: Type.Optional(Type.Array(Repair)),
  agent: Type.Optional(AgentResource),
  publicShareUrl: Type.Optional(PublicShareUrl),
};

export const Garment = Type.Object(
  {
    ...recordFields,
    capsules: Type.Array(
      Type.Object(
        { id: Type.Integer(), name: Type.String() },
        { title: 'CapsuleRef' },
      ),
    ),
    care: Type.Optional(OwnerCare),
  },
  {
    title: 'Garment',
    description:
      "A garment in full, as its page shows it. `care` and `repairs` are the owner's own records, never a grantee's to read",
  },
);
type Garment = Static<typeof Garment>;

/**
 * The changes feed's garment (#196b-1, GET /changes): its stored fields
 * only. A wear or a capsule's change never moves the garment's revision,
 * so what the page derives from them (worn, since the wash, last worn,
 * cost per wear, its capsules) would go stale in a synced copy; the
 * client derives them from the feed's wears and capsules (decisions
 * 2026-11-13, the feed's garment).
 */
export const SyncedGarment = Type.Object(
  { ...recordFields, care: Type.Optional(StoredCare) },
  {
    title: 'SyncedGarment',
    description:
      "A garment as the changes feed carries it: what is stored on it, nothing derived from its wears or capsules. `care` and `repairs` are the owner's own records, never a grantee's to read",
  },
);

/**
 * What a garment page's answer and the feed's share, nulls kept. The
 * owner's records are undefined where the reader read none (a grantee's),
 * so no surface can answer them, not even as null.
 */
function recordOf(
  garment: GarmentDetail,
  repairs: RepairEntry[] | undefined,
  agent: AgentLabel | null,
  cutoutsEnabled: boolean,
  shareUrl: string | null,
) {
  // Absent where the reader lacks `private` (#680): left out, never null.
  const { price, notes } = garment;
  return {
    id: garment.id,
    name: garment.name,
    category: garment.category,
    role: categoryRole(garment.category),
    status: garment.status,
    brand: garment.brand,
    colors: garment.colors ?? [],
    size: garment.size,
    price,
    quantity: garment.quantity,
    condition: garment.condition,
    photo:
      garment.photo &&
      toGarmentPhoto(shownPhoto(garment.photo, cutoutsEnabled)),
    photoMissingSince: garment.photoMissingSince?.toISOString() ?? null,
    notes,
    acquiredOn: garment.acquiredOn,
    replacesGarmentId: garment.replacesGarmentId,
    sourceUrl: garment.sourceUrl,
    conditionNote: garment.conditionNote,
    properties: {
      type: garment.type,
      warmth: garment.warmth,
      formality: garment.formality,
      materials: garment.materials ?? [],
      pattern: garment.pattern,
      fit: garment.fit,
      sleeve: garment.sleeve,
      length: garment.length,
      fabricWeightGsm: garment.fabricWeight,
      waterResistant: garment.waterResistant,
    },
    careLabel: {
      wash: garment.careWash,
      bleach: garment.careBleach,
      dry: garment.careDry,
      iron: garment.careIron,
      dryClean: garment.careDryClean,
      notes: garment.washingDetails,
    },
    repairs,
    agent: toAgentResource(agent),
    publicShareUrl: shareUrl,
  };
}

/**
 * The garment in full, from its page's reads, nulls kept: the owner's
 * records only where garmentContext read them (`own`: the owner of an
 * owned garment), so a grantee's answer cannot hold them. `shareUrl` is
 * the public link as the reader is shown it (garmentShareUrl). The API's
 * Garment (toGarmentResource) and MCP's get_garment.
 */
export function garmentRecord(
  garment: GarmentDetail,
  context: GarmentContext,
  cutoutsEnabled: boolean,
  shareUrl: string | null,
) {
  const { own } = context;
  return {
    ...recordOf(
      garment,
      own?.repairs.entries,
      context.agent,
      cutoutsEnabled,
      shareUrl,
    ),
    capsules: context.capsules
      .filter((capsule) => capsule.member)
      .map(({ id, name }) => ({ id, name })),
    care: own && ownerCare(garment, own.wear),
  };
}
export type GarmentRecord = ReturnType<typeof garmentRecord>;

export function toGarmentResource(
  garment: GarmentDetail,
  context: GarmentContext,
  cutoutsEnabled: boolean,
  shareUrl: string | null,
): Garment {
  return asResource(
    Garment,
    garmentRecord(garment, context, cutoutsEnabled, shareUrl),
  );
}

/**
 * The feed's garment (garmentsByIds): the owner's records only where the
 * reader read them (`repairs`, null for a grantee's), so a grantee's
 * answer cannot hold them; the public link only where they may manage it.
 */
export function toSyncedGarment(
  garment: SyncedGarmentRow,
  cutoutsEnabled: boolean,
  siteUrl: string,
): Static<typeof SyncedGarment> {
  return asResource(SyncedGarment, {
    ...recordOf(
      garment,
      garment.repairs ?? undefined,
      garment.agent,
      cutoutsEnabled,
      garmentShareUrl(garment.shareableId, garment.viewerManages, siteUrl),
    ),
    care:
      garment.repairs === null
        ? null
        : {
            washAfterWears: garment.washAfterWears,
            lastWashedOn: garment.lastWashedOn,
            washedAt: garment.washedAt?.toISOString() ?? null,
            away: garment.away,
            awayNote: garment.awayNote,
          },
  });
}

function ownerCare(
  garment: GarmentDetail,
  wear: NonNullable<GarmentContext['own']>['wear'],
) {
  // The owner's care: their price is always read.
  const { price = null, quantity } = garment;
  const cost = totalCost({ price, quantity, repairCost: wear.repairCost });
  return {
    washAfterWears: garment.washAfterWears,
    lastWashedOn: garment.lastWashedOn,
    washedAt: garment.washedAt?.toISOString() ?? null,
    away: garment.away,
    awayNote: garment.awayNote,
    worn: wear.worn,
    wornSinceWash: wear.sinceWash,
    lastWorn: wear.lastWorn,
    cost,
    costPerWear: cost === null ? null : perWearCost(cost, wear.worn),
  };
}

/*
 * What a garment write answers (#192b): what it changed, never the garment
 * read again, so a write costs what its page twin does (the page redirects
 * to the garment; a client that needs it whole reads GET /garments/{id}).
 */

export const GarmentRef = Type.Object(
  { id: Type.Integer() },
  {
    title: 'GarmentRef',
    description: 'The new garment: `Location` is its URL',
  },
);

/** POST /garments' 200: the retry of a create with this `clientId`. */
export const GarmentRetried = Type.Object(
  { id: Type.Integer() },
  {
    title: 'GarmentRetried',
    description:
      'An earlier create with this clientId: its garment, `Location` its URL; nothing was created',
  },
);

export const GarmentUpdated = Type.Object(
  {
    /**
     * The properties not kept (`properties.sleeve`): given for a role
     * without them, or set before and dropped by a new category.
     */
    ignored: Type.Array(Type.String()),
  },
  { title: 'GarmentUpdated', description: 'Saved' },
);

export const GarmentStatusAnswer = Type.Object(
  { status: literals(GARMENT_STATUSES) },
  { title: 'GarmentStatus', description: 'Where the garment now is' },
);

export const GarmentCondition = Type.Object(
  {
    condition: literals(CONDITIONS),
    conditionNote: Type.Optional(Type.String()),
  },
  { title: 'GarmentCondition', description: 'The condition as saved' },
);

export const GarmentQuantity = Type.Object(
  { quantity: Type.Integer({ minimum: 1 }) },
  { title: 'GarmentQuantity', description: 'Its copies now' },
);

export const GarmentTagged = Type.Object(
  {
    /** The properties the tap changed, a new type's presets included. */
    changed: Type.Array(Type.String()),
  },
  { title: 'GarmentTagged', description: 'Saved' },
);

export const GarmentsUpdated = Type.Object(
  {
    updated: Type.Integer({ minimum: 0 }),
    /** Named but not changed: not in this wardrobe, or without the property. */
    skipped: Type.Integer({ minimum: 0 }),
  },
  { title: 'GarmentsUpdated', description: 'How many were set' },
);

export const GarmentPhotoSaved = Type.Object(
  {
    /**
     * `pending`: queued for its cutout (poll GET /garments/{id}); `edited`:
     * a mask turned with the photo, nothing to wait for.
     */
    cutoutStatus: literals<SwappedCutout>(['pending', 'edited', 'none']),
  },
  {
    title: 'GarmentPhotoSaved',
    description:
      "The new photo is the garment's: GET /garments/{id} has its URLs",
  },
);

export const CutoutRetried = Type.Object(
  {
    /** False: the cutout was not failed (pending, ready, edited), so it is left as it is. */
    requeued: Type.Boolean(),
  },
  { title: 'CutoutRetried', description: 'Whether the cutout is queued again' },
);

export const RepairRef = Type.Object(
  { id: Type.Integer() },
  {
    title: 'RepairRef',
    description: "The new entry of the garment's repair log",
  },
);

export const GarmentImported = Type.Object(
  {
    id: Type.Integer(),
    /** What the import says about itself ("Found the details", "No photo"), as the page shows it. */
    notices: Type.Array(Type.String()),
    confidence: Type.Union(
      [
        Type.Literal('product'),
        Type.Literal('page'),
        Type.Literal('title-only'),
        Type.Null(),
      ],
      {
        description:
          "How much of a product the page gave: `product` (structured product data), `page` (a title and a photo only), `title-only` (nothing readable: only the link was kept, so the name is the caller's to give); null when the link was an image",
      },
    ),
  },
  {
    title: 'GarmentImported',
    description: 'The garment saved from the link: `Location` is its URL',
  },
);
