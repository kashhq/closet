import type { GarmentMarkKind } from '../../wardrobe/marks';
import { DEFAULT_OCCASION, OCCASIONS } from '../../wardrobe/occasions';
import { PostForm } from '../form';
import { dayLabel, occasionLabel } from '../date-labels';
import { defaultsToToday } from '../day-time';
import { AlreadySavedToast } from '../gallery/already-saved';
import type { AlreadySaved } from '../gallery/urls';
import { t } from '../i18n';
import { museName } from '../write-origin';
import { AgentBadge } from '../agent-badge';
import { PageShell } from '../layout/page-shell';
import { GarmentThumb } from '../layout/parts';
import { Sheet, SheetCancel, sheetOpener } from '../layout/sheet';
import { EntrySelfie, SelfieView } from '../selfies/views';
import {
  type PublicShare,
  PublicSharePanel,
  ShareLinkButton,
} from '../share/share-button';
import { stylingUrl } from '../styling/urls';
import type { ViewContext } from '../view-context';
import { collagePieces, FootMark, OutfitCollage } from './collage';
import type {
  OutfitEntries,
  OutfitPageDetail,
  OutfitProposal,
  OutfitSummary,
  PlannedDay,
  WornDay,
} from './queries';
import { OUTFIT_DISMISS_REASONS } from '../../wardrobe/suggestions';
import {
  type DecisionToast,
  DecisionToastView,
  NotForMe,
  reasonText,
  UndoForm,
} from '../wishlist/suggestion-parts';
import { piecesToBuy } from './references';
import { ToBuySection } from './to-buy';
import { outfitUrl } from './urls';

const PLAN_SHEET_ID = 'outfit-plan-sheet';

/** A garment of the outfit with the marks its collage and list show. */
type OutfitPiece = OutfitSummary['garments'][number] & {
  marks: GarmentMarkKind[];
};

/**
 * GET /outfits/:id (redesign plan, "Outfits"; R5): the outfit as a record,
 * not an event. The collage, then its two actions, Plan (a sheet: a day and
 * an occasion, POST /calendar) and Edit in Styling (#42); while it is
 * incomplete (#335: pieces not bought yet, so never planned) the pieces to
 * buy come first and Plan is not offered (Styling keeps a piece to buy as
 * the row it is, so an edit can rename the outfit or swap a piece); then what its
 * calendar entries say, read rather than stored (plan section 1): the days
 * it is planned for, the days it was worn with their selfies (#19); then its
 * garments, each opening its page. Share and Delete are in the app bar's ⋯
 * menu; "Shared publicly" (its link and Stop) under the collage while
 * shared. The owner's own page (outfits are private); the public share page
 * (src/web/share) shows the garments only, never the entries.
 */
