/**
 * Where an agent outfit is in the owner's reaction to their agent's design
 * (#335; first the plans' looks, #290): an outfit the agent proposed,
 * owned garments and its suggestions together. Stored as outfit.reaction
 * (a check constraint lists LOOK_REACTIONS), null on an outfit of the
 * owner's own, written `proposed` by the outfit writer's proposal and
 * changed afterwards only by reactToOutfit (src/web/outfits/reactions.ts),
 * which holds the owner lock, asks lookReactionTransition and writes what
 * it answers. Pure.
 *
 *   event        from                       to         owner's note
 *   love         proposed, revise           loved      cleared
 *   change       proposed, loved            revise     written (required)
 *   decline      proposed, revise, loved    declined   written (optional)
 *   repropose    revise, loved              proposed   kept
 *   reconsider   declined                   proposed   cleared
 *
 * - proposed: the agent wrote it (proposed, or changed it) and the owner
 *   has not reacted.
 * - loved: "Love it". Not final: the owner may still ask for a change or
 *   turn it down.
 * - revise: "Change this" (the owner's note required): waiting on the agent.
 * - declined: "Not for me" (a note optional). Kept, not deleted, so the
 *   agent never proposes its exact pieces again.
 *
 * Who moves what:
 * - love, change, decline, reconsider: the owner.
 * - love from revise: the owner takes the look as it was after all.
 * - decline from revise or loved: the owner changes their mind.
 * - repropose: the agent's update of a look sent back or loved. An agent
 *   editing its own still-proposed look is a content edit, not a move;
 *   anything the agent would do to a declined look is refused.
 *
 * Refused on purpose: every self-move (events name the move, so a stale
 * page or a double tap cannot apply one twice).
 */

export const LOOK_REACTIONS = [
  'proposed',
  'loved',
  'revise',
  'declined',
] as const;
export type LookReaction = (typeof LOOK_REACTIONS)[number];

export const LOOK_REACTION_EVENTS = [
  'love',
  'change',
  'decline',
  'repropose',
  'reconsider',
] as const;
export type LookReactionEvent = (typeof LOOK_REACTION_EVENTS)[number];

/** What a move does to the owner's note. */
export type LookNoteEffect = 'write' | 'keep' | 'clear';

const EDGES: Record<
  LookReactionEvent,
  { from: readonly LookReaction[]; to: LookReaction; note: LookNoteEffect }
> = {
  love: { from: ['proposed', 'revise'], to: 'loved', note: 'clear' },
  change: { from: ['proposed', 'loved'], to: 'revise', note: 'write' },
  decline: {
    from: ['proposed', 'revise', 'loved'],
    to: 'declined',
    note: 'write',
  },
  // The note stays, so the owner reacting to the revision sees what they asked.
  repropose: { from: ['revise', 'loved'], to: 'proposed', note: 'keep' },
  reconsider: { from: ['declined'], to: 'proposed', note: 'clear' },
};

export type LookReactionTransition =
  | { ok: true; from: LookReaction; to: LookReaction; note: LookNoteEffect }
  /** The reaction does not take the event; `reaction` is where it stays. */
  | { ok: false; reaction: LookReaction };

/** The reaction after `event`, or a refusal. */
export function lookReactionTransition(
  reaction: LookReaction,
  event: LookReactionEvent,
): LookReactionTransition {
  const edge = EDGES[event];
  return edge.from.includes(reaction)
    ? { ok: true, from: reaction, to: edge.to, note: edge.note }
    : { ok: false, reaction };
}

/**
 * The move an agent's rewrite of a look makes: none for its own
 * still-proposed look (a content edit), else `repropose`, which a declined
 * look refuses.
 */
export function agentRewriteEvent(
  reaction: LookReaction,
): LookReactionEvent | null {
  return reaction === 'proposed' ? null : 'repropose';
}
