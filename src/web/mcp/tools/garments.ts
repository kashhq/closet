import { buffer } from 'node:stream/consumers';
import { QUANTITY_MAX } from '../../../wardrobe/availability';
import * as z from 'zod';
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
} from '../../../wardrobe/properties';
import {
  CARE_BLEACH,
  CARE_DRY,
  CARE_DRY_CLEAN,
  CARE_IRON,
  CARE_WASH,
} from '../../../wardrobe/care';
import { todayIn } from '../../../calendar-date';
import { type Projection, project } from '../../api/resource';
import { HttpError } from '../../errors';
import {
  type GarmentDetail,
  type GarmentSummary,
  garmentSummaries,
} from '../../wardrobe/queries';
import { gridCursorText } from '../../wardrobe/grid-cursor';
import { GRID_PAGE_SIZE } from '../../wardrobe/grid-page-size';
import { closetLookalikes } from '../../wardrobe/lookalikes';
import { garmentContext } from '../../wardrobe/garment-context';
import {
  Garment,
  GarmentListItem,
  garmentListRecord,
  type GarmentListRecord,
  garmentRecord,
  type GarmentRecord,
} from '../../wardrobe/garment-resource';
import {
  BRAND_MAX,
  CATEGORY_MAX,
  CARE_NOTE_MAX,
  NAME_MAX,
  SIZE_MAX,
  TEXT_MAX,
} from '../../wardrobe/garment-input';
import { type WearSummary, wearCountsByGarment } from '../../wears/queries';
import { wishlistItems } from '../../wishlist/queries';
import {
  actorOf,
  defineTool,
  ImageAnswer,
  type ToolContext,
  wardrobeFor,
} from '../tool';
import {
  centsPriceInput,
  isoDate,
  ownerIdInput,
  pageCursorInput,
  readPageCursor,
  rowId,
} from './common';
import {
  garmentIn,
  garmentPhotoIn,
  searchGarments,
} from '../../wardrobe/garment-access';
import { addGarmentCopies, editGarment } from '../../wardrobe/garment-actions';
import { searchFilters } from '../../wardrobe/garment-search';
import { readGarmentEdit } from '../../wardrobe/garment-changes';
import { addGarmentFromLink, refusedForm } from './link-import';

/**
 * The garment resources as an agent reads them (#711): the API's records
 * (garment-resource.ts), nulls kept, never a mapping of the tools' own. No
 * photo URLs (an agent cannot fetch a signed /file URL: get_garment_photo
 * answers the picture); `agent` is the agent's bare name, as every tool's.
 */
/** What every garment resource says it is (garment-resource.ts's `identity`). */
const GARMENT_IDENTITY_FOR_MCP = {
  id: 'keep',
  name: 'keep',
  category: 'keep',
  role: 'keep',
  status: 'keep',
  brand: 'keep',
  colors: 'keep',
  size: 'keep',
  price: 'keep',
  quantity: 'keep',
  condition: 'keep',
  photo: 'omit',
} as const;

export const GARMENT_SUMMARY_FOR_MCP = {
  ...GARMENT_IDENTITY_FOR_MCP,
  // get_garment's: a hit answers what it is.
  photoMissingSince: 'omit',
  type: 'keep',
  warmth: 'keep',
  formality: 'keep',
} as const satisfies Projection<GarmentListRecord>;

export const GARMENT_FOR_MCP = {
  ...GARMENT_IDENTITY_FOR_MCP,
  photoMissingSince: 'keep',
  notes: 'keep',
  acquiredOn: 'keep',
  replacesGarmentId: 'keep',
  sourceUrl: 'keep',
  conditionNote: 'keep',
  properties: 'keep',
  careLabel: 'keep',
  repairs: 'keep',
  agent: 'own',
  capsules: 'keep',
  care: 'keep',
} as const satisfies Projection<GarmentRecord>;