export function OutfitPage(props: {
  ctx: ViewContext;
  outfit: OutfitPageDetail;
  entries: OutfitEntries;
  /** The gallery's pick or a save found this outfit already saved (?alreadySaved=). */
  alreadySaved?: AlreadySaved;
  /** A reaction to Muse's proposal came back here (`?decided=`). */
  toast?: DecisionToast;
}) {
  const { ctx, outfit, entries } = props;
  const name = outfit.name || t('UNTITLED_OUTFIT');
  const toBuy = piecesToBuy(outfit.garments);
  // The owner's own outfit (outfitDetailSql), so their records show, on the
  // collage and on the strip below it.
  const pieces = collagePieces(outfit.garments, {
    warn: true,
    ownerView: true,
  });
  // Plan is offered only where the outfit may be held (outfitMayBeHeld):
  // complete, and the owner's (not one of Muse's proposals until saved).
  const mayBePlanned =
    toBuy.length === 0 &&
    (!outfit.proposal || outfit.proposal.reaction === 'loved');
  return (
    <PageShell
      ctx={ctx}
      name="outfit"
      bar={{
        title: name,
        back: '/outfits',
        actions: <OutfitMenu ctx={ctx} outfit={outfit} />,
      }}
      layout="split"
      aside={
        <OutfitSubject
          outfit={outfit}
          pieces={pieces}
          complete={toBuy.length === 0}
        />
      }
      body={{ gap: 6 }}
      overlays={
        <>
          {mayBePlanned && <PlanSheet outfitId={outfit.id} />}
          <AlreadySavedToast kind={props.alreadySaved} />
          <DecisionToastView toast={props.toast} />
        </>
      }
    >
      {toBuy.length > 0 && <ToBuySection pieces={toBuy} />}
      <PublicSharePanel siteUrl={ctx.siteUrl} share={publicShareOf(outfit)} />
      <div class="flex gap-2">
        {mayBePlanned && (
          <button
            type="button"
            class="btn btn-primary flex-1"
            {...sheetOpener(PLAN_SHEET_ID)}
            data-outfit-plan=""
          >
            {t('outfits.PLAN')}
          </button>
        )}
        <a
          href={stylingUrl({
            outfitId: outfit.id,
            // Its pieces to buy on their strips, to swap one for another (#335).
            picks: toBuy.length > 0,
            returnTo: outfitUrl(outfit.id),
          })}
          class="btn btn-outline flex-1"
          data-outfit-edit=""
        >
          {t('outfits.EDIT')}
        </a>
      </div>
      {entries.planned.length > 0 && <PlannedList planned={entries.planned} />}
      {entries.worn.length > 0 && (
        <WornStrip outfitId={outfit.id} worn={entries.worn} />
      )}
      {outfit.garments.length > 0 && <GarmentList pieces={pieces} />}
    </PageShell>
  );
}

/**
 * The split page's subject: what the outfit is (Muse's proposal and its
 * answer, who made it, the notes) and the collage. A phone reads them before
 * the actions, so they lead the subject rather than the facts.
 */
function OutfitSubject(props: {
  outfit: OutfitPageDetail;
  pieces: OutfitPiece[];
  complete: boolean;
}) {
  const { outfit } = props;
  return (
    <div class="flex flex-col gap-6">
      {outfit.proposal && (
        <ProposalBlock
          outfitId={outfit.id}
          proposal={outfit.proposal}
          complete={props.complete}
        />
      )}
      {outfit.agent && (
        <p class="px-1">
          <AgentBadge agent={outfit.agent} byMuse={outfit.proposal !== null} />
        </p>
      )}
      {outfit.notes && <p class="text-muted text-sm px-1">{outfit.notes}</p>}
      {outfit.garments.length > 0 ? (
        <OutfitCollage garments={props.pieces} eager />
      ) : (
        <p class="text-muted text-sm italic">{t('OUTFIT_NO_GARMENTS')}</p>
      )}
    </div>
  );
}

/** The outfit's public link and where Share and Stop post (#669). */
function publicShareOf(outfit: OutfitPageDetail): PublicShare {
  return {
    type: 'outfit',
    shareableId: outfit.shareableId,
    shareUrl: `${outfitUrl(outfit.id)}/share`,
    stopUrl: `${outfitUrl(outfit.id)}/share/stop`,
  };
}

/**
 * The ⋯ menu: Share (the public link) and Delete. Buttons only: a form
 * inside a daisyUI menu item loses its styling (the garment page's menu).
 */
