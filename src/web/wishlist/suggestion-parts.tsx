import type { OutfitCount } from '../../wardrobe/goes-with';
import {
  budgetFit,
  type DismissReason,
  OWNER_DISMISS_REASONS,
  type OwnerDismissReason,
} from '../../wardrobe/suggestions';
import { PostForm } from '../form';
import { imageUrl, type SignablePhotoRef } from '../files/image-url';
import { unlocksText } from '../gallery/goes-with';
import { t } from '../i18n';
import { type AgentLabel, museName } from '../write-origin';
import { HangerIcon, SavedToast, StripFlags } from '../layout/parts';
import { priceLabel } from '../wardrobe/garment';

/**
 * What the Muse inbox (inbox-page.tsx), a need's decision screen
 * (group-page.tsx) and a suggestion's own page (suggestion-section.tsx)
 * share: the decision forms, each a native PostForm posting to the one
 * writer's routes (suggestion-routes.tsx) with the page to come back to,
 * and the lines that say where a pick stands. Every form needs the
 * network: offline it is disabled with the app's reason, never queued.
 */

/** The flag a decision's 303 carries back, read once for its toast (StripFlags). */
export const DECISION_FLAG = 'decided';

const DECISION_TOASTS = [
  'choose',
  'love',
  'save',
  'dismiss',
  'undo',
  'returned',
  'boughtFor',
] as const;
export type DecisionToast = (typeof DECISION_TOASTS)[number];

/** `?decided=` as a toast: URL state, so anything else is no toast, never a 400. */
export function decisionToastOf(
  flag: string | undefined,
): DecisionToast | undefined {
  return DECISION_TOASTS.find((toast) => toast === flag);
}

/** Why something was set aside, as the owner reads it; null for one the plans' review set aside before #337 (its words are the note). */
export function reasonText(reason: DismissReason | null): string {
  return t(`muse.reason.${reason ?? 'none'}`);
}

/** The page a decision comes back to, checked again by the route (safeReturnTo). */
function ReturnTo({ path }: { path: string }) {
  return <input type="hidden" name="returnTo" value={path} />;
}

/** "This one": the card's one primary action. */
export function ChooseForm(props: { action: string; returnTo: string }) {
  return (
    <PostForm action={props.action}>
      <ReturnTo path={props.returnTo} />
      <button type="submit" class="btn btn-primary btn-block">
        {t('muse.THIS_ONE')}
      </button>
    </PostForm>
  );
}

/**
 * "Not for me" (or "Not this need right now"), opened in place, never in a
 * sheet: an optional note, then a reason chip for each of the owner's
 * reasons, each a submit button of the one form, so a reason is one tap.
 * The note is a textarea so Enter never submits a reason by itself.
 */
export function NotForMe(props: {
  action: string;
  returnTo: string;
  label?: string;
  /** The reasons offered: the owner's for a pick or a need; OUTFIT_DISMISS_REASONS for an outfit. */
  reasons?: readonly OwnerDismissReason[];
}) {
  return (
    <details class="group/not-for-me" data-not-for-me="">
      <summary class="btn btn-ghost btn-sm">
        {props.label ?? t('muse.NOT_FOR_ME')}
      </summary>
      <PostForm action={props.action} class="flex flex-col gap-2 pt-2">
        <ReturnTo path={props.returnTo} />
        <label class="flex flex-col gap-1 text-xs text-muted">
          {t('muse.NOTE_LABEL')}
          <textarea
            name="note"
            rows={2}
            maxlength={500}
            class="textarea textarea-sm w-full"
          ></textarea>
        </label>
        <p class="text-xs text-muted">{t('muse.NOT_FOR_ME_HINT')}</p>
        <div class="flex flex-wrap gap-1">
          {(props.reasons ?? OWNER_DISMISS_REASONS).map((reason) => (
            <button
              type="submit"
              name="reason"
              value={reason}
              class="btn btn-outline btn-sm"
            >
              {reasonText(reason)}
            </button>
          ))}
        </div>
      </PostForm>
    </details>
  );
}

