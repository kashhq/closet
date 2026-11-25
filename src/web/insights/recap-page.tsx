import type { InsightGarment } from '../../wardrobe/insights';
import { RECAP_MIN_WEARS, type YearRecap } from '../../wardrobe/recap';
import { imageUrl, type SignablePhotoRef } from '../files/image-url';
import { dateParts, type IsoDate } from '../../calendar-date';
import { dateLabel, shortDayLabel, weekRangeLabel } from '../date-labels';
import { CALENDAR_PATH } from '../calendar/urls';
import { jsonForScript } from '../html';
import { t } from '../i18n';
import { PageShell } from '../layout/page-shell';
import { EmptyState, GarmentThumb } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { priceLabel } from '../wardrobe/garment';
import { garmentUrl } from '../wardrobe/urls';
import {
  InsightCard,
  GarmentList,
  garmentName,
  perWearLine,
  Strip,
} from './parts';
import { recapUrl } from './urls';
import { STAT_GRID } from '../layout/columns';

export interface RecapPageModel {
  recap: YearRecap<SignablePhotoRef>;
  /** The household's today: its year is the › link's bare address. */
  today: IsoDate;
}

/** How many of the most worn the image shows (the page lists them all). */
const IMAGE_MOST_WORN = 3;

/**
 * GET /wardrobe/recap (#26, docs/plans/2026-09-28-yearly-recap.md): a year
 * in review. The year's switcher, then either its empty state (fewer than
 * RECAP_MIN_WEARS wears) or its figures: the numbers and "Save image",
 * most worn, new this year, best value per wear, colours worn, the pair
 * worn together most. Every figure is src/wardrobe/recap.ts's. The
 * signed-in user's own, like insights: never a grantee's view of someone
 * else's wear log.
 */
export function RecapPage(props: { ctx: ViewContext; model: RecapPageModel }) {
  const { ctx, model } = props;
  const { recap } = model;
  return (
    <PageShell
      ctx={ctx}
      name="recap"
      bar={{ title: t('recap.TITLE'), back: '/wardrobe' }}
      body={{ gap: 4 }}
    >
      <YearNav model={model} />
      {recap.enough ? (
        <Figures model={model} appName={ctx.appName} />
      ) : (
        <Empty recap={recap} />
      )}
    </PageShell>
  );
}

function yearTitle(recap: YearRecap<SignablePhotoRef>): string {
  const { year, complete } = recap.period;
  return complete
    ? t('recap.YEAR', { year })
    : t('recap.YEAR_SO_FAR', { year });
}

/**
 * ‹ the year before (only when something was worn before this one), the
 * year and its days, › the year after (only for a past year; the current
 * one is the bare address).
 */
function YearNav({ model }: { model: RecapPageModel }) {
  const { recap, today } = model;
  const currentYear = dateParts(today).year;
  const { year, complete } = recap.period;
  const next = year + 1;
  return (
    <nav
      class="flex items-center justify-between gap-2"
      aria-label={t('recap.YEARS')}
    >
      {recap.earlier ? (
        <a href={recapUrl(year - 1)} class="btn btn-ghost btn-sm" rel="prev">
          ‹ {year - 1}
        </a>
      ) : (
        <span class="w-16" />
      )}
      <div class="text-center">
        <h2 class="text-xl font-semibold">{yearTitle(recap)}</h2>
        <p
          class="text-xs text-muted"
          id="recap-range"
          data-year={year}
          data-from={recap.period.from}
          data-to={recap.period.to}
        >
          {/* The week's heading formats any span of days: "Jan 1 – Sep 27, 2026". */}
          {weekRangeLabel(recap.period.from, recap.period.to)}
        </p>
      </div>
      {complete ? (
        <a
          href={recapUrl(next === currentYear ? undefined : next)}
          class="btn btn-ghost btn-sm"
          rel="next"
        >
          {next} ›
        </a>
      ) : (
        <span class="w-16" />
      )}
    </nav>
  );
}

function Empty({ recap }: { recap: YearRecap<SignablePhotoRef> }) {
  const { year } = recap.period;
  const message =
    recap.wears === 0
      ? t('recap.EMPTY_NONE', { year })
      : t('recap.EMPTY_FEW', {
          year,
          count: recap.wears,
          min: RECAP_MIN_WEARS,
        });
  return (
    <div id="recap-empty">
      <EmptyState message={message}>
        <p class="text-center text-sm px-4">{t('recap.EMPTY_OWNER')}</p>
        <a
          href={CALENDAR_PATH}
          class="btn btn-primary btn-sm"
          id="recap-calendar"
        >
          {t('recap.OPEN_CALENDAR')}
        </a>
      </EmptyState>
    </div>
  );
}

