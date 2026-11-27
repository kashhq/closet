import { type Static, Type } from '@sinclair/typebox';
import { MAX_DRAFTS_PER_USER } from '../files/pending-photos';
import { OwnerQuery, RowId } from '../schemas';
import {
  CATEGORY_MAX,
  Destination,
  DraftsSaved,
  PostedConditionFields,
  PropertyFields,
} from './garment-input';

/**
 * The garment page's and the garment form's route schemas: the page's query,
 * where a new garment lands, the drafts' discard and the small posts
 * (condition, rotate). The form's own body is GarmentBody (garment-input.ts).
 */

/** POST /wardrobe/:id/condition: the garment page's condition control. */
export const ConditionBody = Type.Object(PostedConditionFields);
export type ConditionBody = Static<typeof ConditionBody>;

/**
 * POST /wardrobe/:id/photo/rotate: the photo sheet's ↺ and ↻ (ROTATIONS,
 * writes.ts). Anything else is a 400: it is the write itself.
 */
export const RotateBody = Type.Object({
  direction: Type.Union([Type.Literal('left'), Type.Literal('right')]),
});

/**
 * GET /wardrobe/:id/cutout: `poll`, how many polls the page made
 * (cutoutPollDelay), and `place`, the page the photo is drawn on (`form`
 * for the garment form's subject, #1069). URL state only our own fragment
 * writes; a page cached before either existed sends none. Strings here,
 * read by `pollCount` and `photoPlace` (garment-photo.tsx): URL state is a
 * fallback, never a 400.
 */
export const CutoutPollQuery = Type.Object({
  ...OwnerQuery.properties,
  poll: Type.Optional(Type.String()),
  place: Type.Optional(Type.String()),
});

/** The page flags that show a toast once (stripped from the URL by the page). */
export const GarmentPageQuery = Type.Object({
  ...OwnerQuery.properties,
  created: Type.Optional(Type.String()),
  photoSaved: Type.Optional(Type.String()),
  photoRotated: Type.Optional(Type.String()),
  bought: Type.Optional(Type.String()),
  repairSaved: Type.Optional(Type.String()),
  copyAdded: Type.Optional(Type.String()),
  // An agent decision made on the page (#333): its toast, decisionToastOf.
  decided: Type.Optional(Type.String({ maxLength: 16 })),
});

/**
 * Where a new garment's form and the link import land: `?to=wishlist` from
 * the wishlist, and `&replaces=<id>` from a garment's "Find a replacement"
 * (a garment of the addressed wardrobe, else a 404). Absent is the closet; a
 * closet garment may carry `&forNeed=<id>`, an agent need's "Bought a
 * different one" (the requester's own open need, else a 404).
 */
export const DestinationQuery = Type.Object({
  ...OwnerQuery.properties,
  to: Type.Optional(Type.Union([Type.Literal(''), Destination])),
  replaces: Type.Optional(Type.Union([Type.Literal(''), RowId])),
  forNeed: Type.Optional(Type.Union([Type.Literal(''), RowId])),
});
export type DestinationQuery = Static<typeof DestinationQuery>;

/**
 * GET /wardrobe/new: the destination, and `photo`, the pending photo an
 * add-sheet upload stored (POST /wardrobe/new/photo redirects here with
 * it). Navigation state: a name that is not the requester's pending photo
 * opens the form without it, saying so; never a 400.
 */
export const NewGarmentQuery = Type.Object({
  ...DestinationQuery.properties,
  photo: Type.Optional(Type.String({ maxLength: 64 })),
  // A draft's queue (#200), navigation state: the garments its batch saved
  // so far (readIdList), and the photos its upload could not read (their
  // names as the phone sent them, shown on the first draft).
  saved: DraftsSaved,
  leftOut: Type.Optional(
    Type.Array(Type.String({ maxLength: 255 }), {
      maxItems: MAX_DRAFTS_PER_USER,
    }),
  ),
});

/** POST /wardrobe/new/drafts/discard: the draft, and the queue's saved garments. */
export const DiscardDraftBody = Type.Object({
  photo: Type.String({ maxLength: 64 }),
  saved: DraftsSaved,
});

/**
 * GET /wardrobe/properties-fragment: the form's category and property
 * fields, as the category input, a type chip or the weight sends them
 * (hx-include). Malformed values are a 400 like the form's own.
 */
export const PropertiesFragmentQuery = Type.Object({
  category: Type.Optional(Type.String({ maxLength: CATEGORY_MAX })),
  ...PropertyFields,
});
