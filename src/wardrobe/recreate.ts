import { colorsGoTogether, neutralFor, rotationWeight } from './generator';
import {
  avoidedPairRule,
  compileRules,
  type OutfitRule,
  type RuleGarment,
} from './outfit-rules';
import {
  type GarmentColor,
  type InspirationPieceRole,
  type Pattern,
  pieceCategory,
} from './properties';

/**
 * "Recreate this look" (#22; docs/plans/2026-11-13-inspiration-library.md,
 * section 4): the owner's closet garments closest to each piece they tagged
 * in a saved look, chosen so the chosen set goes together. Pure and
 * deterministic (no seed: every tie has an order), so the look's match
 * view (src/web/inspiration) and, later, MCP's get_inspiration answer the
 * same for the same closet.
 *
 * - **Candidates** for a piece are the closet's garments of its role
 *   (the caller passes inCloset garments: dirty and away ones too, a look
 *   is recreated from what the owner has, not from what is clean today).
 * - **Ranking**, in this order: the type equal; the colours (the piece's
 *   main colour, then its accent; equal before a close shade, CLOSE_COLORS);
 *   the pattern equal; then available before not, the most rested
 *   (rotationWeight), the oldest id.
 * - **The floor**: a garment is a match only when it shares the piece's
 *   type or one of its colours (a close shade counts). A piece naming
 *   neither takes any garment of its role. A piece with no match is missing.
 * - **Saved choices** are pinned: a garment saved for a piece that still
 *   matches it (it is in the closet and clears the floor) is that piece's
 *   garment before anything is ranked or matched, always among its matches
 *   however far down its ranking, and no other piece is offered or given
 *   it (the first piece to name one keeps it). The rest are matched around
 *   them, so the chosen garments are unique by construction.
 * - **Going together**: the chosen set must pass the generator's colour and
 *   pattern rule (colorsGoTogether) and break none of the owner's
 *   never-rules (avoided pairs included), and no garment fills two pieces:
 *   when pieces outnumber their garments, the most pieces are filled (a
 *   flexible piece yields another's only garment), each in look order
 *   keeping the closest that costs no later piece its garment.
 *   What the look itself breaks is excused (the owner saved it: the pieces
 *   judged as garments), as the generator excuses a rule two locked
 *   garments break. When the closest set clashes, the sets that stray
 *   least from it are tried (fewest steps down the pieces' rankings, the
 *   loudest piece moved first); when none within the search goes, the
 *   closest are kept and the clashing pieces named (`unfixed`).
 */

/** What a piece of a look is read as (inspiration_piece). */
export interface LookPiece {
  role: InspirationPieceRole;
  type: string | null;
  /** The main colour first, then an accent: at most INSPIRATION_PIECE_MAX_COLORS. */
  colors: readonly GarmentColor[];
  pattern: Pattern | null;
}

/** A closet garment as the matching reads it. */
export interface RecreateGarment extends RuleGarment {
  /** isAvailable: in the closet, not away, a clean copy left. */
  available: boolean;
  /** Whole days since last worn; null when never. */
  idleDays: number | null;
}

export interface RecreateRequest<G extends RecreateGarment> {
  pieces: readonly LookPiece[];
  /** The owner's closet garments (inCloset). */
  closet: readonly G[];
  /** Garment pairs never to combine (generator_avoid). */
  avoid: readonly (readonly [number, number])[];
  /** The owner's outfit rules: the never-rules are read. */
  rules: readonly OutfitRule[];
  /**
   * The garment saved for each piece, in `pieces` order (null: none), a
   * choice the owner made: pinned (see the module comment).
   */
  saved?: readonly (number | null)[];
}

/** How a match agrees with its piece, for the page to say. */
export interface Agreement {
  type: boolean;
  /** 'exact': the main colour; 'close': a close shade of it, or the accent. */
  color: 'exact' | 'close' | null;
  pattern: boolean;
}

export interface PieceMatch<G> {
  garment: G;
  agrees: Agreement;
}

interface RecreatedPiece<G> {
  /** The chosen match, then the next best: at most MATCHES_PER_PIECE; empty when missing. */
  matches: PieceMatch<G>[];
  /** The chosen one is not the closest: the closest did not go with the rest. */
  repicked: boolean;
}

export interface Recreation<G> {
  /** In the request's piece order. */
  pieces: RecreatedPiece<G>[];
  /** Pieces (indices) whose matches clash and that no re-pick within the search mended. */
  unfixed: number[];
}

/** Matches shown per piece: the chosen one and two alternates. */
export const MATCHES_PER_PIECE = 3;

/** How far down a piece's ranking the re-pick looks. */
const SEARCH_DEPTH = 6;