/** "Worn 12 times", "Worn once": the year's wears. */
function yearWears(garment: InsightGarment<SignablePhotoRef>): string {
  return garment.recentWearDays === 1
    ? t('wear.WORN_ONCE')
    : t('wear.WORN_TIMES', { count: garment.recentWearDays });
}

function Figures(props: { model: RecapPageModel; appName: string }) {
  const { model } = props;
  const { recap } = model;
  const { additions } = recap;
  return (
    <>
      <Summary model={model} appName={props.appName} />
      <InsightCard id="recap-most-worn" title={t('recap.MOST_WORN')}>
        <GarmentList
          rows={recap.mostWorn.map((garment) => ({
            garment,
            detail: yearWears(garment),
          }))}
        />
      </InsightCard>
      {additions.count > 0 && (
        <InsightCard id="recap-additions" title={t('recap.ADDITIONS')}>
          <GarmentList
            rows={additions.garments.map((garment) => ({
              garment,
              detail: [
                t('recap.ADDED', {
                  when: dateLabel(garment.acquiredOn!, model.today),
                }),
                garment.recentWearDays === 0
                  ? t('wear.NOT_WORN')
                  : yearWears(garment),
              ].join(' · '),
            }))}
          />
          {additions.count > additions.garments.length && (
            <p class="text-xs text-muted">
              {t('recap.ADDITIONS_MORE', {
                count: additions.count - additions.garments.length,
              })}
            </p>
          )}
        </InsightCard>
      )}
      {recap.bestValue.length > 0 && (
        <InsightCard id="recap-best-value" title={t('recap.BEST_VALUE')}>
          <p class="text-xs text-muted">
            {t('recap.BEST_VALUE_NOTE', {
              date: shortDayLabel(recap.period.to),
            })}
          </p>
          <GarmentList
            rows={recap.bestValue.map((entry) => ({
              garment: entry.garment,
              detail: perWearLine(entry),
            }))}
          />
        </InsightCard>
      )}
      {recap.colours.length > 0 && (
        <InsightCard id="recap-colours" title={t('recap.COLOURS')}>
          <Strip
            name="worn"
            title={t('insights.COLOURS_WORN')}
            colours={recap.colours}
            share={(colour) => colour.worn}
            uncoloured={recap.uncolouredWorn}
          />
          <ul class="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {recap.colours.map((colour) => (
              <li class="flex items-center gap-1">
                <span
                  class={`size-3 shrink-0 rounded-full ring-1 ring-base-300 swatch--${colour.colour}`}
                />
                <span class="capitalize">{colour.colour}</span>
                <span class="text-muted">{colour.worn}%</span>
              </li>
            ))}
          </ul>
        </InsightCard>
      )}
      {recap.pair && (
        <InsightCard id="recap-pair" title={t('recap.PAIR')}>
          <div
            class="flex items-center gap-2"
            data-pair={`${recap.pair.a.id}-${recap.pair.b.id}`}
          >
            {[recap.pair.a, recap.pair.b].map((garment) => (
              <a href={garmentUrl(garment.id, undefined)} class="shrink-0">
                <GarmentThumb garment={garment} class="rounded-box" />
              </a>
            ))}
            <span class="flex flex-col min-w-0 text-sm">
              <span class="truncate">{garmentName(recap.pair.a)}</span>
              <span class="truncate">{garmentName(recap.pair.b)}</span>
              <span class="text-xs text-muted">
                {t('insights.PAIR_DAYS', { count: recap.pair.days })}
              </span>
            </span>
          </div>
        </InsightCard>
      )}
    </>
  );
}

/** The three numbers, and the owner's "Save image". */
function Summary(props: { model: RecapPageModel; appName: string }) {
  const { model } = props;
  const { recap } = model;
  return (
    <InsightCard id="recap-summary" title={t('recap.NUMBERS')}>
      <div class={`${STAT_GRID} text-center`}>
        {stats(recap).map((stat) => (
          <div class="rounded-box bg-base-200 p-2" data-stat={stat.key}>
            <p class="text-2xl font-bold">{stat.value}</p>
            <p class="text-xs">{stat.label}</p>
          </div>
        ))}
      </div>
      <Export recap={recap} appName={props.appName} />
    </InsightCard>
  );
}

