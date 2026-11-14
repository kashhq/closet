import { type Static, Type } from '@sinclair/typebox';
import { ListOf, withoutNulls } from '../api/resource';
import { imageUrl } from '../files/image-url';
import { RowId } from '../schemas';
import type { CapsuleCard, CapsuleDetail, SyncedCapsuleRow } from './queries';
import { CAPSULE_NAME_MAX, CAPSULE_NOTES_MAX } from './validation';

/**
 * The API's capsule resources and inputs (#194b; docs/plans/2026-11-12-
 * json-api.md section 2), mapped from what the pages and MCP read: a
 * list's capsule (listCapsules, the list page's cards) and one capsule
 * (requireCapsule). Its garments are a garment list: GET
 * /garments?capsuleId={id}, paged and counted like the grid. camelCase,
 * null fields left out.
 */

const CapsulePreviewGarment = Type.Object(
  {
    id: Type.Integer(),
    name: Type.Optional(Type.String()),
    /** Signed, relative, immutable: from the cutout when it shows. */
    thumbUrl: Type.Optional(Type.String()),
  },
  { title: 'CapsulePreviewGarment' },
);

export const CapsuleListItem = Type.Object(
  {
    id: Type.Integer(),
    name: Type.String(),
    count: Type.Integer({
      minimum: 0,
      description:
        'Its garments in the closet (archived members kept, not counted)',
    }),
    preview: Type.Array(CapsulePreviewGarment, {
      description:
        'Its newest few garments in the closet, as its card shows them',
    }),
  },
  {
    title: 'CapsuleListItem',
    description:
      'A capsule as the list shows it: GET /capsules/{id} has its notes',
  },
);
type CapsuleListItem = Static<typeof CapsuleListItem>;

export const CapsuleList = ListOf(CapsuleListItem, {
  title: 'CapsuleList',
  description: "A page of the wardrobe's capsules, by name",
});

export function toCapsuleListItem(card: CapsuleCard): CapsuleListItem {
  return {
    id: card.id,
    name: card.name,
    count: card.count,
    preview: card.strip.map((garment) =>
      withoutNulls({
        id: garment.id,
        name: garment.name,
        thumbUrl: garment.photo && imageUrl(garment.photo, 'thumb'),
      }),
    ),
  };
}

export const Capsule = Type.Object(
  {
    id: Type.Integer(),
    name: Type.String(),
    notes: Type.Optional(Type.String()),
  },
  {
    title: 'Capsule',
    description:
      'A named subset of the closet. Its garments: GET /garments?capsuleId={id} (with the same `ownerId`)',
  },
);

export function toCapsuleResource(
  capsule: CapsuleDetail,
): Static<typeof Capsule> {
  return withoutNulls(capsule);
}

/**
 * The changes feed's capsule (#196b-1, GET /changes): the capsule with its
 * membership, which the feed carries nowhere else (a grantee's too: capsules
 * are share-aware). A garment's `capsules` are the client's to derive from
 * these (decisions 2026-11-13, the feed's garment).
 */
export const SyncedCapsule = Type.Object(
  {
    id: Type.Integer(),
    name: Type.String(),
    notes: Type.Optional(Type.String()),
    garmentIds: Type.Array(Type.Integer(), {
      description:
        'Every member by id, archived ones included (the capsule views leave those out)',
    }),
  },
  {
    title: 'SyncedCapsule',
    description: 'A named subset of the closet, with its members',
  },
);

export function toSyncedCapsule(
  capsule: SyncedCapsuleRow,
): Static<typeof SyncedCapsule> {
  return withoutNulls(capsule);
}

const capsuleInputFields = {
  name: Type.String({
    maxLength: CAPSULE_NAME_MAX,
    description:
      'Trimmed; blank, or one another of your capsules has in any case, is a 400',
  }),
  notes: Type.Optional(
    Type.String({
      maxLength: CAPSULE_NOTES_MAX,
      description: 'Blank or absent: none',
    }),
  ),
};

export const NewCapsule = Type.Object(
  {
    ...capsuleInputFields,
    clientId: Type.Optional(
      Type.String({
        format: 'uuid',
        description:
          'Your id for this create, for retrying it offline: a retry answers the first capsule of that id (200), the id of one deleted since is a 410',
      }),
    ),
  },
  { title: 'NewCapsule' },
);

export const CapsuleInput = Type.Object(capsuleInputFields, {
  title: 'CapsuleInput',
  description: 'Both fields replaced: notes left out are cleared',
});

/** Where a capsule form field sits in the JSON body (refusedBody). */
export const POINTER_OF_CAPSULE_FIELD = { name: '/name' } as const;

export const CapsuleCreated = Type.Object(
  { id: Type.Integer() },
  { title: 'CapsuleCreated' },
);

/** Garment or capsule ids one membership change may carry: MCP's cap. */
const MEMBERS_MAX = 500;

const MemberIds = (description: string) =>
  Type.Optional(Type.Array(RowId, { maxItems: MEMBERS_MAX, description }));

export const CapsuleMembersChange = Type.Object(
  {
    add: MemberIds('Garments to add (one already in it is kept)'),
    remove: MemberIds('Garments to take out (the garments stay in the closet)'),
  },
  {
    title: 'CapsuleMembersChange',
    description:
      "Ids outside the capsule's wardrobe, and wishlist items, are dropped, not refused: set-state, so a retry changes nothing",
  },
);

export const GarmentCapsulesChange = Type.Object(
  {
    add: MemberIds('Capsules to put it in'),
    remove: MemberIds('Capsules to take it out of'),
  },
  {
    title: 'GarmentCapsulesChange',
    description:
      "Capsules outside the garment's wardrobe are dropped, not refused; a wishlist item joins none. Set-state, so a retry changes nothing",
  },
);

export const MembershipChanged = Type.Object(
  {
    added: Type.Integer({ minimum: 0, description: 'Pairings made' }),
    removed: Type.Integer({ minimum: 0, description: 'Pairings undone' }),
  },
  { title: 'MembershipChanged' },
);