/** Sets the re-pick tries at most: bounds the work on a look of many pieces. */
const MAX_TRIES = 500;

/**
 * Shades read as close to each other, both ways round: what a photo's navy
 * is in a closet that says black or blue. A judgement, kept small: a close
 * shade ranks below the colour itself.
 */
const CLOSE_COLORS: readonly (readonly [GarmentColor, GarmentColor])[] = [
  ['black', 'grey'],
  ['black', 'blue'],
  ['grey', 'white'],
  ['grey', 'silver'],
  ['white', 'beige'],
  ['beige', 'brown'],
  ['brown', 'orange'],
  ['red', 'pink'],
  ['red', 'orange'],
  ['red', 'purple'],
  ['pink', 'purple'],
  ['orange', 'yellow'],
  ['yellow', 'gold'],
  ['blue', 'purple'],
];

function closeShades(a: GarmentColor, b: GarmentColor): boolean {
  return CLOSE_COLORS.some(
    ([x, y]) => (x === a && y === b) || (x === b && y === a),
  );
}

/** One colour of the piece against the garment's: 2 equal, 1 a close shade, 0 neither. */
function colorHit(color: GarmentColor, garment: RuleGarment): number {
  if (garment.colors.includes(color)) return 2;
  return garment.colors.some((c) => closeShades(color, c)) ? 1 : 0;
}

interface Scored<G> {
  garment: G;
  agrees: Agreement;
  /** The colours' part of the ranking: the main colour's hit weighs over the accent's. */
  colorScore: number;
}

function score<G extends RecreateGarment>(
  piece: LookPiece,
  garment: G,
): Scored<G> {
  const [main, accent] = piece.colors;
  const mainHit = main === undefined ? 0 : colorHit(main, garment);
  const accentHit = accent === undefined ? 0 : colorHit(accent, garment);
  return {
    garment,
    colorScore: mainHit * 3 + accentHit,
    agrees: {
      type: piece.type !== null && garment.type === piece.type,
      color: colorAgreement(mainHit, accentHit),
      pattern: piece.pattern !== null && garment.pattern === piece.pattern,
    },
  };
}

function colorAgreement(
  mainHit: number,
  accentHit: number,
): Agreement['color'] {
  if (mainHit === 2) return 'exact';
  return mainHit + accentHit > 0 ? 'close' : null;
}

function isMatch(piece: LookPiece, { agrees }: Scored<RecreateGarment>) {
  const namesNothing = piece.type === null && piece.colors.length === 0;
  return namesNothing || agrees.type || agrees.color !== null;
}

type Comparison = (
  a: Scored<RecreateGarment>,
  b: Scored<RecreateGarment>,
) => number;

/** Best first, each key breaking the previous one's ties: the order the module's comment gives. */
const RANKING: readonly Comparison[] = [
  (a, b) => Number(b.agrees.type) - Number(a.agrees.type),
  (a, b) => b.colorScore - a.colorScore,
  (a, b) => Number(b.agrees.pattern) - Number(a.agrees.pattern),
  (a, b) => Number(b.garment.available) - Number(a.garment.available),
  (a, b) => rotationWeight(b.garment) - rotationWeight(a.garment),
  // Ids last, so the order is total.
  (a, b) => a.garment.id - b.garment.id,
];

function byCloseness(
  a: Scored<RecreateGarment>,
  b: Scored<RecreateGarment>,
): number {
  for (const compare of RANKING) {
    const order = compare(a, b);
    if (order !== 0) return order;
  }
  return 0;
}

/** A piece's matches in the closet, best first; empty when it is missing. */
function ranked<G extends RecreateGarment>(
  piece: LookPiece,
  closet: readonly G[],
): Scored<G>[] {
  return closet
    .filter((garment) => garment.role === piece.role)
    .map((garment) => score(piece, garment))
    .filter((scored) => isMatch(piece, scored))
    .sort(byCloseness);
}

/** The piece as a garment, for judging what the look itself breaks (no closet id is negative). */
function asGarment(piece: LookPiece, index: number): RuleGarment {
  return {
    id: -(index + 1),
    role: piece.role,
    category: pieceCategory(piece.role),
    type: piece.type,
    colors: piece.colors,
    pattern: piece.pattern,
  };
}

/**
 * Accents and a loud pattern, of a piece or a garment: the pieces the
 * re-pick moves first, and the garments named when the colours clash.
 */
function loudness(item: Pick<RuleGarment, 'role' | 'colors' | 'pattern'>) {
  const accents = item.colors.filter(
    (c) => c !== 'pattern' && !neutralFor(item.role, c),
  ).length;
  const loud =
    (item.pattern !== null && item.pattern !== 'solid') ||
    item.colors.includes('pattern');
  return accents + (loud ? 1 : 0);
}