function stats(recap: YearRecap<SignablePhotoRef>) {
  return [
    { key: 'wears', value: recap.wears, label: t('recap.WEARS') },
    { key: 'pieces', value: recap.piecesWorn, label: t('recap.PIECES_WORN') },
    {
      key: 'additions',
      value: recap.additions.count,
      label: t('recap.NEW_PIECES'),
    },
  ];
}

// The image's drawing (public/js/recap-export.js, through the importmap):
// an inline module, so it runs again after a boosted navigation brings the
// page. A fixed string with nothing interpolated.
const RECAP_EXPORT_INIT = `import { prepareRecapExport } from 'recap-export';
prepareRecapExport(document.getElementById('recap-export'));`;

/**
 * "Save image": public/js/recap-export.js draws the card from the data
 * island on a canvas as the page opens and enables the button once the PNG
 * is made, so the tap hands a ready file to the share sheet (WebKit's
 * share needs the tap's activation). The light theme's probe gives the
 * card its colours whatever the phone's scheme.
 */
function Export(props: {
  recap: YearRecap<SignablePhotoRef>;
  appName: string;
}) {
  return (
    <div class="flex flex-col gap-1">
      <button
        type="button"
        class="btn btn-primary btn-sm self-start"
        id="recap-export"
        disabled
      >
        {t('recap.SAVE_IMAGE')}
      </button>
      <p class="text-xs text-muted" id="recap-export-note" aria-live="polite">
        {t('recap.SAVE_IMAGE_NOTE')}
      </p>
      <div data-theme="closet-light" data-recap-theme="" hidden />
      {/* Inline JSON through jsonForScript: it cannot close its <script>. */}
      <script
        type="application/json"
        id="recap-card-data"
        dangerouslySetInnerHTML={{
          __html: jsonForScript(cardData(props.recap, props.appName)),
        }}
      />
      <script
        type="module"
        dangerouslySetInnerHTML={{ __html: RECAP_EXPORT_INIT }}
      />
    </div>
  );
}

/** A garment as the image draws it: its thumb (same-origin, so the canvas stays clean). */
function cardGarment(
  garment: InsightGarment<SignablePhotoRef>,
  detail: string,
) {
  return {
    name: garmentName(garment),
    image: garment.photo ? imageUrl(garment.photo, 'thumb') : null,
    detail,
  };
}

/**
 * Everything the image says, its strings already in the catalog's words:
 * recap-export.js only draws. The colours are the page's own strip's
 * segments (`colour` names one), read there for their painted colour.
 */
function cardData(recap: YearRecap<SignablePhotoRef>, appName: string) {
  const { period } = recap;
  const best = recap.bestValue.at(0);
  return {
    // "closet-2026.png": the app's name as a file name.
    fileName: `${appName.replace(/[^\w-]+/g, '-').toLowerCase()}-${period.year}.png`,
    appName,
    title: period.complete
      ? t('recap.IMAGE_TITLE', { year: period.year })
      : t('recap.IMAGE_TITLE_SO_FAR', { year: period.year }),
    range: weekRangeLabel(period.from, period.to),
    stats: stats(recap).map(({ value, label }) => ({
      value: String(value),
      label,
    })),
    failed: t('recap.SAVE_IMAGE_FAILED'),
    mostWorn: {
      heading: t('recap.MOST_WORN'),
      garments: recap.mostWorn
        .slice(0, IMAGE_MOST_WORN)
        .map((g) =>
          cardGarment(
            g,
            t('recap.IMAGE_WORN_DAYS', { count: g.recentWearDays }),
          ),
        ),
    },
    bestValue: best
      ? {
          heading: t('recap.IMAGE_BEST_VALUE'),
          // Best value is among worn garments: perWear is never null.
          garment: cardGarment(
            best.garment,
            t('recap.IMAGE_PER_WEAR', { perWear: priceLabel(best.perWear!) }),
          ),
        }
      : null,
    pair: recap.pair
      ? {
          heading: t('recap.IMAGE_PAIR'),
          garments: [recap.pair.a, recap.pair.b].map((g) => cardGarment(g, '')),
          detail: t('recap.IMAGE_PAIR_DAYS', { count: recap.pair.days }),
        }
      : null,
    colours:
      recap.colours.length > 0
        ? {
            heading: t('recap.COLOURS'),
            segments: recap.colours.map((c) => ({
              colour: c.colour,
              share: c.worn,
            })),
            uncoloured: recap.uncolouredWorn,
          }
        : null,
  };
}