function OutfitMenu(props: { ctx: ViewContext; outfit: OutfitPageDetail }) {
  const { ctx, outfit } = props;
  // Muse's proposal not loved is feedback: Not for me sets it aside, kept.
  const deletable = !outfit.proposal || outfit.proposal.reaction === 'loved';
  return (
    <details class="dropdown dropdown-end" id="outfit-menu">
      <summary
        class="btn btn-ghost btn-circle text-xl"
        aria-label={t('MORE_ACTIONS')}
      >
        ⋯
      </summary>
      <ul class="menu dropdown-content bg-base-100 rounded-box border border-base-300 z-20 w-56 p-2">
        <li>
          <ShareLinkButton
            siteUrl={ctx.siteUrl}
            share={publicShareOf(outfit)}
            variant="menu"
          />
        </li>
        {deletable && (
          <li>
            <button
              type="button"
              class="text-error"
              hx-delete={outfitUrl(outfit.id)}
              hx-confirm={t('CONFIRM_DELETE')}
            >
              {t('DELETE')}
            </button>
          </li>
        )}
      </ul>
    </details>
  );
}

/**
 * One of Muse's outfits (#335): who proposed it and why, and the owner's
 * reaction as on its card (muse-cards.tsx): Love (Save once complete) and
 * Not for me while it waits on them, Undo once set aside. Loved, it is
 * the owner's (or waits on its pieces, listed below).
 */
function ProposalBlock(props: {
  outfitId: number;
  proposal: OutfitProposal;
  complete: boolean;
}) {
  const { proposal } = props;
  const returnTo = outfitUrl(props.outfitId);
  const action = (move: string) => `${outfitUrl(props.outfitId)}/${move}`;
  const waiting =
    proposal.reaction === 'proposed' || proposal.reaction === 'revise';
  return (
    <section class="flex flex-col gap-2 px-1" data-outfit-proposal="">
      <p class="text-sm font-medium">
        {t('outfits.muse.FROM', { agent: museName(proposal.agent) })}
      </p>
      {proposal.note && <p class="text-sm text-muted">{proposal.note}</p>}
      {proposal.reaction === 'revise' && proposal.ownerNote && (
        <p class="text-sm">
          {t('outfits.muse.YOU_ASKED', { note: proposal.ownerNote })}
        </p>
      )}
      {proposal.reaction === 'declined' && (
        <div class="flex items-center gap-2">
          <p class="text-sm text-muted flex-1">
            {t('outfits.muse.SET_ASIDE_LINE', {
              reason: reasonText(proposal.dismissedReason),
            })}
          </p>
          <UndoForm action={action('undo')} returnTo={returnTo} primary />
        </div>
      )}
      {waiting && (
        <div class="flex flex-wrap items-start gap-2">
          <PostForm action={action('love')}>
            <input type="hidden" name="returnTo" value={returnTo} />
            <button type="submit" class="btn btn-primary">
              {t(props.complete ? 'outfits.muse.SAVE' : 'outfits.muse.LOVE')}
            </button>
          </PostForm>
          <NotForMe
            action={action('dismiss')}
            returnTo={returnTo}
            reasons={OUTFIT_DISMISS_REASONS}
            label={`× ${t('muse.NOT_FOR_ME')}`}
          />
        </div>
      )}
    </section>
  );
}

