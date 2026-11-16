import { type Static, Type } from '@sinclair/typebox';
import { agentNameOf } from '../write-origin';
import type { BestOutfits, OutfitCount } from '../../wardrobe/goes-with';
import type { Idea } from '../../wardrobe/generator';
import { GARMENT_ROLES } from '../../wardrobe/properties';
import { GARMENT_STATUSES } from '../../wardrobe/status';
import {
  DISMISS_REASONS,
  OPTION_GROUP_STATUSES,
  OWNER_DISMISS_REASONS,
} from '../../wardrobe/suggestions';
import { literals, Nullable, withoutNulls } from '../api/resource';
import { imageUrl } from '../files/image-url';
import type { GoesWithCloset } from '../gallery/ideas';
import type { ClosetGarment } from '../gallery/queries';
import { IsoDateSchema } from '../schemas';
import { MoneyInput } from '../wardrobe/garment-api-input';
import type {
  Inbox,
  MusePick,
  Need,
  NeedDetail,
  NewNeed,
  SetAsideRow,
} from './inbox';
import type { GarmentRef } from './queries';

/**
 * The API's wishlist resources and inputs (#194b; docs/plans/2026-11-12-
 * json-api.md section 2), mapped from what the pages read: the Wishlist
 * tab as Muse's inbox (readInbox), a need's decision screen (readNeed) and
 * "Goes with my closet" (goesWithCloset). camelCase, null fields left out.
 * A wishlist garment in full is GET /garments/{id}; these are its cards.
 * Unlocks and best outfits judge an option against the owner's closet, so
 * a grantee's answer never holds them.
 */

const Money = Type.String({
  pattern: '^\\d+\\.\\d{2}$',
  description: 'A decimal amount in the household currency',
});

const GarmentRefResource = Type.Object(
  {
    id: Type.Integer(),
    name: Type.Optional(Type.String()),
    category: Type.String(),
    status: literals(GARMENT_STATUSES),
  },
  { title: 'WishlistGarmentRef' },
);

function toGarmentRef(ref: GarmentRef): Static<typeof GarmentRefResource> {
  return withoutNulls(ref);
}

const UnlocksResource = Type.Object(
  {
    outfits: Type.Integer({
      minimum: 0,
      description: 'Distinct outfits it makes with the closet, at most 50',
    }),
    capped: Type.Boolean({
      description: 'More than `outfits` were found: "50+"',
    }),
  },
  { title: 'Unlocks' },
);

function toUnlocks(count: OutfitCount): Static<typeof UnlocksResource> {
  return { outfits: count.outfits, capped: count.capped };
}

const WishlistGarment = Type.Object(
  {
    id: Type.Integer(),
    name: Type.Optional(Type.String()),
    brand: Type.Optional(Type.String()),
    category: Type.String(),
    /** The listed price. */
    price: Type.Optional(Money),
    sourceUrl: Type.Optional(Type.String()),
    /** Signed, relative, immutable: from the cutout when it shows. */
    thumbUrl: Type.Optional(Type.String()),
    fromMuse: Type.Boolean({ description: 'Your agent suggested it' }),
    /** Muse's place for it among its need's options, 1 its pick. */
    rank: Type.Optional(Type.Integer({ minimum: 1 })),
    /** Muse's reasoning. */
    museNote: Type.Optional(Type.String()),
    setAside: Type.Boolean({
      description:
        'Set aside ("Not for me", or another option chosen): Undo brings it back',
    }),
    setAsideReason: Type.Optional(literals(DISMISS_REASONS)),
    setAsideNote: Type.Optional(Type.String()),
    /** Its need, for an option set aside. */
    needId: Type.Optional(Type.Integer()),
    /** The closet garment it would replace (your own items). */
    replaces: Type.Optional(GarmentRefResource),
    /** The owner's own read only. */
    unlocks: Type.Optional(UnlocksResource),
  },
  {
    title: 'WishlistGarment',
    description:
      'A wishlist garment as the inbox shows it: GET /garments/{id} has the rest',
  },
);
type WishlistGarment = Static<typeof WishlistGarment>;

/** An own item as the inbox reads it (not exported by inbox.ts: its own section's shape). */
type OwnItem = Inbox['own'][number];