/** Judges a chosen set: what the look breaks itself is excused. */
function judgeOf(request: RecreateRequest<RecreateGarment>) {
  const look = request.pieces.map(asGarment);
  const all: OutfitRule[] = [
    ...request.rules.filter((rule) => rule.kind === 'never'),
    ...request.avoid.map(([a, b]) => avoidedPairRule(a, b)),
  ];
  const excused = new Set(compileRules(all).brokenAmong(look));
  const rules = compileRules(all.filter((rule) => !excused.has(rule)));
  const colorsExcused = !colorsGoTogether(look);
  return {
    colors: (set: readonly RecreateGarment[]) =>
      colorsExcused || colorsGoTogether(set),
    clash: (g: RuleGarment, h: RuleGarment) => rules.clash(g, h),
  };
}

type Judge = ReturnType<typeof judgeOf>;

function goesTogether(set: readonly RecreateGarment[], judge: Judge): boolean {
  if (new Set(set.map((g) => g.id)).size < set.length) return false;
  if (!judge.colors(set)) return false;
  return !set.some((g, i) => set.slice(i + 1).some((h) => judge.clash(g, h)));
}

/**
 * The step down each ranking (by `order`'s position) for every way to stray
 * `total` steps in all, the first of `order` taking the most: the loudest
 * piece moves first.
 */
function* spreads(
  depths: readonly number[],
  total: number,
): Generator<number[]> {
  if (depths.length === 0) {
    if (total === 0) yield [];
    return;
  }
  const [first, ...rest] = depths;
  for (let step = Math.min(total, first - 1); step >= 0; step -= 1) {
    for (const tail of spreads(rest, total - step)) yield [step, ...tail];
  }
}

/** A piece with at least one match: its index in the look and its ranking. */
interface Matched<G> {
  index: number;
  ranking: Scored<G>[];
  loud: number;
}

/**
 * The steps down each matched piece's ranking of the set that strays least
 * and goes together, or undefined when none within the search does.
 */
function repick<G extends RecreateGarment>(
  matched: readonly Matched<G>[],
  judge: Judge,
): Map<number, number> | undefined {
  const order = [...matched].sort(
    (a, b) => b.loud - a.loud || a.index - b.index,
  );
  const depths = order.map((m) => Math.min(m.ranking.length, SEARCH_DEPTH));
  const most = depths.reduce((sum, depth) => sum + depth - 1, 0);
  let tries = 0;
  for (let total = 0; total <= most; total += 1) {
    for (const steps of spreads(depths, total)) {
      tries += 1;
      if (tries > MAX_TRIES) return undefined;
      const set = order.map((m, i) => m.ranking[steps[i]].garment);
      if (goesTogether(set, judge)) {
        return new Map(order.map((m, i) => [m.index, steps[i]]));
      }
    }
  }
  return undefined;
}

/**
 * The most pieces one garment each can fill (Kuhn's augmenting paths):
 * `fixed` pieces keep the garment (or the absence, -1) they are fixed to.
 */
function maximumFilled<G extends RecreateGarment>(
  matched: readonly Matched<G>[],
  fixed: ReadonlyMap<number, number>,
): number {
  const holder = new Map<number, number>();
  for (const [i, id] of fixed) if (id >= 0) holder.set(id, i);
  const augment = (i: number, seen: Set<number>): boolean =>
    matched[i].ranking.some(({ garment: { id } }) => {
      if (seen.has(id)) return false;
      seen.add(id);
      const held = holder.get(id);
      if (held !== undefined && (fixed.has(held) || !augment(held, seen))) {
        return false;
      }
      holder.set(id, i);
      return true;
    });
  let filled = [...fixed.values()].filter((id) => id >= 0).length;
  matched.forEach((_, i) => {
    if (!fixed.has(i) && augment(i, new Set())) filled += 1;
  });
  return filled;
}

/**
 * One garment per piece, as many pieces filled as the closet allows; among
 * the ways to fill that many, each piece in turn takes the closest garment
 * that still lets the later ones fill as many (a piece goes missing only
 * when every garment of its would cost another piece its own). Answers
 * each placed piece's step down its ranking.
 */
