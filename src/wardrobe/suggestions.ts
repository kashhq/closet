import { toCents } from './money';

/**
 * A suggestion and its option group (the agent phase 1, #333; the design is
 * docs/plans/2026-10-05-agent-suggestions.md, section 3). A suggestion is a
 * wishlist garment with provenance (garment.suggested_at and the columns
 * beside it); an option group is one need holding its sibling suggestions
 * (option_group). Deciding between them is feedback to the agent, so
 * nothing here deletes: a turned-down pick or need is dismissed, with a
 * reason, and can be undone. Pure: decideSuggestion answers which rows
 * change, and the one writer (decide, src/web/wishlist/decisions.ts) holds
 * the owner lock, reads the group and its picks, asks it and writes that.
 *
 *   group      open ──choose / bought──▶ resolved
 *                │ ◀──── undo (chosen, not bought) / returned / dismiss chosen
 *                └──dismiss──▶ dismissed ──undo──▶ open
 *
 *   decision      what it takes                      what it writes
 *   choose        an open pick of an open group      group resolved by it; the
 *                                                    other open picks chose_another
 *   dismiss-pick  an open or chosen pick             the pick dismissed (the
 *                                                    owner's reason); a chosen one
 *                                                    reopens its group and restores
 *                                                    the siblings it set aside
 *   undo-pick     a pick dismissed by the owner or   the pick open again
 *                 chose_another, its group open
 *   dismiss-group an open group                      group dismissed (reason, note)
 *   undo-group    a dismissed group, or one resolved group open; a choice's
 *                 by a pick still on the wishlist    chose_another siblings restored
 *                 (or by a garment deleted since)
 *   bought        a garment bought for the group     group resolved by it; every
 *                 (a pick, or "a different one",     other open pick chose_another;
 *                 then only of a need still to buy   a pick set aside is restored.
 *                 for: open, or its choice unbought) A pick bought once another
 *                                                    purchase settled the group:
 *                                                    only its own dismissal clears
 *   returned      the group's bought garment         it dismissed `returned`; the
 *                                                    group open again
 *
 * Refused on purpose: a purchase is never undone (Returned is its undo),
 * and a pick is restored only into an open group (undo the group's
 * decision first), so no group is resolved while it shows open picks.
 */

export const OPTION_GROUP_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type OptionGroupStatus = (typeof OPTION_GROUP_STATUSES)[number];

/**
 * Why something was set aside: the owner's one tap (the first six), and
 * the app's own (chose_another: a sibling was chosen or bought; returned:
 * bought, then returned). A check constraint lists them on garment and
 * option_group.
 */
export const DISMISS_REASONS = [
  'too_pricey',
  'colour',
  'style',
  'already_have',
  'fit_size',
  'not_now',
  'chose_another',
  'returned',
] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

/** The reasons the owner may give ("Not for me"). */
export const OWNER_DISMISS_REASONS = [
  'too_pricey',
  'colour',
  'style',
  'already_have',
  'fit_size',
  'not_now',
] as const satisfies readonly DismissReason[];
export type OwnerDismissReason = (typeof OWNER_DISMISS_REASONS)[number];

/**
 * The reasons the owner may give "Not for me" on one of the agent's outfits
 * (#335): an outfit has no size, so no fit_size. Stored as
 * outfit.dismissed_reason.
 */
export const OUTFIT_DISMISS_REASONS = [
  'too_pricey',
  'colour',
  'style',
  'already_have',
  'not_now',
] as const satisfies readonly OwnerDismissReason[];
export type OutfitDismissReason = (typeof OUTFIT_DISMISS_REASONS)[number];

/** The agent's options for one need: the most a group holds, ranked 1 to this. */
export const MAX_OPTIONS_PER_GROUP = 5;

/** A need's name ("A navy blazer"): a card's title. */
export const NEED_NAME_MAX = 120;
/** The agent's reasoning for a need, behind a tap on its screen. */
export const NEED_NOTE_MAX = 1000;
/** The agent's note on a pick: clamped under its card. */
export const PICK_NOTE_MAX = 240;

/** Whether a pick's price is within its need's budget per piece. */
export type BudgetFit = 'within' | 'over' | 'unknown';