/** A search or capsule hit, as the tools answer it. */
export function summaryForAgent(
  garment: GarmentSummary,
  cutoutsEnabled: boolean,
) {
  return project(
    garmentListRecord(garment, cutoutsEnabled),
    GarmentListItem,
    GARMENT_SUMMARY_FOR_MCP,
    {},
  );
}

/**
 * A garment in full, as its page and GET /api/v1/garments/{id} read it
 * (garmentContext: one statement beside the garment, #172): the owner's
 * records (care, cost per wear, the repair log) only on their own closet
 * garment, never a grantee's.
 */
async function garmentForAgent(
  ctx: ToolContext,
  garment: GarmentDetail,
  access: { ownerId: number; isOwner: boolean },
) {
  const context = await garmentContext(
    ctx.db,
    garment,
    { ...access, viewerId: ctx.userId },
    todayIn(ctx.timeZone, new Date()),
  );
  const record = garmentRecord(garment, context, ctx.cutouts.enabled);
  return project(record, Garment, GARMENT_FOR_MCP, {
    agent: record.agent?.name ?? null,
    hasPhoto: record.photo !== null,
    // The care label's notes, also answered here since get_garment began.
    washingDetails: record.careLabel.notes,
  });
}

const property = <T extends z.ZodType>(schema: T, description: string) =>
  schema.nullable().optional().describe(`${description} null clears it.`);

/** update_garment's property fields; absent leaves a value as stored. */
const PropertyInput = {
  type: property(
    z.string().max(40),
    "A type of the garment's category (e.g. t-shirt, jeans, overshirt); presets for warmth, formality, sleeve and length follow it where they were unset or still at the old type's.",
  ),
  warmth: property(
    z.union(WARMTHS.map((w) => z.literal(w))),
    '1 very light to 5 very warm.',
  ),
  formality: property(
    z.union(FORMALITIES.map((f) => z.literal(f))),
    '1 lounge, 2 casual, 3 smart casual, 4 dressy.',
  ),
  materials: property(
    z.array(z.enum(MATERIALS)).max(MATERIALS.length),
    'The whole set of materials.',
  ),
  pattern: property(z.enum(PATTERNS), 'Pattern.'),
  fit: property(z.enum(FITS), 'Fit.'),
  sleeve: property(z.enum(SLEEVES), 'Sleeve length (tops, one-pieces).'),
  length: property(z.enum(LENGTHS), 'Length (bottoms, one-pieces).'),
  fabricWeightGsm: property(
    z.number().int().min(1).max(10_000),
    'Fabric weight in grams per square metre.',
  ),
  waterResistant: z
    .boolean()
    .optional()
    .describe('Water resistant (layers, footwear, accessories).'),
  careWash: property(
    z.enum(CARE_WASH),
    "The care label's washing: machine hot (60 °C), warm (40 °C) or cold (30 °C), hand, or do not wash. Changing `materials` fills the label's washing, bleach, drying and ironing where they were unset or still at the old materials' usual care.",
  ),
  careBleach: property(z.enum(CARE_BLEACH), "The care label's bleach."),
  careDry: property(z.enum(CARE_DRY), "The care label's drying."),
  careIron: property(z.enum(CARE_IRON), "The care label's ironing."),
  careDryClean: property(
    z.enum(CARE_DRY_CLEAN),
    "The care label's dry cleaning: allowed, only, never.",
  ),
};

/**
 * update_garment's own fields (#372), the garment form's text fields:
 * absent leaves a value as stored, null clears it. A garment always has a
 * category, so it is never null; a blank one is the form's refusal.
 */