function toPick(
  pick: MusePick,
  extra: Partial<WishlistGarment> = {},
): WishlistGarment {
  return {
    ...withoutNulls({
      id: pick.id,
      name: pick.name,
      brand: pick.brand,
      category: pick.category,
      price: pick.price,
      sourceUrl: pick.sourceUrl,
      thumbUrl: pick.photo && imageUrl(pick.photo, 'thumb'),
      rank: pick.rank,
      museNote: pick.note,
      setAsideReason: pick.dismissedReason,
      setAsideNote: pick.dismissedNote,
    }),
    fromMuse: true,
    setAside: pick.dismissedAt !== null,
    ...extra,
  };
}

function toOwnItem(item: OwnItem): WishlistGarment {
  return {
    ...withoutNulls({
      id: item.id,
      name: item.name,
      brand: item.brand,
      category: item.category,
      price: item.price,
      sourceUrl: item.sourceUrl,
      thumbUrl: item.photo && imageUrl(item.photo, 'thumb'),
      setAsideReason: item.dismissedReason,
      replaces: item.replaces && toGarmentRef(item.replaces),
    }),
    fromMuse: item.suggested,
    setAside: item.dismissedAt !== null,
  };
}

const NeedResource = Type.Object(
  {
    id: Type.Integer(),
    name: Type.String(),
    /** Per piece, as Muse set it. */
    budget: Type.Optional(Money),
    /** Muse's reasoning. */
    note: Type.Optional(Type.String()),
    status: literals(OPTION_GROUP_STATUSES),
    /** What settled it: the option chosen, or what was bought. */
    resolvedGarmentId: Type.Optional(Type.Integer()),
    dismissedReason: Type.Optional(literals(DISMISS_REASONS)),
    ownerNote: Type.Optional(Type.String()),
    /** The agent's name, while its token exists. */
    agent: Type.Optional(Type.String()),
  },
  {
    title: 'WishlistNeed',
    description:
      'One need Muse is shopping for (an option group): open, resolved (an option chosen or bought) or set aside',
  },
);
type NeedResource = Static<typeof NeedResource>;

function toNeed(need: Need): NeedResource {
  return withoutNulls({
    id: need.id,
    name: need.name,
    budget: need.budget,
    note: need.note,
    status: need.status,
    resolvedGarmentId: need.resolvedGarmentId,
    dismissedReason: need.dismissedReason,
    ownerNote: need.ownerNote,
    agent: agentNameOf(need.agent),
  });
}

export const Wishlist = Type.Object(
  {
    readyToBuy: Type.Array(
      Type.Object(
        { need: NeedResource, pick: WishlistGarment },
        { title: 'WishlistReadyToBuy' },
      ),
      { description: 'Needs an option was chosen for, not bought yet' },
    ),
    needs: Type.Array(
      Type.Object(
        { need: NeedResource, options: Type.Array(WishlistGarment) },
        { title: 'WishlistOpenNeed' },
      ),
      {
        description:
          "Open needs with options to choose from: the most unlocks first (for the owner; else Muse's rank), each need's options likewise",
      },
    ),
    items: Type.Array(WishlistGarment, {
      description:
        'Your own wishlist items (and a lone suggestion), newest first',
    }),
    stillLooking: Type.Array(NeedResource, {
      description: 'Open needs with no option left: Muse is still looking',
    }),
    setAside: Type.Object(
      {
        needs: Type.Array(NeedResource),
        garments: Type.Array(WishlistGarment),
      },
      {
        title: 'WishlistSetAside',
        description: 'What was set aside, each with its Undo',
      },
    ),
  },
  {
    title: 'Wishlist',
    description:
      "The Wishlist tab, Muse's inbox: every need and item in exactly one section. Not paged: the needs are sorted by what their options unlock, which only the whole list knows",
  },
);

function toSetAside(
  rows: readonly SetAsideRow[],
): Static<typeof Wishlist>['setAside'] {
  return {
    needs: rows.flatMap((row) =>
      row.kind === 'need' ? [toNeed(row.need)] : [],
    ),
    garments: rows.flatMap((row) => {
      if (row.kind !== 'pick') return [];
      return 'rank' in row.pick
        ? [toPick(row.pick, row.need && { needId: row.need.id })]
        : [toOwnItem(row.pick)];
    }),
  };
}

export function toWishlistResource(inbox: Inbox): Static<typeof Wishlist> {
  return {
    readyToBuy: inbox.readyToBuy.map(({ need, pick }) => ({
      need: toNeed(need),
      pick: toPick(pick),
    })),
    needs: inbox.groups.map(({ need, options, unlocks }) => ({
      need: toNeed(need),
      options: options.map((pick) => {
        const count = unlocks?.get(pick.id);
        return toPick(pick, count && { unlocks: toUnlocks(count) });
      }),
    })),
    items: inbox.own.map(toOwnItem),
    stillLooking: inbox.stillLooking.map(toNeed),
    setAside: toSetAside(inbox.setAside),
  };
}