/** "Planned": the entries from today on not worn yet, soonest first, each linking its week. */
function PlannedList({ planned }: { planned: PlannedDay[] }) {
  return (
    <section aria-labelledby="outfit-planned-title" data-outfit-planned="">
      <h2 id="outfit-planned-title" class="text-sm text-muted mb-2">
        {t('outfits.PLANNED_HEADING')}
      </h2>
      <ul class="flex flex-col gap-1">
        {planned.map(({ entryId, day, occasion }) => (
          <li data-planned-entry={entryId}>
            <a href={`/calendar?week=${day}`} class="link link-hover text-sm">
              {dayLabel(day)} · {occasionLabel(occasion)}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * "Worn": every day the outfit was worn, newest first, as the looks were
 * actually worn: its selfie, or a tile with the camera to add one (taken
 * later from the phone's library, most likely). Each day links its week.
 */
function WornStrip(props: { outfitId: number; worn: WornDay[] }) {
  const returnTo = outfitUrl(props.outfitId);
  return (
    <section data-worn-strip="">
      <h2 class="text-sm text-muted mb-2">
        {t('selfie.WORN_HEADING', { count: props.worn.length })}
      </h2>
      <div class="flex overflow-x-auto overscroll-x-contain gap-3 pb-2">
        {props.worn.map(({ entryId, day, selfie }) => (
          <div
            class="flex flex-col items-center gap-1 shrink-0 w-28"
            data-worn-day={day}
          >
            {selfie ? (
              <SelfieView
                selfie={selfie}
                day={day}
                entryId={entryId}
                returnTo={returnTo}
                size="strip"
              />
            ) : (
              <div class="h-36 aspect-[3/4] rounded-box bg-base-200 flex items-center justify-center">
                <EntrySelfie
                  entryId={entryId}
                  day={day}
                  selfie={null}
                  canTake
                  returnTo={returnTo}
                  size="strip"
                />
              </div>
            )}
            <a
              href={`/calendar?week=${day}`}
              class="text-xs text-center link link-hover leading-tight"
            >
              {dayLabel(day)}
            </a>
          </div>
        ))}
      </div>
    </section>
  );
}

/** The garments in the order the outfit was built, each opening its page. */
function GarmentList({ pieces }: { pieces: OutfitPiece[] }) {
  return (
    <section aria-labelledby="outfit-garments-title">
      <h2 id="outfit-garments-title" class="text-sm text-muted mb-2">
        {t('GARMENTS_IN_OUTFIT')}
      </h2>
      <div class="flex flex-wrap gap-3">
        {pieces.map((piece) => (
          <a
            href={`/wardrobe/${piece.id}`}
            class="flex flex-col items-center gap-1 w-20"
          >
            <span class="relative">
              <GarmentThumb
                garment={piece}
                class="rounded-box bg-base-200"
                decorative
              />
              <FootMark marks={piece.marks} />
            </span>
            <span class="text-xs text-center line-clamp-2 leading-tight">
              {piece.name}
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}

/**
 * Plan: the outfit on a day, for an occasion, through POST /calendar (a
 * native post; 302 to that day's week, which shows it). Replaces the Saved
 * grid's per-card dropdown (R5). The day starts at today, the client's
 * (defaultsToToday: the page keeps its ETag across days, #708); the occasion is
 * a row of radios styled as chips, all day checked (the calendar's "+ Plan"
 * sheet's pattern, R6). Planning an outfit already on that day changes
 * nothing (an outfit is on a day once).
 */
function PlanSheet(props: { outfitId: number }) {
  return (
    <Sheet
      id={PLAN_SHEET_ID}
      kind="choice"
      labelledBy="outfit-plan-sheet-title"
      gap={4}
      dismiss="close"
    >
      <h2 id="outfit-plan-sheet-title" class="font-semibold text-lg">
        {t('outfits.PLAN_TITLE')}
      </h2>
      <PostForm action="/calendar" class="flex flex-col gap-4">
        <input type="hidden" name="outfitId" value={String(props.outfitId)} />
        <label class="flex flex-col gap-1">
          <span class="text-sm text-muted">{t('outfits.PLAN_DAY')}</span>
          <input
            type="date"
            name="date"
            class="input w-full"
            {...defaultsToToday}
            required
          />
        </label>
        <fieldset>
          <legend class="text-sm text-muted mb-2">{t('OCCASION')}</legend>
          <div class="flex flex-wrap gap-2">
            {OCCASIONS.map((occasion) => (
              <input
                type="radio"
                name="occasion"
                value={occasion}
                class="btn btn-sm rounded-full checked:btn-primary"
                aria-label={occasionLabel(occasion)}
                checked={occasion === DEFAULT_OCCASION}
              />
            ))}
          </div>
        </fieldset>
        <div class="modal-action mt-0">
          <SheetCancel />
          <button type="submit" class="btn btn-primary">
            {t('outfits.PLAN_SUBMIT')}
          </button>
        </div>
      </PostForm>
    </Sheet>
  );
}