/** `price` against `budget` per piece: unknown when either is missing. */
export function budgetFit(
  price: string | null,
  budget: string | null,
): BudgetFit {
  if (price === null || budget === null) return 'unknown';
  return toCents(price) <= toCents(budget) ? 'within' : 'over';
}

/** Query parameters that say where a visitor came from, never which product. */
const TRACKING_PARAM =
  /^(utm_.*|gclid|fbclid|msclkid|srsltid|igshid|mc_cid|mc_eid|_ga|spm)$/i;

/** A mobile or www host is the shop's own: the same product either way. */
const HOST_PREFIX = /^(www|m)\./;

/** Amazon's path after the product (`/dp/B0…/ref=sr_1_3`): where the link was clicked. */
const AMAZON_REF = /(\/dp\/[^/]+)\/ref=[^/]*/i;

/**
 * What makes two product links the same product, for the agent's "never
 * propose again what was set aside" (#337: suggest_garment, matched by
 * URL): the scheme ignored (http is https), the host without `www.` or
 * `m.`, the path without Amazon's `/ref=` segment or a trailing slash, no
 * fragment, no tracking parameters, the others sorted. They stay: a shop
 * may name the colour or size in them. Undefined for a link that is not a
 * URL (a stored link the garment form took).
 */
export function productUrlKey(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const kept = [...parsed.searchParams]
    .filter(([name]) => !TRACKING_PARAM.test(name))
    .sort(([a, x], [b, y]) => a.localeCompare(b) || x.localeCompare(y));
  const query = new URLSearchParams(kept).toString();
  const host = parsed.host.replace(HOST_PREFIX, '');
  const path = parsed.pathname.replace(AMAZON_REF, '$1').replace(/\/+$/, '');
  return `${host}${path}${query ? `?${query}` : ''}`;
}

/** A group as the writer read it. */
export interface GroupState {
  status: OptionGroupStatus;
  resolvedGarmentId: number | null;
  /** When it left `open` (the transaction's time); null while open. */
  decidedAt: Date | null;
}

/** A garment of the group (its picks, and the one that resolved it) as read. */
export interface PickState {
  id: number;
  /** Still on the wishlist; false once bought (closet or archived). */
  wanted: boolean;
  dismissedAt: Date | null;
  dismissedReason: DismissReason | null;
}

/**
 * A decision names what it is about: a garment (whose group is the one it
 * is a pick of, or resolved), or, for a need's own decisions and "Bought a
 * different one" (a garment that is none of its picks), the group.
 */
export type SuggestionDecision =
  | { kind: 'choose'; garmentId: number }
  | {
      kind: 'dismiss-pick';
      garmentId: number;
      /** The owner's one tap ("Not for me"). */
      reason: OwnerDismissReason;
      note: string | null;
    }
  | { kind: 'undo-pick'; garmentId: number }
  | {
      kind: 'dismiss-group';
      groupId: number;
      reason: OwnerDismissReason;
      note: string | null;
    }
  | { kind: 'undo-group'; groupId: number }
  | {
      kind: 'bought';
      garmentId: number;
      /** For a different one: the group it was bought for. */
      groupId?: number;
    }
  | { kind: 'returned'; garmentId: number };

/** The group's new state; `decided` stamps decided_at with the transaction's time, else clears it. */
interface GroupChange {
  status: OptionGroupStatus;
  resolvedGarmentId: number | null;
  decided: boolean;
  dismissedReason: OwnerDismissReason | null;
  /** Written only by dismiss-group; undefined leaves the stored note. */
  ownerNote?: string | null;
}

interface Dismissal {
  garmentId: number;
  reason: DismissReason | null;
  note: string | null;
}

/** The garment is not one of the group's (or has no group to decide). */
const NOT_IN_GROUP = { ok: false, refusal: 'not-in-group' } as const;
/** The group or pick is not where the decision applies (a stale page, a double tap): a 409. */
const NOT_ALLOWED = { ok: false, refusal: 'not-allowed' } as const;

export type DecisionOutcome =
  | {
      ok: true;
      /** Undefined: the group stays as it is. */
      group: GroupChange | undefined;
      dismiss: Dismissal[];
      /** Picks open again (their dismissal cleared). */
      restore: number[];
    }
  | typeof NOT_IN_GROUP
  | typeof NOT_ALLOWED;

const REOPENED: GroupChange = {
  status: 'open',
  resolvedGarmentId: null,
  decided: false,
  dismissedReason: null,
};