const OwnFieldInput = {
  name: property(z.string().max(NAME_MAX), 'The name.'),
  category: z
    .string()
    .max(CATEGORY_MAX)
    .optional()
    .describe(
      'tops, bottoms, dresses, outerwear, footwear, accessories, bags, other, or a custom one. A new role drops the properties and care label it does not have, and a type not of the new category (each named in `ignored`); nothing is preset, and a `type` given with it is checked against the new category.',
    ),
  colors: z
    .array(z.enum(GARMENT_COLORS))
    .max(GARMENT_COLORS.length)
    .optional()
    .describe('The whole set of colours; [] clears them.'),
  size: property(
    z.string().max(SIZE_MAX),
    'The size as on the label (XL is stored as X-Large).',
  ),
  brand: property(z.string().max(BRAND_MAX), 'The brand.'),
  notes: property(z.string().max(TEXT_MAX), 'Free notes.'),
  price: property(
    centsPriceInput(),
    'What one copy cost, in US dollars (at most two decimals).',
  ),
  acquiredOn: property(
    isoDate(),
    'When it was bought or received, YYYY-MM-DD.',
  ),
};

const SearchInput = z.object({
  ownerId: ownerIdInput,
  keyword: z
    .string()
    .max(NAME_MAX)
    .optional()
    .describe(
      'Words, each matching the name, brand, colour, type, category or notes (punctuation ignored: "jcrew" finds J.Crew); notes-only matches come last.',
    ),
  category: z
    .string()
    .max(CATEGORY_MAX)
    .optional()
    .describe(
      'tops, bottoms, dresses, outerwear, footwear, accessories, bags, other, or a custom one.',
    ),
  type: z
    .string()
    .max(40)
    .optional()
    .describe('A type of `category` (needs it).'),
  color: z.enum(GARMENT_COLORS).optional(),
  size: z.string().max(40).optional(),
  warmth: z.union(WARMTHS.map((w) => z.literal(w))).optional(),
  formality: z.union(FORMALITIES.map((f) => z.literal(f))).optional(),
  material: z.enum(MATERIALS).optional(),
  wash: z
    .enum(CARE_WASH)
    .optional()
    .describe('Only garments whose care label says to wash them this way.'),
  capsuleId: rowId().optional().describe('Members of this capsule only.'),
  needsWash: z
    .boolean()
    .default(false)
    .describe(
      'Only garments with a copy that needs a wash (your own wardrobe only).',
    ),
  needsAttention: z
    .boolean()
    .default(false)
    .describe('Only garments that need repair or replacing soon.'),
  needsTagging: z
    .boolean()
    .default(false)
    .describe(
      "Only closet garments still missing their type (where the category has types), warmth (where the role has one) or formality: the app's tagging queue. get_garment_photo shows each; update_garment tags it.",
    ),
  includeArchived: z
    .boolean()
    .default(false)
    .describe(
      'Also garments no longer in the closet (archived). The wishlist is list_wishlist.',
    ),
  before: pageCursorInput,
});
/**
 * get_wardrobe's garment: what it is and, on the caller's own wardrobe,
 * how it is worn. No photo, no link; a grantee gets no wear data (the
 * owner's own records, as get_garment).
 */
function wardrobeGarmentOut(
  garment: GarmentSummary,
  wears?: Pick<WearSummary, 'worn' | 'lastWorn'>,
) {
  return {
    id: garment.id,
    name: garment.name,
    category: garment.category,
    type: garment.type,
    colors: garment.colors ?? [],
    materials: garment.materials ?? [],
    warmth: garment.warmth,
    formality: garment.formality,
    brand: garment.brand,
    condition: garment.condition,
    copies: garment.quantity,
    ...(wears && { wears: wears.worn, lastWorn: wears.lastWorn }),
  };
}