const IdeaGarmentResource = Type.Object(
  {
    id: Type.Integer(),
    name: Type.Optional(Type.String()),
    category: Type.String(),
    role: literals(GARMENT_ROLES),
    /** Signed, relative, immutable: from the cutout when it shows. */
    thumbUrl: Type.Optional(Type.String()),
  },
  { title: 'GoesWithGarment' },
);

function toIdeaGarment(
  garment: ClosetGarment,
): Static<typeof IdeaGarmentResource> {
  return withoutNulls({
    id: garment.id,
    name: garment.name,
    category: garment.category,
    role: garment.role,
    thumbUrl: garment.photo && imageUrl(garment.photo, 'thumb'),
  });
}

const BestOutfitResource = Type.Object(
  {
    garments: Type.Array(IdeaGarmentResource, {
      description: 'Top to toe, the wishlist item among them',
    }),
    atItemsFormality: Type.Boolean({
      description: "Dressed at the item's own formality",
    }),
  },
  {
    title: 'GoesWithOutfit',
    description:
      'An outfit it would make: display only, until it is bought (POST /outfits takes closet garments)',
  },
);

function toBestOutfit(
  idea: Idea<ClosetGarment>,
): Static<typeof BestOutfitResource> {
  return {
    garments: idea.garments.map(toIdeaGarment),
    atItemsFormality: idea.score === 0,
  };
}

const JudgedResource = Type.Object(
  {
    ...UnlocksResource.properties,
    best: Type.Array(BestOutfitResource),
  },
  {
    title: 'WishlistOptionJudged',
    description:
      "How it goes with the owner's closet: the owner's own read only",
  },
);

function toJudged(
  judged: BestOutfits<ClosetGarment>,
): Static<typeof JudgedResource> {
  return { ...toUnlocks(judged), best: judged.best.map(toBestOutfit) };
}

export const WishlistNeedDetail = Type.Object(
  {
    need: NeedResource,
    options: Type.Array(
      Type.Object(
        {
          ...WishlistGarment.properties,
          judged: Type.Optional(JudgedResource),
        },
        { title: 'WishlistOption' },
      ),
      {
        description:
          'Its options still open, the most unlocks first (the chosen one alone once resolved)',
      },
    ),
    setAside: Type.Array(WishlistGarment),
    resolver: Type.Optional(GarmentRefResource),
  },
  {
    title: 'WishlistNeedDetail',
    description:
      "A need's decision screen: its options judged against the closet",
  },
);

export function toNeedDetailResource(
  detail: NeedDetail,
): Static<typeof WishlistNeedDetail> {
  const { need, options, setAside, judged } = detail;
  return withoutNulls({
    need: toNeed(need),
    options: options.map((pick) => {
      const judgedPick = judged?.get(pick.id);
      return {
        ...toPick(pick),
        ...(judgedPick && { judged: toJudged(judgedPick) }),
      };
    }),
    setAside: setAside.map((pick) => toPick(pick)),
    resolver: need.resolver && toGarmentRef(need.resolver),
  });
}

export const GoesWith = Type.Object(
  {
    ...UnlocksResource.properties,
    best: Type.Array(BestOutfitResource),
    pairsWith: Type.Array(
      Type.Object(
        {
          role: literals(GARMENT_ROLES),
          goWithIt: Type.Integer({
            minimum: 0,
            description:
              'Closet garments of the role that make an outfit with it',
          }),
          inCloset: Type.Integer({ minimum: 0 }),
          best: Type.Array(
            Type.Object(
              {
                garment: IdeaGarmentResource,
                /** Outfits found holding it; absent for a layer, checked on its own. */
                outfits: Type.Optional(Type.Integer({ minimum: 0 })),
              },
              { title: 'GoesWithPartner' },
            ),
          ),
        },
        { title: 'GoesWithRole' },
      ),
      { description: 'Each role it is worn with, top to toe' },
    ),
    nearDuplicates: Type.Array(
      Type.Object(
        {
          ...IdeaGarmentResource.properties,
          replacesIt: Type.Boolean({
            description:
              'The garment it is on the wishlist to replace: like for like',
          }),
        },
        { title: 'GoesWithNearDuplicate' },
      ),
      {
        description:
          'Closet garments near-identical to it (same category, type and colours): "do I need this?"',
      },
    ),
  },
  {
    title: 'GoesWith',
    description:
      '"Goes with my closet": a wishlist item judged against the whole closet (no weather, the item\'s own formality)',
  },
);

