import type { OutfitCount } from '../../wardrobe/goes-with';
import { garmentMarks } from '../../wardrobe/marks';
import { OUTFIT_DISMISS_REASONS } from '../../wardrobe/suggestions';
import { PostForm } from '../form';
import { imageUrl } from '../files/image-url';
import { enlargeLabel, PhotoSet, viewerTrigger } from '../files/photo-viewer';
import { unlocksText } from '../gallery/goes-with';
import { t } from '../i18n';
import { suggestingAgentName } from '../write-origin';
import { AGENT_GRID, AGENT_PIECES } from '../layout/columns';
import { GarmentMark, markLabel } from '../layout/garment-mark';
import { HangerIcon } from '../layout/parts';
import { stylingUrl } from '../styling/urls';
import { categoryLabel, priceLabel } from '../wardrobe/garment';
import { NotForMe, reasonText, UndoForm } from '../wishlist/suggestion-parts';
import { isSetAside, type AgentOutfit, type AgentPiece } from './proposals';
import { isPieceToBuy } from './references';
import { outfitUrl } from './urls';

/**
 * The Outfits tab's From the agent section (#335, docs/plans/2026-10-05-agent-
 * suggestions.md section 4 B): the agent's outfits waiting on the owner as large
 * cards, every piece big (a tap opens the photo viewer), pieces to buy
 * badged with their price and what they unlock; then those set aside,
 * collapsed, each with Undo. One markup: a card per row on a phone, two
 * from `lg` (AGENT_GRID), the four pieces of a row filling the card. Static: the bytes change only
 * when an outfit or a piece does, so bare /outfits stays byte-stable.
 */
export function AgentSection(props: {
  outfits: readonly AgentOutfit[];
  unlocks: ReadonlyMap<number, OutfitCount>;
}) {
  const waiting = props.outfits.filter((item) => !isSetAside(item));
  const setAside = props.outfits.filter(isSetAside);
  if (props.outfits.length === 0) return null;
  return (
    <section
      class="flex flex-col gap-3"
      aria-labelledby="agent-outfits-title"
      data-agent-outfits=""
    >
      {waiting.length > 0 && (
        <>
          <h2 id="agent-outfits-title" class="font-semibold px-1">
            {t('outfits.agent.TITLE', { agent: agentOf(waiting) })}{' '}
            <span class="font-normal text-muted">· {waiting.length}</span>
          </h2>
          <ul class={AGENT_GRID}>
            {waiting.map((item, index) => (
              <AgentCard
                item={item}
                unlocks={props.unlocks}
                eager={index < 2}
              />
            ))}
          </ul>
        </>
      )}
      {setAside.length > 0 && <SetAside outfits={setAside} />}
    </section>
  );
}

/** The agent's name as the token says it; "the agent" when none did. */
function agentOf(outfits: readonly AgentOutfit[]): string {
  return suggestingAgentName(outfits.find((o) => o.agent)?.agent ?? null);
}

/** Where a card's moves come back to: the tab, at the card. */
const RETURN_TO = '/outfits';

/** What the card leads with, by where the outfit stands (one primary). */
type Primary =
  | { kind: 'save' | 'love' }
  | { kind: 'choose'; piece: AgentPiece }
  | { kind: 'replace'; piece: AgentPiece };

function primaryOf(item: AgentOutfit): Primary {
  const setAsidePiece = item.pieces.find((p) => p.setAside);
  if (setAsidePiece) return { kind: 'replace', piece: setAsidePiece };
  const toBuy = item.pieces.find(isPieceToBuy);
  if (item.reaction === 'loved' && toBuy)
    return { kind: 'choose', piece: toBuy };
  return { kind: toBuy ? 'love' : 'save' };
}

