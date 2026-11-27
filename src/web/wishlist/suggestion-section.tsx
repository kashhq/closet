import { Card } from '../card';
import { t } from '../i18n';
import { museName } from '../write-origin';
import { categoryLabel } from '../wardrobe/garment';
import type { GarmentDetail } from '../wardrobe/queries';
import { garmentUrl, needUrl } from '../wardrobe/urls';
import { isOpenPick, type MusePick, type SuggestionContext } from './inbox';
import {
  ChooseForm,
  FromAgent,
  NeedLink,
  NotForMe,
  PriceAgainstBudget,
  ProductPhoto,
  reasonText,
  UndoForm,
} from './suggestion-parts';
import { THUMB_ROW_WIDE } from '../layout/columns';

/** Where a suggestion stands, as its page says it (data-suggestion-state). */
const STATE = {
  open: 'open',
  chosen: 'chosen',
  setAside: 'set-aside',
  needSetAside: 'need-set-aside',
  bought: 'bought',
  returned: 'returned',
} as const;
type SuggestionState = (typeof STATE)[keyof typeof STATE];

function stateOf(
  garment: GarmentDetail,
  suggestion: SuggestionContext,
): SuggestionState {
  const { need } = suggestion;
  if (garment.status !== 'wishlist') {
    return suggestion.dismissedReason === 'returned'
      ? STATE.returned
      : STATE.bought;
  }
  if (garment.dismissedAt !== null) return STATE.setAside;
  if (need?.status === 'dismissed') return STATE.needSetAside;
  if (need?.status === 'resolved' && need.resolvedGarmentId === garment.id) {
    return STATE.chosen;
  }
  return STATE.open;
}

function pickName(pick: { name: string | null; category: string }): string {
  return pick.name ?? categoryLabel(pick.category);
}

/**
 * A suggestion's part of its garment page (#333; doc section 4 F), under
 * the summary: "From Muse" and where it stands, its need (a link to the
 * decision screen) and price against the need's budget, Muse's note, the
 * owner's decisions by state (open: **This one**; chosen: **Bought it**;
 * set aside: **Undo**, each the one primary), and the need's other
 * options. A grantee reads it without the decisions (a MANAGE grantee keeps
 * the page's own Bought it). Every decision comes back here.
 */
export function SuggestionSection(props: {
  garment: GarmentDetail;
  suggestion: SuggestionContext;
  isOwner: boolean;
  canEdit: boolean;
  viewOwner: number | undefined;
}) {
  const { garment, suggestion, viewOwner } = props;
  const { need } = suggestion;
  const state = stateOf(garment, suggestion);
  const self = garmentUrl(garment.id, viewOwner);
  return (
    <Card
      as="section"
      variant="content"
      bodyClass="p-4 gap-3"
      aria-label={t('muse.FROM', { agent: museName(suggestion.agent) })}
      data-suggestion-state={state}
    >
      <div class="flex flex-wrap items-center gap-2">
        <FromAgent agent={suggestion.agent} />
        <StateBadge state={state} suggestion={suggestion} />
      </div>
      {need && <NeedLink name={need.name} href={needUrl(need.id, viewOwner)} />}
      {garment.status === 'wishlist' && (
        <PriceAgainstBudget
          price={props.garment.price}
          budget={need?.budget ?? null}
        />
      )}
      {suggestion.note && (
        // Clamped to three lines; a tap opens the rest in place.
        <details class="group text-sm" data-suggestion-note="">
          <summary class="list-none cursor-pointer">
            <p class="line-clamp-3 group-open:line-clamp-none whitespace-pre-line">
              {suggestion.note}
            </p>
          </summary>
        </details>
      )}
      {props.isOwner && garment.status === 'wishlist' && (
        <Decisions
          garment={garment}
          suggestion={suggestion}
          state={state}
          self={self}
          canEdit={props.canEdit}
        />
      )}
      {need && (
        <OtherOptions
          picks={need.picks.filter(
            (pick) => pick.id !== garment.id && isOpenPick(pick),
          )}
          compare={needUrl(need.id, viewOwner)}
          viewOwner={viewOwner}
        />
      )}
    </Card>
  );
}