/**
 * A need still to buy for: open, or chosen and the chosen pick not bought
 * yet. "Bought a different one" takes only such a need.
 */
function stillToBuy(group: GroupState, picks: readonly PickState[]): boolean {
  if (group.status === 'open') return true;
  if (group.status !== 'resolved') return false;
  return picks.some(
    (pick) => pick.id === group.resolvedGarmentId && pick.wanted,
  );
}

/** A pick that can still be chosen or set aside: on the wishlist, not dismissed. */
function isOpen(pick: PickState): boolean {
  return pick.wanted && pick.dismissedAt === null;
}

/** The other open picks, set aside because another was chosen or bought. */
function othersAside(picks: readonly PickState[], kept: number): Dismissal[] {
  return picks
    .filter((pick) => pick.id !== kept && isOpen(pick))
    .map((pick) => ({
      garmentId: pick.id,
      reason: 'chose_another',
      note: null,
    }));
}

/**
 * What `decision` changes, or why it is refused. `group` is undefined for
 * a suggestion outside any group (only its own dismissal applies);
 * `picks` are the group's garments (its picks and its resolving garment),
 * or the lone suggestion.
 */
export function decideSuggestion(
  group: GroupState | undefined,
  picks: readonly PickState[],
  decision: SuggestionDecision,
): DecisionOutcome {
  switch (decision.kind) {
    case 'undo-group':
      return undoGroup(group, picks);
    case 'dismiss-group':
      return dismissGroup(group, decision);
    case 'bought':
      return boughtOf(group, picks, decision.garmentId);
    default: {
      const pick = picks.find((p) => p.id === decision.garmentId);
      return pick ? decideOnPick(group, picks, pick, decision) : NOT_IN_GROUP;
    }
  }
}

/** The need dropped without buying: only an open one, with the owner's reason and note. */
function dismissGroup(
  group: GroupState | undefined,
  decision: Extract<SuggestionDecision, { kind: 'dismiss-group' }>,
): DecisionOutcome {
  if (!group) return NOT_IN_GROUP;
  if (group.status !== 'open') return NOT_ALLOWED;
  return {
    ok: true,
    group: {
      status: 'dismissed',
      resolvedGarmentId: null,
      decided: true,
      dismissedReason: decision.reason,
      ownerNote: decision.note,
    },
    dismiss: [],
    restore: [],
  };
}

/** `garmentId` bought for the group: a pick, or a garment of the owner's own. */
function boughtOf(
  group: GroupState | undefined,
  picks: readonly PickState[],
  garmentId: number,
): DecisionOutcome {
  if (!group) return NOT_IN_GROUP;
  // The garment need not be a pick: "Bought a different one" resolves
  // the group with a garment of the owner's own, but only a need still
  // to buy for, so a second different one (two phones, a double post)
  // never takes the place of the first.
  if (!picks.some((pick) => pick.id === garmentId)) {
    return stillToBuy(group, picks)
      ? resolvedBy(picks, garmentId)
      : NOT_ALLOWED;
  }
  // A pick bought after the need was settled by another purchase (a
  // different one, or a sibling bought): the purchase is recorded and
  // the pick is no longer set aside, but the first purchase stays the
  // need's answer: resolved_garment_id is never overwritten.
  if (
    group.status === 'resolved' &&
    group.resolvedGarmentId !== garmentId &&
    !stillToBuy(group, picks)
  ) {
    return {
      ok: true,
      group: undefined,
      dismiss: [],
      restore: isSetAside(picks, garmentId) ? [garmentId] : [],
    };
  }
  return resolvedBy(picks, garmentId);
}

/** `garmentId` is one of `picks` and dismissed: buying or choosing it restores it. */
function isSetAside(picks: readonly PickState[], garmentId: number): boolean {
  return picks.some(
    (pick) => pick.id === garmentId && pick.dismissedAt !== null,
  );
}

/**
 * The group resolved by `garmentId`, every other open pick set aside. The
 * garment itself is no longer set aside if it was: chosen or bought, it is
 * the answer (a pick bought from its page after another was chosen).
 */
function resolvedBy(
  picks: readonly PickState[],
  garmentId: number,
): DecisionOutcome {
  return {
    ok: true,
    group: {
      status: 'resolved',
      resolvedGarmentId: garmentId,
      decided: true,
      dismissedReason: null,
    },
    dismiss: othersAside(picks, garmentId),
    restore: isSetAside(picks, garmentId) ? [garmentId] : [],
  };
}

