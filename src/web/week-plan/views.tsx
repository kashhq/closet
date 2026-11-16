import { DAY_OCCASIONS } from '../../wardrobe/occasions';
import {
  AROUND_OCCASIONS,
  templateDays,
  type TemplateSlot,
} from '../../wardrobe/week';
import type { Slot } from '../../wardrobe/week-planner';
import type { IsoDate } from '../../calendar-date';
import { PostForm } from '../form';
import { DAY_NAMES, dayLabel, occasionLabel } from '../date-labels';
import { dayAnchor, dayUrl } from '../calendar/urls';
import { joinCopy, t, type Translated } from '../i18n';
import { SavedToast, StripFlags } from '../layout/parts';
import { SettingsPage } from '../layout/settings-page';
import { profileSection } from '../auth/urls';
import type { ViewContext } from '../view-context';
import { collagePieces, OutfitCollage } from '../outfits/collage';
import type { PlannedBanner } from './plan';
import { weekdayFieldNames } from './template';
import {
  PLAN_WEEK_PATH,
  PLANNED_FLAG,
  undoWeekPlanUrl,
  UNDONE_FLAG,
  WEEK_SAVED_FLAG,
  WEEK_SETTINGS_ID,
  WEEK_SETTINGS_PATH,
} from './urls';

/**
 * The weekly auto-plan's pieces (#16): the "Plan my week" button (the
 * calendar and Today), the banner after a plan with its Undo, and the
 * week template's page (Profile › Your week). Every write is a native PostForm
 * (data-needs-network: disabled offline with the banner's explanation).
 */

/** "Plan my week": a native post, answered on the calendar with the banner. Static, so the calendar stays byte-stable. */
export function PlanWeekForm(props: { class?: string; small?: boolean }) {
  return (
    <PostForm action={PLAN_WEEK_PATH} class={props.class}>
      <button
        type="submit"
        class={`btn btn-primary btn-soft${props.small ? ' btn-sm' : ''}`}
        data-plan-week
      >
        {t('weekPlan.PLAN_MY_WEEK')}
      </button>
    </PostForm>
  );
}

function slotText(slot: Slot): Translated {
  return joinCopy([dayLabel(slot.day), occasionLabel(slot.occasion)], ' · ');
}

function plannedHeading(banner: PlannedBanner): string {
  if (banner.weekPlanId === null) return t('weekPlan.NOTHING_PLANNED');
  const count = banner.entries.length;
  return count === 1
    ? t('weekPlan.PLANNED_ONE')
    : t('weekPlan.PLANNED_MANY', { count });
}

/**
 * What "Plan my week" did: the outfits it planned (their days, occasions
 * and names; one the person took over since says so), the template slots
 * still empty, and Undo for the batch. `?planned=none` says there was
 * nothing left to plan.
 */