function StateBadge(props: {
  state: SuggestionState;
  suggestion: SuggestionContext;
}) {
  const { state, suggestion } = props;
  switch (state) {
    case STATE.chosen:
      return (
        <span class="badge badge-soft badge-success">{t('muse.CHOSEN')}</span>
      );
    case STATE.setAside:
      return (
        <span class="badge badge-soft badge-neutral">
          {t('muse.SET_ASIDE_REASON', {
            reason: reasonText(suggestion.dismissedReason),
          })}
        </span>
      );
    case STATE.needSetAside:
      return (
        <span class="badge badge-soft badge-neutral">
          {t('muse.NEED_SET_ASIDE', {
            reason: reasonText(suggestion.need?.dismissedReason ?? null),
          })}
        </span>
      );
    case STATE.returned:
      return (
        <span class="badge badge-soft badge-neutral">
          {reasonText('returned')}
        </span>
      );
    default:
      return null;
  }
}

/** The owner's decisions on a pick still on the wishlist, by where it stands. */
function Decisions(props: {
  garment: GarmentDetail;
  suggestion: SuggestionContext;
  state: SuggestionState;
  self: string;
  canEdit: boolean;
}) {
  const { garment, suggestion, state, self } = props;
  const { need } = suggestion;
  const bought = garmentUrl(garment.id, undefined, '/bought');
  switch (state) {
    case STATE.open:
      return (
        <div class="flex flex-col gap-2" data-suggestion-actions="">
          {need ? (
            <ChooseForm
              action={garmentUrl(garment.id, undefined, '/choose')}
              returnTo={self}
            />
          ) : (
            <BoughtItLink href={bought} primary />
          )}
          <div class="flex flex-wrap items-start gap-1">
            {need && <BoughtItLink href={bought} />}
            <NotForMe
              action={garmentUrl(garment.id, undefined, '/dismiss')}
              returnTo={self}
            />
          </div>
        </div>
      );
    case STATE.chosen:
      return (
        <div class="flex flex-col gap-2" data-suggestion-actions="">
          <BoughtItLink href={bought} primary />
          <div class="flex flex-wrap items-start gap-1">
            {need && (
              <UndoForm
                action={needUrl(need.id, undefined, '/undo')}
                returnTo={self}
                label={t('muse.UNDO_CHOICE')}
              />
            )}
          </div>
        </div>
      );
    case STATE.setAside:
      // A pick comes back only into an open need (or none): a choice is
      // undone on the need's screen first.
      return !need || need.status === 'open' ? (
        <UndoForm
          action={garmentUrl(garment.id, undefined, '/undo')}
          returnTo={self}
          primary
        />
      ) : null;
    case STATE.needSetAside:
      return need ? (
        <UndoForm
          action={needUrl(need.id, undefined, '/undo')}
          returnTo={self}
          primary
        />
      ) : null;
    default:
      return null;
  }
}

/** "Bought it", to the purchase form: the one primary, or beside This one. */
function BoughtItLink(props: { href: string; primary?: boolean }) {
  return (
    <a
      href={props.href}
      class={
        props.primary ? 'btn btn-primary btn-block' : 'btn btn-ghost btn-sm'
      }
    >
      {t('wishlist.BOUGHT_IT')}
    </a>
  );
}

/** The need's other open options, each to its own page, and the way to compare them. */
function OtherOptions(props: {
  picks: readonly MusePick[];
  compare: string;
  viewOwner: number | undefined;
}) {
  if (props.picks.length === 0) return null;
  return (
    <div class="flex flex-col gap-2 border-t border-base-300 pt-3">
      <p class="text-sm font-medium">{t('muse.OTHER_OPTIONS')}</p>
      <ul class={THUMB_ROW_WIDE} data-other-options="">
        {props.picks.map((pick) => (
          <li>
            <a
              href={garmentUrl(pick.id, props.viewOwner)}
              class="flex flex-col gap-1 no-underline"
              data-option={String(pick.id)}
            >
              <ProductPhoto photo={pick.photo} alt={pickName(pick)} />
              <span class="text-xs truncate">{pickName(pick)}</span>
            </a>
          </li>
        ))}
      </ul>
      <a href={props.compare} class="btn btn-outline btn-sm self-start">
        {t('muse.COMPARE')}
      </a>
    </div>
  );
}