function AgentCard(props: {
  item: AgentOutfit;
  unlocks: ReadonlyMap<number, OutfitCount>;
  eager: boolean;
}) {
  const { item } = props;
  const viewerSet = `agent-outfit-${item.id}-photos`;
  const primary = primaryOf(item);
  const name = item.name || t('UNTITLED_OUTFIT');
  return (
    <li
      id={`agent-outfit-${item.id}`}
      data-agent-outfit={String(item.id)}
      data-reaction={item.reaction}
      class="flex flex-col gap-3 rounded-box border border-base-300 bg-base-100 p-4 lg:p-3"
    >
      <div class="flex flex-col gap-1">
        <div class="flex items-start justify-between gap-2">
          <h3 class="font-medium leading-snug break-words min-w-0">
            <a href={outfitUrl(item.id)} class="link link-hover">
              {name}
            </a>
          </h3>
          {item.reaction === 'loved' && (
            <span class="badge badge-sm badge-soft badge-primary shrink-0">
              {t('outfits.agent.LOVED')}
            </span>
          )}
        </div>
        {item.note && (
          <p class="text-sm text-muted line-clamp-2" data-agent-note="">
            {item.note}
          </p>
        )}
        {item.reaction === 'revise' && item.ownerNote && (
          <p class="text-sm" data-owner-note="">
            {t('outfits.agent.YOU_ASKED', { note: item.ownerNote })}
          </p>
        )}
        {primary.kind === 'replace' && (
          <p class="text-sm text-warning" data-needs-replacement="">
            {t('outfits.agent.NEEDS_REPLACEMENT', {
              name: pieceName(primary.piece),
            })}
          </p>
        )}
      </div>
      <PhotoSet
        id={viewerSet}
        photos={item.pieces.flatMap((piece) =>
          piece.photo ? [{ photo: piece.photo, alt: pieceName(piece) }] : [],
        )}
      />
      <ul class={AGENT_PIECES}>
        {item.pieces.map((piece) => (
          <PieceTile
            piece={piece}
            unlocks={props.unlocks.get(piece.id)}
            viewerSet={viewerSet}
            eager={props.eager}
          />
        ))}
      </ul>
      <div class="mt-auto flex flex-wrap items-center gap-2 border-t border-base-300 pt-3">
        <PrimaryAction item={item} primary={primary} />
        {primary.kind !== 'replace' && (
          <a
            href={stylingUrl({
              outfitId: item.id,
              picks: true,
              returnTo: RETURN_TO,
            })}
            class="link link-hover text-sm"
          >
            {t('outfits.EDIT')}
          </a>
        )}
        <div class="ml-auto">
          <NotForMe
            action={`${outfitUrl(item.id)}/dismiss`}
            returnTo={RETURN_TO}
            reasons={OUTFIT_DISMISS_REASONS}
            label={`× ${t('agent.NOT_FOR_ME')}`}
          />
        </div>
      </div>
    </li>
  );
}

function PrimaryAction(props: { item: AgentOutfit; primary: Primary }) {
  const { item, primary } = props;
  switch (primary.kind) {
    case 'save':
    case 'love':
      return (
        <PostForm action={`${outfitUrl(item.id)}/love`}>
          <input type="hidden" name="returnTo" value={RETURN_TO} />
          <button
            type="submit"
            class="btn btn-primary"
            data-agent-primary={primary.kind}
          >
            {t(
              primary.kind === 'save'
                ? 'outfits.agent.SAVE'
                : 'outfits.agent.LOVE',
            )}
          </button>
        </PostForm>
      );
    case 'choose':
      return (
        <a
          href={`/wardrobe/${primary.piece.id}`}
          class="btn btn-primary"
          data-agent-primary="choose"
        >
          {t('outfits.agent.CHOOSE_PIECES')}
        </a>
      );
    case 'replace':
      return (
        <a
          href={stylingUrl({
            outfitId: item.id,
            picks: true,
            returnTo: RETURN_TO,
          })}
          class="btn btn-primary"
          data-agent-primary="replace"
        >
          {t('outfits.EDIT')}
        </a>
      );
  }
}

const pieceName = (piece: AgentPiece) =>
  piece.name ?? categoryLabel(piece.category);

/**
 * A piece's mark, none when it is owned: set aside, or to buy, which wears its price in
 * the mark's look when it has one; `label` is what the badge says.
 */
function pieceMark(piece: AgentPiece) {
  // The agent's cards are the owner's alone.
  const marks = garmentMarks(piece, { ownerView: true });
  const [first] = marks;
  if (first === undefined) return undefined;
  const price =
    first === 'to-buy' && piece.price ? priceLabel(piece.price) : undefined;
  return { marks, price, label: price ?? markLabel(first) };
}