export function PlannedWeekBanner({
  banner,
  shown,
}: {
  banner: PlannedBanner;
  /** The week the calendar shows: a row in it jumps within the page, any other opens its week. */
  shown: { first: IsoDate; last: IsoDate };
}) {
  const count = banner.entries.length;
  return (
    <section
      id="planned-week"
      class="alert alert-info alert-soft flex flex-col items-stretch gap-2 mb-4"
      aria-labelledby="planned-week-heading"
    >
      <h2 id="planned-week-heading" class="font-semibold">
        {plannedHeading(banner)}
      </h2>
      {count > 0 && (
        <ul class="text-sm flex flex-col gap-1.5" data-planned-entries>
          {banner.entries.map((entry) => (
            <li data-entry-id={String(entry.entryId)}>
              <a
                href={
                  entry.day >= shown.first && entry.day <= shown.last
                    ? `#${dayAnchor(entry.day)}`
                    : dayUrl(entry.day)
                }
                class="flex items-center gap-2"
              >
                <div class="w-20 shrink-0">
                  <OutfitCollage
                    garments={collagePieces(entry.garments, { warn: false })}
                    size="thumb"
                    decorative
                  />
                </div>
                <span>
                  {slotText(entry)}:{' '}
                  <span class="font-medium">
                    {entry.outfitName || t('UNTITLED_OUTFIT')}
                  </span>
                  {entry.plannedBy === 'user' && (
                    <span class="text-muted"> ({t('weekPlan.YOURS_NOW')})</span>
                  )}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {banner.stillEmpty.length > 0 && (
        <p class="text-sm" data-still-empty>
          {t('weekPlan.STILL_EMPTY', {
            slots: joinCopy(banner.stillEmpty.map(slotText), ', '),
          })}
        </p>
      )}
      {banner.away.length > 0 && (
        <p class="text-sm" data-away-skipped>
          {t('weekPlan.AWAY_SKIPPED', {
            days: joinCopy(
              banner.away.map((day) => dayLabel(day)),
              ', ',
            ),
          })}
        </p>
      )}
      {/* An empty workout may be the closet's: the planner never dresses one
          in everyday wear (#647). */}
      {banner.activewearGap && (
        <p
          class="text-sm text-muted"
          data-needs-activewear={banner.activewearGap}
        >
          {t(
            banner.activewearGap === 'no-activewear'
              ? 'weekPlan.NEEDS_ACTIVEWEAR'
              : 'weekPlan.ACTIVEWEAR_AWAY',
          )}
        </p>
      )}
      {banner.weekPlanId !== null && (
        <PostForm
          action={undoWeekPlanUrl(banner.weekPlanId)}
          confirm={t('weekPlan.UNDO_CONFIRM')}
        >
          <button type="submit" class="btn btn-sm btn-ghost">
            {t('weekPlan.UNDO')}
          </button>
        </PostForm>
      )}
      <StripFlags names={[PLANNED_FLAG]} />
    </section>
  );
}

/** After an Undo (`?undone=N`). */
export function UndoneToast({ removed }: { removed: number | undefined }) {
  return (
    <>
      {removed !== undefined && (
        <SavedToast
          id="week-undone-toast"
          text={t('weekPlan.UNDONE', { count: removed })}
        />
      )}
      <StripFlags names={[UNDONE_FLAG]} />
    </>
  );
}

/**
 * Profile › Your week (#16; a Profile section until #728): per weekday, the
 * day's outfit (one of DAY_OCCASIONS or none) and the occasions around it,
 * saved with one Save (a native post, 303 back here, so a `formPage`). Not
 * saved on change on purpose: seven rows are one decision, and a
 * half-edited week must not be planned from. Its own page so that Save is
 * the page's one action, not a lone button among autosaving neighbours.
 */
export function WeekTemplatePage(props: {
  ctx: ViewContext;
  slots: readonly TemplateSlot[];
  saved: boolean;
}) {
  return (
    <SettingsPage
      ctx={props.ctx}
      title={t('weekPlan.template.HEADING')}
      back={profileSection(WEEK_SETTINGS_ID)}
      formPage
    >
      <p class="text-sm text-muted">{t('weekPlan.template.HINT')}</p>
      <PostForm action={WEEK_SETTINGS_PATH} class="flex flex-col gap-3">
        {templateDays(props.slots).map((day) => {
          const names = weekdayFieldNames(day.weekday);
          const weekday = t(DAY_NAMES[day.weekday]);
          return (
            <fieldset
              class="flex flex-col gap-1"
              data-weekday={String(day.weekday)}
            >
              <legend class="text-sm font-semibold">{weekday}</legend>
              <select
                name={names.day}
                class="select select-bordered select-sm w-full"
                aria-label={t('weekPlan.template.DAY_LABEL', { weekday })}
              >
                <option value="" selected={day.day === null}>
                  {t('weekPlan.template.NO_DAY')}
                </option>
                {DAY_OCCASIONS.map((occasion) => (
                  <option value={occasion} selected={day.day === occasion}>
                    {occasionLabel(occasion)}
                  </option>
                ))}
              </select>
              <div
                class="flex flex-wrap gap-2"
                role="group"
                aria-label={t('weekPlan.template.AROUND_LABEL', { weekday })}
              >
                {AROUND_OCCASIONS.map((occasion) => (
                  <input
                    type="checkbox"
                    name={names.around}
                    value={occasion}
                    class="btn btn-xs rounded-full"
                    aria-label={occasionLabel(occasion)}
                    checked={day.around.includes(occasion)}
                  />
                ))}
              </div>
            </fieldset>
          );
        })}
        <button type="submit" class="btn btn-primary">
          {t('SAVE')}
        </button>
      </PostForm>
      {props.saved && (
        <SavedToast id="week-saved-toast" text={t('weekPlan.template.SAVED')} />
      )}
      <StripFlags names={[WEEK_SAVED_FLAG]} />
    </SettingsPage>
  );
}

/**
 * Profile's Your week row: how many weekdays have a slot the planner reads (a day
 * outfit or an occasion around it: any stored slot, as planMyWeek's
 * `template.length === 0` check), or that the template is empty ("Plan my week" then asks for it first).
 */
export function weekTemplateSummary(slots: readonly TemplateSlot[]): string {
  const days = new Set(slots.map((slot) => slot.weekday)).size;
  return days === 0
    ? t('weekPlan.template.SUMMARY_NONE')
    : t('weekPlan.template.SUMMARY_DAYS', { count: days });
}