export const garmentTools = [
  defineTool({
    name: 'search_garments',
    title: 'Search garments',
    description: `Searches a wardrobe's closet like its grid (never the wishlist: list_wishlist): every filter optional, newest first, ${GRID_PAGE_SIZE} a page: pass the answer's \`next\` (a string, null on the last page) back as \`before\` for the next. Answers each garment's id, name, category, role, type, brand, colours, size, warmth, formality, quantity, condition, price and status; get_garment has the rest.`,
    input: SearchInput,
    writes: false,
    async run(args, ctx) {
      const { total, garments, next } = await searchGarments(
        ctx.db,
        actorOf(ctx),
        {
          ownerId: args.ownerId,
          filters: searchFilters(args),
          before: readPageCursor(args.before),
          limit: GRID_PAGE_SIZE,
        },
      );
      return {
        total,
        garments: garments.map((garment) =>
          summaryForAgent(garment, ctx.cutouts.enabled),
        ),
        next: next === null ? null : gridCursorText(next),
      };
    },
  }),

  defineTool({
    name: 'get_wardrobe',
    title: 'Get the whole closet',
    description:
      "A wardrobe's whole closet in one compact answer, no paging (search_garments pages and filters): each garment's id, name, category, type, colours, materials, warmth, formality, brand, condition (good, needs_repair, replace_soon), copies and, on your own wardrobe, the days it was worn and when it was last worn (0 and null: never). Archived garments only with `includeArchived`; never the wishlist (list_wishlist). No photos: get_garment_photo. Read this before proposing anything to buy.",
    input: z.object({
      ownerId: ownerIdInput,
      includeArchived: z
        .boolean()
        .default(false)
        .describe('Also garments no longer in the closet (archived).'),
    }),
    writes: false,
    async run({ ownerId, includeArchived }, ctx) {
      const access = await wardrobeFor(ctx, ownerId, 'view');
      const { garments } = await garmentSummaries(ctx.db, access.ownerId, {
        scope: includeArchived ? 'owned' : 'closet',
        needsWash: false,
        attention: false,
      });
      // The owner's wears in one grouped read; none for a grantee.
      const wears = access.isOwner
        ? await wearCountsByGarment(ctx.db, access.ownerId)
        : undefined;
      return {
        total: garments.length,
        garments: garments.map((garment) =>
          wardrobeGarmentOut(
            garment,
            wears && (wears.get(garment.id) ?? { worn: 0, lastWorn: null }),
          ),
        ),
      };
    },
  }),

  defineTool({
    name: 'get_garment',
    title: 'Get a garment',
    description: `One garment in full: its status (closet, archived, or wishlist: not bought yet) and fields, every property, its care label, product link and price, what it replaces (a wishlist item), quantity and condition, the capsules it is in, and on your own wardrobe your wears and washes, what it cost (price per piece × copies plus what its repairs cost; null without a price) and its cost per wear (that over the days worn; null until worn), and its repair and alteration log (each with its day, kind, note and cost), and agent when an agent added it over MCP (your token's name when it was yours, "<first name>'s agent" for a grantee's on your wardrobe, else "Agent"). No photo: get_garment_photo has it; photoMissingSince is set while nothing of the photo is stored (hasPhoto false until it is back).`,
    input: z.object({ id: rowId(), ownerId: ownerIdInput }),
    writes: false,
    async run({ id, ownerId }, ctx) {
      const access = await wardrobeFor(ctx, ownerId, 'view');
      const garment = await garmentIn(ctx.db, access, id);
      return garmentForAgent(ctx, garment, access);
    },
  }),

  defineTool({
    name: 'get_garment_photo',
    title: "Get a garment's photo",
    description:
      "A garment's photo as an image: its 400px thumbnail (the background removed when the app has done so), to see what it is and tag it (search_garments with needsTagging lists what needs tags, update_garment writes them). Your own garments and a wardrobe shared with you. A garment without a photo is refused.",
    input: z.object({ id: rowId(), ownerId: ownerIdInput }),
    writes: false,
    async run({ id, ownerId }, ctx) {
      const access = await wardrobeFor(ctx, ownerId, 'view');
      const { garment, photo } = await garmentPhotoIn(
        ctx.db,
        ctx.webLogger,
        access,
        id,
      );
      const thumb = await buffer(await ctx.photos.getVariant(photo, 'thumb'));
      return new ImageAnswer(
        { id: garment.id, name: garment.name, category: garment.category },
        thumb,
        'image/webp',
      );
    },
  }),

  defineTool({
    name: 'update_garment',
    title: 'Update a garment',
    description:
      "WRITES: changes a garment's own fields (name, category, colours, size, brand, notes, price, acquiredOn), its properties, care label and condition, with the garment form's rules; anything not given stays as stored, and null clears a field (category: never). The condition note stays as stored unless given, is kept only while the condition is a problem (good clears it), and null clears it. A refused value (a blank category, a bad date) changes nothing. A value for a property the garment's role does not have (a sleeve on shoes), and a stored one a new category's role does not have, are not kept and are named in `ignored`; clearing one (null, false) is not. Needs your own wardrobe or a MANAGE share. Does not archive or delete.",
    input: z.object({
      id: rowId(),
      ownerId: ownerIdInput,
      ...OwnFieldInput,
      ...PropertyInput,
      condition: z
        .enum(CONDITIONS)
        .optional()
        .describe('good, needs_repair or replace_soon.'),
      conditionNote: z
        .string()
        .max(CARE_NOTE_MAX)
        .nullable()
        .optional()
        .describe(
          'What is wrong: kept only while the condition is needs_repair or replace_soon. Absent keeps the stored note; null clears it.',
        ),
    }),
    writes: true,
    idempotent: true,
    async run({ id, ownerId, ...changes }, ctx) {
      const { price } = changes;
      const { access, garment, edit } = await editGarment(
        { db: ctx.db, logger: ctx.webLogger },
        actorOf(ctx),
        { id, ownerId, unseen: 'wardrobe' },
        (stored) => {
          const read = readGarmentEdit(
            stored.garment,
            {
              ...changes,
              // Whole cents (centsPriceInput), as the form's text.
              price: typeof price === 'number' ? price.toFixed(2) : price,
            },
            { owner: stored.access.isOwner },
          );
          if (!read.ok) throw refusedForm(read.errors);
          return read;
        },
      );
      const { fields, ignored } = edit;
      // Every written value is stored as given, so the answer is the
      // garment read before with them, not a second read (#372).
      const saved: GarmentDetail = { ...garment, ...fields };
      return {
        garment: await garmentForAgent(ctx, saved, access),
        ignored,
      };
    },
  }),

  defineTool({
    name: 'add_garment_copy',
    title: 'Add copies of a garment',
    description: `WRITES: counts more identical copies of a closet garment (its quantity: three of the same white tee are one garment with 3 copies) instead of adding a new garment. The garment's photo, wears, washes and repairs stay as they are; new copies start clean. At most ${QUANTITY_MAX} copies a garment. Needs your own wardrobe or a MANAGE share. Not for a wishlist item (not bought yet) or an archived garment.`,
    input: z.object({
      id: rowId(),
      ownerId: ownerIdInput,
      copies: z
        .number()
        .int()
        .min(1)
        .max(QUANTITY_MAX - 1)
        .default(1)
        .describe('How many more (default 1).'),
    }),
    writes: true,
    idempotent: false,
    async run(args, ctx) {
      const { access } = await addGarmentCopies(
        { db: ctx.db, logger: ctx.webLogger },
        actorOf(ctx),
        { id: args.id, ownerId: args.ownerId, unseen: 'wardrobe' },
        args.copies,
      );
      const saved = await garmentIn(ctx.db, access, args.id);
      return {
        garment: await garmentForAgent(ctx, saved, access),
      };
    },
  }),

  defineTool({
    name: 'list_wishlist',
    title: 'List the wishlist',
    description:
      "A wardrobe's wishlist: what its owner is thinking of buying, newest first, each with its brand, category, price, product link and the closet garment it would replace. None of it is in the closet (search_garments never lists it).",
    input: z.object({ ownerId: ownerIdInput }),
    writes: false,
    async run({ ownerId }, ctx) {
      const access = await wardrobeFor(ctx, ownerId, 'view');
      const items = await wishlistItems(ctx.db, access.ownerId);
      return {
        items: items.map((item) => ({
          id: item.id,
          name: item.name,
          brand: item.brand,
          category: item.category,
          price: item.price,
          sourceUrl: item.sourceUrl,
          replaces: item.replaces && {
            id: item.replaces.id,
            name: item.replaces.name,
            status: item.replaces.status,
          },
        })),
      };
    },
  }),

  defineTool({
    name: 'add_garment_from_link',
    title: 'Add a garment from a product link',
    description:
      "WRITES: fetches a product page (or an image link), extracts the name, brand, colours, category, type, materials, price and first photo as the app's link import does, and saves the garment (the photo's background removal follows). Lands on the wishlist unless `destination` is `closet`: a product link is usually something being considered, and the owner moves it to the closet with \"Bought it\" in the app. Say `closet` only for something already owned. Give `category` when the page does not make it clear; any field given overrides the extraction. Saved to the closet, the answer's `lookalikes` are closet garments that look like the same product (same category, type and colours, no other brand): if there are any, ask the owner whether it is another copy of one; if so they delete the new garment in the app, and add_garment_copy counts the copy. The answer's `confidence` says how much the page gave: `product` (structured product data), `page` (a title and photo only) or `title-only` (nothing readable, so only the link was kept: the name and the rest are yours to give, or take another retailer's link). Needs your own wardrobe or a MANAGE share. Rate limited: 10 imports a minute. A refused fetch names its reason first: `blocked-by-site` is a shop that refuses automated fetches (it will again; take the product from another retailer), `http-status` a page that answered an error. A product you suggest to the owner for a need is suggest_garment's, not this tool's.",
    input: z.object({
      url: z.url({ protocol: /^https?$/ }).max(2048),
      ownerId: ownerIdInput,
      destination: z
        .enum(['wishlist', 'closet'])
        .default('wishlist')
        .describe('wishlist (considering it; the default) or closet (owned).'),
      replacesGarmentId: rowId()
        .optional()
        .describe(
          "A wishlist item's closet garment it would replace (search_garments with needsAttention finds the worn-out ones).",
        ),
      name: z.string().max(NAME_MAX).optional(),
      category: z.string().max(CATEGORY_MAX).optional(),
      type: z.string().max(40).optional(),
      size: z.string().max(SIZE_MAX).optional(),
      notes: z.string().max(TEXT_MAX).optional(),
    }),
    writes: true,
    idempotent: false,
    openWorld: true,
    async run(args, ctx) {
      // The wardrobe before the rate limit, so a refused call spends none of
      // it; addGarmentFromLink saves into the wardrobe authorized here.
      const access = await wardrobeFor(ctx, args.ownerId, 'manage');
      if (!(await ctx.allowLinkImport())) {
        throw new HttpError(
          429,
          'Too many link imports: try again in a minute',
        );
      }
      const saved = await addGarmentFromLink(ctx, access, args);
      const garment = await garmentIn(ctx.db, access, saved.id);
      // The garment form's duplicate check (#20), after the fact: a tool
      // call has no form to ask on before saving.
      const lookalikes =
        garment.status === 'closet'
          ? await closetLookalikes(
              ctx.db,
              access.ownerId,
              {
                category: garment.category,
                type: garment.type ?? '',
                colors: garment.colors ?? [],
                brand: garment.brand ?? '',
              },
              { exceptId: garment.id },
            )
          : [];
      return {
        garment: await garmentForAgent(ctx, garment, access),
        notices: saved.notices,
        confidence: saved.confidence,
        ...(garment.status === 'closet' && {
          lookalikes: lookalikes.map(({ id, name, category, quantity }) => ({
            id,
            name,
            category,
            quantity,
          })),
        }),
      };
    },
  }),
];