export function toGoesWithResource(
  judged: GoesWithCloset,
): Static<typeof GoesWith> {
  return {
    ...toUnlocks({ outfits: judged.outfits, capped: judged.capped }),
    best: judged.best.map(toBestOutfit),
    pairsWith: judged.roles.map((role) => ({
      role: role.role,
      goWithIt: role.goes,
      inCloset: role.of,
      best: role.best.map((partner) =>
        withoutNulls({
          garment: toIdeaGarment(partner.garment),
          outfits: partner.outfits,
        }),
      ),
    })),
    nearDuplicates: judged.nearDuplicates.map((garment) => ({
      ...toIdeaGarment(garment),
      replacesIt: garment.replaced,
    })),
  };
}

export const NewNeedsSeen = Type.Object(
  {
    needs: Type.Array(
      Type.Object(
        { id: Type.Integer(), name: Type.String() },
        { title: 'WishlistNewNeed' },
      ),
      {
        description:
          'Open needs with options new since you last looked, newest first',
      },
    ),
  },
  { title: 'WishlistSeen' },
);

export function toNewNeedsSeen(
  needs: readonly NewNeed[],
): Static<typeof NewNeedsSeen> {
  return { needs: needs.map(({ id, name }) => ({ id, name })) };
}

const DismissInput = {
  reason: literals(OWNER_DISMISS_REASONS),
  note: Type.Optional(Type.String({ maxLength: 500 })),
};

export const PickDecisionInput = Type.Union(
  [
    Type.Object(
      { event: Type.Literal('choose') },
      {
        title: 'PickChoose',
        description:
          'This one: its need resolved by it, its other options set aside',
      },
    ),
    Type.Object(
      { event: Type.Literal('dismiss'), ...DismissInput },
      {
        title: 'PickDismiss',
        description: 'Not for me, with your reason and a note',
      },
    ),
    Type.Object(
      { event: Type.Literal('undo') },
      {
        title: 'PickUndo',
        description:
          "A pick set aside back among its need's options, while the need is open (a choice is undone on the need)",
      },
    ),
  ],
  { title: 'PickDecision' },
);

export const NeedDecisionInput = Type.Union(
  [
    Type.Object(
      { event: Type.Literal('dismiss'), ...DismissInput },
      {
        title: 'NeedDismiss',
        description: 'Not this need right now: its options with it',
      },
    ),
    Type.Object(
      { event: Type.Literal('undo') },
      {
        title: 'NeedUndo',
        description: 'One set aside, or a choice: its options back',
      },
    ),
  ],
  { title: 'NeedDecision' },
);

export const DecisionMade = Type.Object(
  {
    needId: Type.Optional(Type.Integer({ description: 'The need it decided' })),
    setAside: Type.Array(Type.Integer(), {
      description: 'Options it set aside',
    }),
    restored: Type.Array(Type.Integer(), {
      description: 'Options it brought back',
    }),
  },
  { title: 'WishlistDecision' },
);

export const PurchaseInput = Type.Object(
  {
    acquiredOn: Nullable(IsoDateSchema, {
      description: 'The day bought; null or absent: not recorded',
    }),
    price: Nullable(MoneyInput, {
      description:
        'What it cost; null or absent: not recorded (the listed price is replaced)',
    }),
    archiveReplaced: Type.Optional(
      Type.Boolean({
        description:
          "Also archive the closet garment it replaces: the owner's alone (a share asking is a 403)",
      }),
    ),
  },
  { title: 'Purchase' },
);

export const PurchaseRecorded = Type.Object(
  {
    archivedReplaced: Type.Optional(
      Type.Integer({
        description: 'The garment it replaces, archived with it',
      }),
    ),
  },
  {
    title: 'PurchaseRecorded',
    description: 'In the closet now: GET /garments/{id}',
  },
);

export const ReturnRecorded = Type.Object(
  {
    needId: Type.Optional(
      Type.Integer({ description: 'Its need, open again' }),
    ),
  },
  {
    title: 'ReturnRecorded',
    description: 'Archived, and set aside as returned',
  },
);