function assignment<G extends RecreateGarment>(
  matched: readonly Matched<G>[],
): Map<number, number> {
  // A piece among k never needs a garment below its k-th: of its first k,
  // the other k - 1 pieces can hold at most k - 1.
  const short = matched.map((m) => ({
    ...m,
    ranking: m.ranking.slice(0, matched.length),
  }));
  const most = maximumFilled(short, new Map());
  const fixed = new Map<number, number>();
  const steps = new Map<number, number>();
  short.forEach(({ index, ranking }, i) => {
    const step = ranking.findIndex(({ garment: { id } }) => {
      if ([...fixed.values()].includes(id)) return false;
      return maximumFilled(short, new Map(fixed).set(i, id)) === most;
    });
    fixed.set(i, step < 0 ? -1 : ranking[step].garment.id);
    if (step >= 0) steps.set(index, step);
  });
  return steps;
}

/** The placed pieces whose garments break a never-rule or the colour rule. */
function clashingPieces<G extends RecreateGarment>(
  matched: readonly Matched<G>[],
  steps: ReadonlyMap<number, number>,
  judge: Judge,
): number[] {
  const chosen = matched.flatMap(({ index, ranking }) => {
    const step = steps.get(index);
    return step === undefined
      ? []
      : [{ index, garment: ranking[step].garment }];
  });
  const clashing = new Set<number>();
  chosen.forEach((a, i) =>
    chosen.slice(i + 1).forEach((b) => {
      if (judge.clash(a.garment, b.garment)) {
        clashing.add(a.index);
        clashing.add(b.index);
      }
    }),
  );
  if (!judge.colors(chosen.map((c) => c.garment))) {
    for (const { index, garment } of chosen) {
      if (loudness(garment) > 0) clashing.add(index);
    }
  }
  return [...clashing].sort((a, b) => a - b);
}

/**
 * Each matched piece's step down its ranking. The assignment first fixes
 * which pieces are filled (two pieces, one garment: one goes missing, and
 * its duplicate alone would sink every set) and is kept when it goes
 * together; when it clashes, the set that strays least and goes together;
 * failing that, the assignment kept and the clash named.
 */
function chosenSteps<G extends RecreateGarment>(
  matched: readonly Matched<G>[],
  judge: Judge,
): { steps: Map<number, number>; unfixed: number[] } {
  const assigned = assignment(matched);
  const placed = matched.filter((m) => assigned.has(m.index));
  const set = placed.map((m) => m.ranking[assigned.get(m.index) ?? 0].garment);
  if (goesTogether(set, judge)) return { steps: assigned, unfixed: [] };
  const found = repick(placed, judge);
  if (found) return { steps: found, unfixed: [] };
  return {
    steps: assigned,
    unfixed: clashingPieces(placed, assigned, judge),
  };
}

/**
 * The garment each piece is pinned to: its saved one while that still
 * matches the piece, the first piece to name a garment keeping it.
 */
function pins<G extends RecreateGarment>(
  request: RecreateRequest<G>,
  rankings: readonly Scored<G>[][],
): Map<number, Scored<G>> {
  const pinned = new Map<number, Scored<G>>();
  const taken = new Set<number>();
  rankings.forEach((ranking, index) => {
    const id = request.saved?.[index];
    const found = ranking.find(({ garment }) => garment.id === id);
    if (found && !taken.has(found.garment.id)) {
      taken.add(found.garment.id);
      pinned.set(index, found);
    }
  });
  return pinned;
}

export function recreateLook<G extends RecreateGarment>(
  request: RecreateRequest<G>,
): Recreation<G> {
  const full = request.pieces.map((piece) => ranked(piece, request.closet));
  const pinned = pins(request, full);
  const pinnedIds = new Set([...pinned.values()].map((s) => s.garment.id));
  // What each piece is offered: its ranking without the garments pinned to
  // another piece.
  const offered = full.map((ranking, index) =>
    ranking.filter(
      ({ garment }) =>
        pinned.get(index)?.garment.id === garment.id ||
        !pinnedIds.has(garment.id),
    ),
  );
  // What the matching may choose from: a pinned piece has only its pin.
  const matched = request.pieces.flatMap((piece, index) => {
    const pin = pinned.get(index);
    const ranking = pin ? [pin] : offered[index];
    return ranking.length > 0
      ? [{ index, ranking, loud: loudness(piece) }]
      : [];
  });
  const judge = judgeOf(request);
  const { steps, unfixed } = chosenSteps(matched, judge);
  return {
    pieces: offered.map((ranking, index) => {
      const step = steps.get(index);
      if (step === undefined) return { matches: [], repicked: false };
      const pin = pinned.get(index);
      const chosen = pin ?? ranking[step];
      return {
        matches: [chosen, ...ranking.filter((s) => s !== chosen)]
          .slice(0, MATCHES_PER_PIECE)
          .map(({ garment, agrees }) => ({ garment, agrees })),
        repicked: step > 0,
      };
    }),
    unfixed,
  };
}
