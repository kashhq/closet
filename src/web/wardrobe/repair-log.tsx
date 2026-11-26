import { cardClass } from '../card';
import { REPAIR_KINDS } from '../../wardrobe/care';
import { PostForm } from '../form';
import { dateParts } from '../../calendar-date';
import { shortDayLabel } from '../date-labels';
import { t } from '../i18n';
import { FormField, inputAttributes } from '../form-field';
import { priceLabel } from './garment';
import { valueLabel } from './labels';
import type { RepairEntry, RepairLog, RepairPanel } from './repairs';
import { garmentUrl } from './urls';
import { CARE_NOTE_MAX, PRICE_INPUT_MAX } from './garment-input';
import { FIELD_GRID } from '../layout/columns';

/**
 * The repair and alteration log's views (#23): the garment page's section
 * and the edit page's editor. The owner's own: the routes pass them a log
 * only for the owner of an owned garment (garmentContext, editRepairs).
 */

/** Where the garment page's link and the writes' redirects land on the edit page. */
export const REPAIRS_ANCHOR = 'garment-repairs';

/** "Sep 29, 2026": a log runs over years. */
function repairDay(day: string): string {
  return t('care.REPAIR_DAY_VALUE', {
    day: shortDayLabel(day),
    year: dateParts(day).year,
  });
}

/** One entry: the day and kind, what was done, and its cost. */
function Entry({ entry }: { entry: RepairEntry }) {
  return (
    <div class="flex flex-col min-w-0">
      <span class="text-xs text-muted">
        {repairDay(entry.day)} · {valueLabel('repairKind', entry.kind)}
        {entry.cost !== null && ` · ${priceLabel(entry.cost)}`}
      </span>
      <span class="break-words">{entry.note}</span>
    </div>
  );
}

/**
 * The garment page's "Repairs and alterations": the log newest first and
 * what it cost in all (RepairLog's `total`, the sum cost per wear adds),
 * or that nothing is logged yet, and "Log a repair" (the edit page's
 * editor).
 */
export function RepairLogSection(props: { garmentId: number; log: RepairLog }) {
  const { entries, total } = props.log;
  return (
    <section id="garment-repairs" aria-labelledby="garment-repairs-title">
      <div class="flex items-baseline justify-between gap-2 mb-2">
        <h2 id="garment-repairs-title" class="text-sm text-muted">
          {t('care.REPAIRS')}
        </h2>
        <a
          href={`${garmentUrl(props.garmentId, undefined, '/edit')}#${REPAIRS_ANCHOR}`}
          class="link link-primary text-sm"
        >
          {t('care.REPAIRS_EDIT')}
        </a>
      </div>
      {entries.length === 0 ? (
        <p class="text-sm text-muted">{t('care.REPAIRS_EMPTY')}</p>
      ) : (
        <ul class="flex flex-col divide-y divide-base-300 text-sm">
          {entries.map((entry) => (
            <li class="py-2">
              <Entry entry={entry} />
            </li>
          ))}
        </ul>
      )}
      {total !== null && (
        <p class="text-sm text-muted mt-2">
          {t('care.REPAIRS_TOTAL', { total: priceLabel(total) })}
        </p>
      )}
    </section>
  );
}

/**
 * Below the garment form on the owner's edit page, outside it (forms cannot
 * nest): each entry with Remove, then "Log a repair or alteration". Native
 * posts (a refusal re-renders this page with a 400 and the messages), each
 * disabled offline.
 */
export function RepairEditor({ panel }: { panel: RepairPanel }) {
  const { garmentId, entries, draft, errors = {} } = panel;
  const action = garmentUrl(garmentId, undefined, '/repairs');
  return (
    <section
      id={REPAIRS_ANCHOR}
      class="flex flex-col gap-4 mt-8 scroll-mt-under-bar"
      aria-labelledby="garment-repairs-editor-title"
    >
      <div>
        <h2 id="garment-repairs-editor-title" class="font-bold text-lg">
          {t('care.REPAIRS')}
        </h2>
        <p class="text-sm text-muted">{t('care.REPAIRS_HINT')}</p>
      </div>
      {entries.length > 0 && (
        <ul class="flex flex-col divide-y divide-base-300 text-sm">
          {entries.map((entry) => (
            <li class="py-2 flex items-center justify-between gap-2">
              <Entry entry={entry} />
              <PostForm
                action={`${action}/${entry.id}/delete`}
                confirm={t('care.REPAIR_CONFIRM_DELETE')}
              >
                <button type="submit" class="btn btn-ghost btn-sm text-error">
                  {t('care.REPAIR_DELETE')}
                </button>
              </PostForm>
            </li>
          ))}
        </ul>
      )}
      <PostForm action={action} class={cardClass('inset', 'p-4 gap-3')}>
        <h3 class="font-medium">{t('care.REPAIR_ADD_TITLE')}</h3>
        <div role="group" aria-label={t('care.REPAIR_KIND')} class="flex gap-2">
          {REPAIR_KINDS.map((kind) => (
            <input
              type="radio"
              name="kind"
              value={kind}
              class="btn btn-sm rounded-full"
              aria-label={valueLabel('repairKind', kind)}
              checked={kind === draft.kind}
            />
          ))}
        </div>
        <FormField
          id="repair-note"
          label={t('care.REPAIR_NOTE')}
          required
          messages={errors.note}
        >
          <input
            {...inputAttributes('repair-note', 'w-full', errors.note)}
            type="text"
            name="note"
            value={draft.note}
            maxlength={CARE_NOTE_MAX}
            required
            placeholder={t('care.REPAIR_NOTE_PLACEHOLDER')}
          />
        </FormField>
        <div class={FIELD_GRID}>
          <FormField
            id="repair-day"
            label={t('care.REPAIR_DAY')}
            required
            messages={errors.day}
            class="min-w-0"
          >
            <input
              {...inputAttributes('repair-day', 'w-full', errors.day)}
              type="date"
              name="day"
              value={draft.day}
              max={panel.today}
              required
            />
          </FormField>
          <FormField
            id="repair-cost"
            label={t('care.REPAIR_COST')}
            messages={errors.cost}
            class="min-w-0"
          >
            <input
              {...inputAttributes('repair-cost', 'w-full', errors.cost)}
              type="text"
              inputmode="decimal"
              name="cost"
              value={draft.cost}
              maxlength={PRICE_INPUT_MAX}
              placeholder={t('care.REPAIR_COST_PLACEHOLDER')}
            />
          </FormField>
        </div>
        <button type="submit" class="btn btn-primary">
          {t('care.REPAIR_ADD')}
        </button>
      </PostForm>
    </section>
  );
}