/**
 * The siblings a choice set aside: dismissed chose_another in its own
 * transaction, so at the very time it stamped on the group, and still on
 * the wishlist. What its undo, or the chosen pick's own dismissal,
 * restores; not picks the owner set aside before.
 */
function choiceSiblings(
  group: GroupState,
  picks: readonly PickState[],
): number[] {
  const decidedAt = group.decidedAt?.getTime();
  return picks
    .filter(
      (p) =>
        p.wanted &&
        p.dismissedReason === 'chose_another' &&
        p.dismissedAt?.getTime() === decidedAt,
    )
    .map((p) => p.id);
}

/** The decisions about one of the group's garments. */
function decideOnPick(
  group: GroupState | undefined,
  picks: readonly PickState[],
  pick: PickState,
  decision: Extract<
    SuggestionDecision,
    { kind: 'choose' | 'dismiss-pick' | 'undo-pick' | 'returned' }
  >,
): DecisionOutcome {
  switch (decision.kind) {
    case 'choose':
      if (!group) return NOT_IN_GROUP;
      return group.status === 'open' && isOpen(pick)
        ? resolvedBy(picks, pick.id)
        : NOT_ALLOWED;
    case 'dismiss-pick':
      return dismissPick(group, picks, pick, decision);
    case 'undo-pick':
      return canRestore(group, pick)
        ? { ok: true, group: undefined, dismiss: [], restore: [pick.id] }
        : NOT_ALLOWED;
    case 'returned':
      return returnedOf(group, pick);
  }
}

/** The group `pick` settled: a chosen pick set aside, or a bought one returned, reopens it. */
function settledBy(
  group: GroupState | undefined,
  pick: PickState,
): GroupState | undefined {
  return group?.resolvedGarmentId === pick.id ? group : undefined;
}

/** An open pick set aside by the owner, with their reason and note. */
function dismissPick(
  group: GroupState | undefined,
  picks: readonly PickState[],
  pick: PickState,
  decision: Extract<SuggestionDecision, { kind: 'dismiss-pick' }>,
): DecisionOutcome {
  if (!isOpen(pick)) return NOT_ALLOWED;
  const settled = settledBy(group, pick);
  return {
    ok: true,
    group: settled ? REOPENED : undefined,
    dismiss: [
      { garmentId: pick.id, reason: decision.reason, note: decision.note },
    ],
    // The chosen one set aside: the options its choice set aside are
    // open again, as its undo would leave them.
    restore: settled ? choiceSiblings(settled, picks) : [],
  };
}

/** A bought garment returned: set aside `returned`, its need reopened if it settled one. */
function returnedOf(
  group: GroupState | undefined,
  pick: PickState,
): DecisionOutcome {
  if (pick.wanted || pick.dismissedReason === 'returned') {
    return NOT_ALLOWED;
  }
  return {
    ok: true,
    group: settledBy(group, pick) ? REOPENED : undefined,
    dismiss: [{ garmentId: pick.id, reason: 'returned', note: null }],
    restore: [],
  };
}

/** A pick set aside (not returned) and still wanted, whose group is open. */
function canRestore(group: GroupState | undefined, pick: PickState): boolean {
  return (
    pick.wanted &&
    pick.dismissedAt !== null &&
    pick.dismissedReason !== 'returned' &&
    (group === undefined || group.status === 'open')
  );
}

function undoGroup(
  group: GroupState | undefined,
  picks: readonly PickState[],
): DecisionOutcome {
  if (!group) return NOT_IN_GROUP;
  if (group.status === 'dismissed') {
    return { ok: true, group: REOPENED, dismiss: [], restore: [] };
  }
  if (group.status !== 'resolved') return NOT_ALLOWED;
  const resolver = picks.find((p) => p.id === group.resolvedGarmentId);
  // Resolved by a purchase: Returned is its undo. A resolving garment
  // deleted since (the foreign key nulled it) leaves nothing to keep.
  if (group.resolvedGarmentId !== null && !resolver?.wanted) {
    return NOT_ALLOWED;
  }
  return {
    ok: true,
    group: REOPENED,
    dismiss: [],
    restore: choiceSiblings(group, picks),
  };
}
