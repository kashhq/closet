import {
  type Breakdown,
  type CostPerWear,
  type InsightGarment,
  LEAST_WORN_MIN_OWNED_DAYS,
  RANKED_LIMIT,
  UNWORN_CHOICES,
  type UnwornDays,
  type WardrobeInsights,
} from '../../wardrobe/insights';
import type { IsoDate } from '../../calendar-date';
import { relativeDay } from '../date-labels';
import type { SignablePhotoRef } from '../files/image-url';
import { type StringKey, t } from '../i18n';
import { CARD_COLUMNS, STAT_GRID } from '../layout/columns';
import { PageShell } from '../layout/page-shell';
import { EmptyState, GarmentThumb } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { categoryLabel, priceLabel } from '../wardrobe/garment';
import { garmentUrl } from '../wardrobe/urls';
import { styleThisUrl } from '../styling/urls';
import {
  InsightCard,
  GarmentList,
  garmentName,
  perWearLine,
  Strip,
} from './parts';
import {
  insightsUrl,
  NEEDS_ATTENTION_URL,
  RECAP_PATH,
  unwornListUrl,
} from './urls';

/** "Not worn lately": the unworn card's title and its own page's. */
const UNWORN_KEY = 'insights.UNWORN' satisfies StringKey;

export interface InsightsPageModel {
  insights: WardrobeInsights<SignablePhotoRef>;
  /** The household's today (APP_TIMEZONE): "last worn 3 days ago". */
  today: IsoDate;
}

/**
 * GET /wardrobe/insights (#17): how the closet is actually used. Phone
 * first, one column of cards: worn lately (30, 90, 365 days), what needs
 * attention, what has not been worn (with "Style this"), most and least
 * worn, cost per wear, the pairs worn together, the colours, categories
 * and brands. Every figure is src/wardrobe/insights.ts's; the page only
 * lays them out. The owner's own, like wears. Every garment list shows at
 * most RANKED_LIMIT (5) rows (#728): the ranked ones are cut there by
 * insights.ts, and the unworn list, which is whole, links to its own page
 * with "See all" (UnwornPage).
 */
export function InsightsPage(props: {
  ctx: ViewContext;
  model: InsightsPageModel;
}) {
  const { ctx, model } = props;
  const { insights } = model;
  return (
    <PageShell
      ctx={ctx}
      name="insights"
      bar={{ title: t('insights.TITLE'), back: '/wardrobe' }}
      width="wide"
      body={{ gap: 4 }}
    >
      <p class="text-sm text-muted">{t('insights.INTRO')}</p>
      <a
        href={RECAP_PATH}
        class="btn btn-outline btn-sm self-start"
        id="insights-recap"
      >
        {t('recap.TITLE')}
      </a>
      {insights.closet.garments === 0 ? (
        <EmptyState message={t('insights.EMPTY')}>
          <a href="/wardrobe/new" class="btn btn-primary btn-sm">
            + {t('NEW_GARMENT')}
          </a>
        </EmptyState>
      ) : (
        <Figures model={model} />
      )}
    </PageShell>
  );
}