/** Undo: the set-aside list's rows, and the primary of a need or pick set aside. */
export function UndoForm(props: {
  action: string;
  returnTo: string;
  label?: string;
  primary?: boolean;
  /** Says what is undone to a screen reader, where the row's text is not beside it. */
  ariaLabel?: string;
}) {
  return (
    <PostForm action={props.action}>
      <ReturnTo path={props.returnTo} />
      <button
        type="submit"
        class={props.primary ? 'btn btn-primary' : 'btn btn-ghost btn-sm'}
        aria-label={props.ariaLabel}
      >
        {props.label ?? t('muse.UNDO')}
      </button>
    </PostForm>
  );
}

/**
 * "$280 · Within budget": the price against the need's budget; nothing when
 * unpriced. `compact` (a thumb's line) says only "Over budget", the
 * exception worth a word in a small space.
 */
export function PriceAgainstBudget(props: {
  price: string | null;
  budget: string | null;
  class?: string;
  compact?: boolean;
}) {
  const { price, budget } = props;
  if (!price) return null;
  const fit = budgetFit(price, budget);
  const said = props.compact ? fit === 'over' : fit !== 'unknown';
  return (
    <p class={props.class ?? 'text-sm'} data-budget={fit}>
      <span class="font-medium">{priceLabel(price)}</span>
      {said && (
        <span class={fit === 'over' ? 'text-warning' : 'text-success'}>
          {' · '}
          {t(fit === 'over' ? 'muse.OVER_BUDGET' : 'muse.WITHIN_BUDGET')}
        </span>
      )}
    </p>
  );
}

/**
 * "Up to $300 · 3 options", and "Unlocks 50+ outfits each" when every
 * option unlocks the same (sharedUnlocks): a need's budget, how many
 * options are open, and the count once instead of on each option.
 */
export function NeedFacts(props: {
  budget: string | null;
  options: number;
  unlocks?: OutfitCount;
  class?: string;
}) {
  const { unlocks } = props;
  const facts = [
    props.budget && t('muse.UP_TO', { price: priceLabel(props.budget) }),
    props.options === 1
      ? t('muse.OPTIONS_ONE')
      : t('muse.OPTIONS', { count: props.options }),
    unlocks &&
      (props.options === 1
        ? unlocksText(unlocks)
        : t('muse.EACH', { unlocks: unlocksText(unlocks) })),
  ].filter(Boolean);
  return (
    <p
      class={props.class ?? 'text-sm text-muted'}
      data-unlocks-each={
        unlocks && `${unlocks.outfits}${unlocks.capped ? '+' : ''}`
      }
    >
      {facts.join(' · ')}
    </p>
  );
}

/**
 * The need a product is for: a muted label, then its name as a link to its
 * decision screen (a need's name is a phrase of its own, "A navy blazer",
 * never spliced into a sentence).
 */
export function NeedLink(props: { name: string; href: string }) {
  return (
    <p class="text-xs" data-need-link="">
      <span class="text-muted uppercase tracking-wide">{t('muse.NEED')}</span>{' '}
      <a href={props.href} class="link link-hover break-words">
        {props.name}
      </a>
    </p>
  );
}

/**
 * A product's photo on the plinth, contained (a shop's photo, or its
 * cutout): square at any width.
 */
export function ProductPhoto(props: {
  photo: SignablePhotoRef | null;
  alt: string;
  eager?: boolean;
}) {
  return (
    <span class="aspect-square w-full rounded-box bg-base-200 flex items-center justify-center p-2">
      {props.photo ? (
        <img
          src={imageUrl(props.photo, 'thumb')}
          alt={props.alt}
          class="max-h-full max-w-full object-contain"
          width="400"
          height="400"
          loading={props.eager ? undefined : 'lazy'}
          decoding="async"
        />
      ) : (
        <HangerIcon class="size-10 text-faint" strokeWidth="1" />
      )}
    </span>
  );
}

/**
 * "From Muse": a suggestion's provenance, by its agent as the reader may
 * see it; null where none is (an own item's lone suggestion, 0040's rows).
 */
export function FromAgent({ agent }: { agent: AgentLabel | null }) {
  return (
    <span class="badge badge-soft badge-secondary" data-from-agent="">
      {t('muse.FROM', { agent: museName(agent) })}
    </span>
  );
}

/** The toast a decision's 303 asks for, and the script that drops its flag. */
export function DecisionToastView({
  toast,
}: {
  toast: DecisionToast | undefined;
}) {
  return (
    <>
      {toast && (
        <SavedToast id="decision-toast" text={t(`muse.toast.${toast}`)} />
      )}
      <StripFlags names={[DECISION_FLAG]} />
    </>
  );
}