/**
 * One piece, big: its photo on the plinth colour (a tap opens the viewer,
 * which names it; the button's label does too). No name under it: the
 * card is the pieces. A marked piece wears its mark over its foot, the
 * link to its page: a piece to buy its price (or "To buy"; its page has
 * This one, Bought it and its need's options), a set-aside pick "Set
 * aside", an archived piece "Archived". A piece to buy also shows, when it
 * is a number worth reading, what it
 * unlocks with the closet, never at the cap ("50+", which a large closet
 * gives most pieces and so tells nothing, the inbox's rule).
 */
function PieceTile(props: {
  piece: AgentPiece;
  unlocks: OutfitCount | undefined;
  viewerSet: string;
  eager: boolean;
}) {
  const { piece } = props;
  const name = pieceName(piece);
  const toBuy = isPieceToBuy(piece);
  const mark = pieceMark(piece);
  return (
    <li class="flex flex-col gap-1 min-w-0" data-piece={String(piece.id)}>
      {/* The badge sits outside the clipped photo frame, so its 44 px hit area is never cut off. */}
      <div class="relative">
        <div class="aspect-square overflow-hidden rounded-box bg-base-200 flex items-center justify-center p-1 sm:p-2">
          {piece.photo ? (
            <button
              type="button"
              class="size-full cursor-zoom-in"
              aria-label={enlargeLabel(name)}
              {...viewerTrigger(props.viewerSet, piece.photo)}
            >
              <img
                src={imageUrl(piece.photo, 'thumb')}
                alt=""
                class="size-full object-contain"
                width="200"
                height="200"
                loading={props.eager ? 'eager' : 'lazy'}
                decoding="async"
              />
            </button>
          ) : (
            <HangerIcon class="size-8 text-muted" strokeWidth="1.5" />
          )}
        </div>
        {mark && (
          // The piece's page (This one, Bought it, its need's options): the
          // badge is the link, its hit area a 44 px band centred on it (the
          // ::after, never clipped); the rest of the tile opens the viewer.
          <a
            href={`/wardrobe/${piece.id}`}
            class="absolute bottom-0.5 sm:bottom-1.5 left-1/2 -translate-x-1/2 flex after:absolute after:-inset-x-2 after:top-1/2 after:h-11 after:-translate-y-1/2"
            aria-label={t('outfits.agent.PIECE_LINK', {
              name,
              label: mark.label,
            })}
            data-piece-link=""
          >
            <GarmentMark
              marks={mark.marks}
              text={mark.price}
              class="sm:badge-sm"
            />
          </a>
        )}
      </div>
      {toBuy && props.unlocks && !props.unlocks.capped && (
        <a
          href={`/wardrobe/${piece.id}`}
          class="text-xs link link-hover inline-flex items-start leading-tight"
          data-unlocks-link=""
        >
          {unlocksText(props.unlocks)}
        </a>
      )}
    </li>
  );
}

/** The agent's outfits set aside, collapsed under one count: each with its reason and Undo. */
function SetAside({ outfits }: { outfits: readonly AgentOutfit[] }) {
  return (
    <details class="px-1" data-agent-set-aside="">
      <summary class="link link-hover text-sm text-muted flex items-center">
        {t('outfits.agent.SET_ASIDE_COUNT', { count: outfits.length })}
      </summary>
      <ul class="flex flex-col gap-1 pt-1">
        {outfits.map((item) => (
          <li
            class="flex items-center justify-between gap-2"
            data-agent-set-aside-outfit={String(item.id)}
          >
            <span class="text-sm min-w-0 truncate">
              {item.name || t('UNTITLED_OUTFIT')}
              {item.dismissedReason && (
                <span class="text-muted">
                  {' · '}
                  {reasonText(item.dismissedReason)}
                </span>
              )}
            </span>
            <UndoForm
              action={`${outfitUrl(item.id)}/undo`}
              returnTo={RETURN_TO}
              ariaLabel={t('outfits.agent.UNDO_LABEL', {
                name: item.name || t('UNTITLED_OUTFIT'),
              })}
            />
          </li>
        ))}
      </ul>
    </details>
  );
}