function Figures({ model }: { model: InsightsPageModel }) {
  const { insights, today } = model;
  const { condition } = insights;
  return (
    <>
      <p class="text-sm" id="insights-closet">
        {t('insights.CLOSET_SIZE', insights.closet)}
      </p>
      {insights.recentWearDays === 0 && (
        <p class="alert text-sm" id="insights-no-wears">
          {t('insights.NO_WEARS')}
        </p>
      )}
      <div class={CARD_COLUMNS}>
        <WornLately insights={insights} />
        {condition.needsRepair + condition.replaceSoon > 0 && (
          <InsightCard id="insights-attention" title={t('insights.ATTENTION')}>
            <p class="text-sm">
              {[
                condition.needsRepair > 0 &&
                  t('insights.NEEDS_REPAIR', { count: condition.needsRepair }),
                condition.replaceSoon > 0 &&
                  t('insights.REPLACE_SOON', { count: condition.replaceSoon }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <a href={NEEDS_ATTENTION_URL} class="btn btn-outline btn-sm">
              {t('insights.ATTENTION')}
            </a>
          </InsightCard>
        )}
        <Unworn
          unworn={insights.unworn}
          today={today}
          shown={RANKED_LIMIT}
          windowUrl={(choice) => `${insightsUrl(choice)}#insights-unworn`}
          seeAll
        />
        {insights.mostWorn.length > 0 && (
          <InsightCard id="insights-most-worn" title={t('insights.MOST_WORN')}>
            <GarmentList rows={wornRows(insights.mostWorn, today)} />
          </InsightCard>
        )}
        {/* Empty while every garment is newer than the threshold. */}
        {insights.leastWorn.length > 0 && (
          <InsightCard
            id="insights-least-worn"
            title={t('insights.LEAST_WORN')}
          >
            <p class="text-xs text-muted">
              {t('insights.LEAST_WORN_NOTE', {
                days: LEAST_WORN_MIN_OWNED_DAYS,
              })}
            </p>
            <GarmentList rows={wornRows(insights.leastWorn, today)} />
          </InsightCard>
        )}
        <Cost cost={insights.cost} />
        <Pairs insights={insights} />
        <Colours insights={insights} />
        <InsightCard id="insights-categories" title={t('insights.CATEGORIES')}>
          <BreakdownList
            rows={insights.categories}
            label={(key) => categoryLabel(key!)}
          />
        </InsightCard>
        {insights.brands.length > 0 && (
          <InsightCard id="insights-brands" title={t('insights.BRANDS')}>
            <BreakdownList
              rows={insights.brands}
              label={(key) => key ?? t('insights.OTHER_BRANDS')}
            />
            {insights.unbranded > 0 && (
              <p class="text-xs text-muted">
                {t('insights.UNBRANDED', { count: insights.unbranded })}
              </p>
            )}
          </InsightCard>
        )}
      </div>
    </>
  );
}

function WornLately({
  insights,
}: {
  insights: WardrobeInsights<SignablePhotoRef>;
}) {
  return (
    <InsightCard id="insights-worn" title={t('insights.WORN_LATELY')}>
      <div class={`${STAT_GRID} text-center`}>
        {insights.worn.map((share) => (
          <div class="rounded-box bg-base-200 p-2" data-window={share.days}>
            <p class="text-2xl font-bold" data-percent>
              {share.percent}%
            </p>
            <p class="text-xs">
              {t('insights.WORN_OF', { worn: share.worn, total: share.total })}
            </p>
            <p class="text-xs text-muted">
              {t('insights.WORN_WINDOW', { days: share.days })}
            </p>
          </div>
        ))}
      </div>
    </InsightCard>
  );
}

/**
 * GET /wardrobe/insights/unworn[?unworn=30|90|180] (#728): every unworn
 * garment, which insights cuts to its first five; the same window chips,
 * here linking to this page. Uncapped: "See all" must reach the whole list,
 * and a closet is a household's own wardrobe, not an unbounded feed.
 */
export function UnwornPage(props: {
  ctx: ViewContext;
  model: InsightsPageModel;
}) {
  const { ctx, model } = props;
  return (
    <PageShell
      ctx={ctx}
      name="unworn"
      bar={{
        title: t(UNWORN_KEY),
        back: insightsUrl(model.insights.unworn.days),
      }}
      body={{ gap: 4 }}
    >
      <Unworn
        unworn={model.insights.unworn}
        today={model.today}
        windowUrl={unwornListUrl}
      />
    </PageShell>
  );
}

/**
 * The unworn list's card: the window chips (`windowUrl`), the count, the
 * first `shown` garments (all of them when unset) with "Style this", and
 * past them "See all" to the list's page (`seeAll`).
 */
function Unworn(props: {
  unworn: WardrobeInsights<SignablePhotoRef>['unworn'];
  today: IsoDate;
  shown?: number;
  windowUrl: (days: UnwornDays) => string;
  seeAll?: boolean;
}) {
  const { days, garments } = props.unworn;
  const shown = garments.slice(0, props.shown);
  const more = garments.length - shown.length;
  return (
    <InsightCard id="insights-unworn" title={t(UNWORN_KEY)}>
      <nav
        class="flex items-center gap-2 flex-wrap"
        aria-label={t('insights.UNWORN_FOR')}
      >
        {UNWORN_CHOICES.map((choice: UnwornDays) => (
          <a
            href={props.windowUrl(choice)}
            class={`btn btn-xs ${choice === days ? 'btn-primary' : 'btn-ghost'}`}
            aria-current={choice === days ? 'true' : undefined}
          >
            {t('insights.UNWORN_DAYS', { days: choice })}
          </a>
        ))}
      </nav>
      <p class="text-sm" data-unworn-count={garments.length}>
        {garments.length === 0
          ? t('insights.UNWORN_NONE', { days })
          : t('insights.UNWORN_COUNT', { days, count: garments.length })}
      </p>
      <GarmentList
        rows={shown.map((garment) => ({
          garment,
          detail:
            garment.lastWorn === null
              ? t('insights.NEVER_WORN')
              : t('insights.LAST_WORN', {
                  when: relativeDay(garment.lastWorn, props.today),
                }),
        }))}
        action={(g) => (
          <a href={styleThisUrl(g.id)} class="btn btn-outline btn-xs">
            {t('gallery.STYLE_THIS')}
          </a>
        )}
      />
      {more > 0 && props.seeAll && (
        <a
          href={unwornListUrl(days)}
          class="btn btn-outline btn-sm self-start"
          data-see-all
        >
          {t('insights.SEE_ALL')}
        </a>
      )}
    </InsightCard>
  );
}

/** "Worn 12 times · last worn 3 days ago"; "Not worn yet". */
function wornDetail(
  garment: InsightGarment<SignablePhotoRef>,
  today: IsoDate,
): string {
  if (garment.lastWorn === null) return t('wear.NOT_WORN');
  return [
    garment.wearDays === 1
      ? t('wear.WORN_ONCE')
      : t('wear.WORN_TIMES', { count: garment.wearDays }),
    t('wear.LAST_WORN', { when: relativeDay(garment.lastWorn, today) }),
  ].join(' · ');
}

/** Garments with the worn line. */
function wornRows(
  garments: InsightGarment<SignablePhotoRef>[],
  today: IsoDate,
) {
  return garments.map((garment) => ({
    garment,
    detail: wornDetail(garment, today),
  }));
}

function CostList(props: {
  id: string;
  title: string;
  entries: CostPerWear<SignablePhotoRef>[];
}) {
  if (props.entries.length === 0) return null;
  return (
    <div id={props.id}>
      <h3 class="text-sm text-muted mb-1">{props.title}</h3>
      <GarmentList
        rows={props.entries.map((entry) => ({
          garment: entry.garment,
          detail: perWearLine(entry),
        }))}
      />
    </div>
  );
}

function Cost({ cost }: { cost: WardrobeInsights<SignablePhotoRef>['cost'] }) {
  return (
    <InsightCard id="insights-cost" title={t('insights.COST_PER_WEAR')}>
      {cost.priced === 0 ? (
        <p class="text-sm text-muted">{t('insights.NO_PRICES')}</p>
      ) : (
        <>
          <p class="text-xs text-muted">{t('insights.COST_INTRO')}</p>
          <p class="text-sm" data-closet-value={cost.closetValue}>
            {t('insights.CLOSET_VALUE', {
              total: priceLabel(cost.closetValue),
            })}
            {cost.unpriced > 0 &&
              ` · ${t('insights.UNPRICED', { count: cost.unpriced })}`}
          </p>
          <CostList
            id="insights-best-value"
            title={t('insights.BEST_VALUE')}
            entries={cost.best}
          />
          <CostList
            id="insights-most-per-wear"
            title={t('insights.MOST_PER_WEAR')}
            entries={cost.worst}
          />
          <CostList
            id="insights-not-worn-yet"
            title={t('insights.NOT_WORN_YET', {
              count: cost.notWornYetCount,
            })}
            entries={cost.notWornYet}
          />
        </>
      )}
    </InsightCard>
  );
}

function Pairs({ insights }: { insights: WardrobeInsights<SignablePhotoRef> }) {
  return (
    <InsightCard id="insights-pairs" title={t('insights.PAIRS')}>
      {insights.pairs.length === 0 ? (
        <p class="text-sm text-muted">{t('insights.PAIRS_NONE')}</p>
      ) : (
        <>
          <p class="text-xs text-muted">{t('insights.PAIRS_INTRO')}</p>
          <ul class="flex flex-col gap-3">
            {insights.pairs.map(({ a, b, days }) => (
              <li
                class="flex items-center gap-2"
                data-pair={`${a.id}-${b.id}`}
                data-days={days}
              >
                {[a, b].map((garment) => (
                  <a href={garmentUrl(garment.id, undefined)} class="shrink-0">
                    <GarmentThumb garment={garment} class="rounded-box" />
                  </a>
                ))}
                <span class="flex flex-col min-w-0 text-sm">
                  <span class="truncate">{garmentName(a)}</span>
                  <span class="truncate">{garmentName(b)}</span>
                  <span class="text-xs text-muted">
                    {t('insights.PAIR_DAYS', { count: days })}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </InsightCard>
  );
}

/**
 * The palette: the closet's colours and the worn ones as strips, each
 * segment as wide as its share (flex-grow over a zero basis, so rounding
 * never overflows the strip), coloured by the garment form's swatch
 * classes (main.css, `.ms-swatch--<colour>`), and the garments without a
 * colour as a plain segment at the end, so each colour takes its share of
 * the whole closet; the legend says it in words.
 */
function Colours({
  insights,
}: {
  insights: WardrobeInsights<SignablePhotoRef>;
}) {
  if (insights.colours.length === 0) return null;
  const { uncoloured } = insights;
  return (
    <InsightCard id="insights-colours" title={t('insights.COLOURS')}>
      <Strip
        name="closet"
        title={t('insights.COLOURS_CLOSET')}
        colours={insights.colours}
        share={(colour) => colour.closet}
        uncoloured={uncoloured.closet}
      />
      {insights.recentWearDays > 0 && (
        <Strip
          name="worn"
          title={t('insights.COLOURS_WORN')}
          colours={insights.colours}
          share={(colour) => colour.worn}
          uncoloured={uncoloured.worn}
        />
      )}
      <ul class="flex flex-col gap-1 text-xs">
        {insights.colours.map((colour) => (
          <li class="flex items-center gap-2">
            <span
              class={`size-3 shrink-0 rounded-full ring-1 ring-base-300 ms-swatch--${colour.colour}`}
            />
            <span>
              <span class="capitalize font-medium">{colour.colour}</span>{' '}
              {t('insights.COLOUR_SHARE', {
                closet: colour.closet,
                worn: colour.worn,
              })}
            </span>
          </li>
        ))}
      </ul>
      {uncoloured.garments > 0 && (
        <p class="text-xs text-muted">
          {t('insights.UNCOLOURED', {
            count: uncoloured.garments,
            closet: uncoloured.closet,
            worn: uncoloured.worn,
          })}
        </p>
      )}
    </InsightCard>
  );
}

function BreakdownList(props: {
  rows: Breakdown[];
  label: (key: string | null) => string;
}) {
  return (
    <ul class="flex flex-col gap-2">
      {props.rows.map((row) => (
        <li data-key={row.key ?? ''}>
          <div class="flex items-baseline justify-between gap-2 text-sm">
            <span class="font-medium truncate">{props.label(row.key)}</span>
            <span class="text-xs text-muted shrink-0">{row.closet}%</span>
          </div>
          <p class="text-xs text-muted">{breakdownLine(row)}</p>
          <progress
            class="progress progress-primary w-full"
            value={String(row.worn)}
            max="100"
            aria-label={breakdownLine(row)}
          />
        </li>
      ))}
    </ul>
  );
}

/** "12 garments · 14 pieces · 30% of wears". */
function breakdownLine(row: Breakdown): string {
  return t('insights.BREAKDOWN_LINE', {
    garments: row.garments,
    pieces: row.pieces,
    worn: row.worn,
  });
}
