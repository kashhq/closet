import type { Idea } from '../../wardrobe/generator';
import type { ActivewearGap, Occasion } from '../../wardrobe/occasions';
import { displayTemperature } from '../../weather/temperature';
import { PostForm } from '../auth/form';
import type { IsoDate } from '../../calendar-date';
import { dayLabel, occasionLabel } from '../date-labels';
import type { CapsuleRef } from '../capsules/queries';
import { t } from '../i18n';
import { PageSentinel } from '../page-sentinel';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { PageMain } from '../layout/page-main';
import { BackLink, EmptyState } from '../layout/parts';
import { OutfitCollage } from '../outfits/collage';
import {
  DestinationFields,
  type OutfitDestination,
} from '../outfits/destination';
import {
  DayDestinationLine,
  destinationPickLabel,
} from '../outfits/destination-views';
import { OutfitTabs } from '../outfits/outfit-tabs';
import { SnapStrip, SnapStripsInit, snapItem } from '../strip/snap-strip';
import { brokenRuleLabels } from '../style/labels';
import { tripUrl } from '../trips/urls';
import type { ViewContext } from '../view-context';
import { categoryLabel } from '../wardrobe/garment';
import { OpenMeteoCredit, UNIT_SYMBOLS } from '../weather/views';
import {
  adviceChips,
  type Chip,
  ChipList,
  fitsChip,
  problemChip,
  warningChip,
} from './chips';
import { ideaName, type IdeasWeather, shuffledSeed } from './ideas';
import type { PoolGarment } from './queries';
import { type GalleryState, ideasUrl } from './urls';

/**
 * The Outfits page's Ideas tab (#9): generated outfits as full-width cards
 * in a horizontal scroll-snap strip. Swiping is the browser's own
 * scrolling (no carousel library, no touch handlers); the strip's last
 * child is a sentinel that loads the next page when it scrolls into view
 * and replaces itself (GET /outfits/ideas/more), as the wardrobe grid's
 * does. A card's primary action follows `?for=` (OutfitDestination): plan
 * it on that day (or, with `&replace=`, put it in that entry's place, #69),
 * add it to that trip (#10), else save it. Every write is data-needs-network: offline
 * the cards the worker cached still show, the writes are disabled and the
 * page says why.
 */

/** A gallery with its seed decided (the page resolves the daily seed). */
export type SeededState = GalleryState & { seed: number };

export interface IdeasPageModel {
  state: SeededState;
  /** The day and occasion the ideas are for (today, all day, without `?for=`). */
  planning: { day: IsoDate; occasion: Occasion };
  /** The trip a pick goes to (`for=trip:ID`), the owner's. */
  trip: { id: number; name: string } | undefined;
  capsule: CapsuleRef | undefined;
  /** The owner's capsules, for the scope menu. */
  capsules: CapsuleRef[];
  styled: PoolGarment | undefined;
  cards: IdeaCardsModel;
}

export function IdeasPage(props: { ctx: ViewContext; model: IdeasPageModel }) {
  const { ctx, model } = props;
  const { state, cards } = model;
  const shuffle = ideasUrl({ ...state, seed: shuffledSeed(state.seed) });
  return (
    <Layout ctx={ctx} title={t('gallery.TITLE')}>
      <AppBar
        ctx={ctx}
        title={t('OUTFITS')}
        actions={
          <a href={shuffle} class="btn btn-ghost btn-sm" data-shuffle="">
            ⤮ {t('gallery.SHUFFLE')}
          </a>
        }
      />
      <PageMain width="wide" class="p-4 pt-20 pb-24 flex flex-col gap-3">
        <OutfitTabs
          active="ideas"
          destination={
            state.destination.kind === 'day' ? state.destination : undefined
          }
        />
        <Scope model={model} />
        {cards.weather && <WeatherNote weather={cards.weather} />}
        <ChipList chips={adviceChips(cards.weather)} />
        <p
          data-offline-note=""
          class="alert alert-warning alert-soft py-2 text-sm"
          role="note"
        >
          {t('gallery.OFFLINE')}
        </p>
        {cards.ideas.length > 0 ? (
          <>
            <SnapStrip
              size="page"
              label={t('gallery.STRIP_LABEL')}
              listbox={false}
              tapThrough
              frameClass="lg:w-full lg:max-w-3xl lg:mx-auto"
              class="pb-2"
              attributes={{ id: 'idea-strip' }}
            >
              <IdeaCards model={cards} />
            </SnapStrip>
            <SnapStripsInit />
          </>
        ) : (
          <EmptyState message={emptyMessage(model)}>
            <a href="/wardrobe" class="btn btn-primary btn-sm">
              {t('gallery.EMPTY_ACTION')}
            </a>
          </EmptyState>
        )}
      </PageMain>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/** Why there are no ideas: no activewear, or none available (a workout), else the everyday reason. */
function emptyMessage(model: IdeasPageModel): string {
  const { emptyReason } = model.cards;
  if (emptyReason === 'no-activewear') return t('gallery.EMPTY_NO_ACTIVEWEAR');
  if (emptyReason === 'none-available') {
    return t('gallery.EMPTY_ACTIVEWEAR_AWAY');
  }
  return t(model.capsule ? 'gallery.EMPTY_CAPSULE' : 'gallery.EMPTY');
}

/**
 * What the ideas are for and drawn from: the day and occasion with the way
 * back to the plan page, the capsule (a menu to change it) and "Style
 * this"'s garment, each removable.
 */
function Scope({ model }: { model: IdeasPageModel }) {
  const { state, planning, trip, capsule, capsules, styled } = model;
  const { destination } = state;
  return (
    <div class="flex flex-col gap-2 px-2">
      {destination.kind === 'trip' && trip && (
        <div class="flex items-center gap-2" data-ideas-trip={trip.id}>
          <BackLink href={tripUrl(trip.id)} />
          <p class="text-sm min-w-0">
            <span class="font-medium">
              {t('gallery.FOR_TRIP', { name: trip.name })}
            </span>{' '}
            · {dayLabel(planning.day)}
            {destination.occasion && (
              <> · {occasionLabel(destination.occasion)}</>
            )}
          </p>
        </div>
      )}
      {destination.kind === 'day' && (
        <DayDestinationLine destination={destination} />
      )}
      <div class="flex flex-wrap items-center gap-2">
        {capsules.length > 0 && (
          <details class="dropdown">
            <summary class="btn btn-sm btn-outline rounded-full">
              {capsule ? capsule.name : t('gallery.ALL_GARMENTS')} ▾
            </summary>
            <ul class="dropdown-content menu bg-base-100 rounded-box shadow-md z-20 w-56 mt-1">
              <li>
                <a href={ideasUrl({ ...state, capsuleId: undefined })}>
                  {t('gallery.ALL_GARMENTS')}
                </a>
              </li>
              {capsules.map((option) => (
                <li>
                  <a
                    href={ideasUrl({ ...state, capsuleId: option.id })}
                    aria-current={
                      option.id === capsule?.id ? 'true' : undefined
                    }
                  >
                    {option.name}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        )}
        {styled && (
          <span class="badge badge-lg badge-soft badge-primary gap-1">
            {t('gallery.WITH', {
              name: styled.name ?? categoryLabel(styled.category),
            })}
            <a
              href={ideasUrl({ ...state, withId: undefined })}
              aria-label={t('gallery.WITHOUT')}
              class="link link-hover"
            >
              ✕
            </a>
          </span>
        )}
      </div>
    </div>
  );
}

function WeatherNote({ weather }: { weather: IdeasWeather }) {
  const { needs, unit } = weather;
  const notes = [
    needs.layer ? t('weather.TAKE_LAYER') : null,
    needs.rain ? t('gallery.RAIN') : null,
  ].filter((note) => note !== null);
  return (
    <p
      class="px-2 text-sm text-base-content/70"
      data-ideas-weather={weather.typical ? 'typical' : 'forecast'}
    >
      {t(weather.typical ? 'gallery.FEELS_TYPICAL' : 'gallery.FEELS', {
        range: t('weather.RANGE', {
          low: displayTemperature(needs.feelsLike.min, unit),
          high: displayTemperature(needs.feelsLike.max, unit),
          unit: UNIT_SYMBOLS[unit],
        }),
      })}
      {notes.map((note) => (
        <span> · {note}</span>
      ))}
      <OpenMeteoCredit class="block" />
    </p>
  );
}

export interface IdeaCardsModel {
  state: SeededState;
  planning: { day: IsoDate; occasion: Occasion };
  ideas: Idea<PoolGarment>[];
  weather: IdeasWeather | null;
  /** The Ideas page's empty state, when activewear is why (IdeasResult.emptyReason). */
  emptyReason?: ActivewearGap;
  /** 1-based. */
  page: number;
  more: boolean;
}

/**
 * One page of cards and, when there are more, the sentinel that fetches
 * the next (`intersect`: it watches the strip's own scrolling, which
 * `revealed` does not). GET /outfits/ideas/more answers with this alone.
 */
export function IdeaCards({ model }: { model: IdeaCardsModel }) {
  return (
    <>
      {model.ideas.map((idea, index) => (
        <IdeaCard
          model={model}
          idea={idea}
          eager={model.page === 1 && index === 0}
        />
      ))}
      {model.more && (
        <PageSentinel
          as="div"
          class="snap-center shrink-0 w-16 flex items-center justify-center"
          href={ideasUrl(model.state, {
            path: '/outfits/ideas/more',
            page: model.page + 1,
          })}
          trigger="intersect once"
          marker="ideas"
          label={t('outfits.LOADING_MORE')}
        />
      )}
    </>
  );
}

/** The gallery's state as hidden fields: a write's redirect comes back to the same ideas. */
function StateFields({ state }: { state: SeededState }) {
  return (
    <>
      <DestinationFields destination={state.destination} />
      {state.capsuleId !== undefined && (
        <input type="hidden" name="capsule" value={String(state.capsuleId)} />
      )}
      {state.withId !== undefined && (
        <input type="hidden" name="with" value={String(state.withId)} />
      )}
      <input type="hidden" name="seed" value={String(state.seed)} />
    </>
  );
}

/** A card's primary action, by where the idea goes. */
function pickLabel(destination: OutfitDestination): string {
  return destination.kind === 'none'
    ? t('gallery.PICK_SAVE')
    : destinationPickLabel(destination);
}

function IdeaCard(props: {
  model: IdeaCardsModel;
  idea: Idea<PoolGarment>;
  eager: boolean;
}) {
  const { model, idea } = props;
  // The strip opens on the first card of the first page.
  const selected = props.eager;
  const { destination } = model.state;
  const name = ideaName(idea.garments);
  const ideaKey = idea.garments.map((g) => g.id).join(',');
  const pairs = idea.garments.flatMap((a, i) =>
    idea.garments.slice(i + 1).map((b) => [a, b] as const),
  );
  return (
    <article
      {...snapItem({
        value: ideaKey,
        selected,
        size: 'page',
        listbox: false,
        class: 'card bg-base-100 shadow-sm',
      })}
      data-idea={ideaKey}
    >
      <div class="card-body p-3 gap-3">
        <OutfitCollage garments={idea.garments} eager={props.eager} />
        <h2 class="font-semibold text-sm line-clamp-2">{name}</h2>
        <Reasons idea={idea} weather={model.weather} />
        {/* One row: the pick, and "Not this" opening upward over the
            collage, so a whole card fits a phone screen above the dock. */}
        <div class="flex items-start gap-2">
          <PostForm action="/outfits/ideas/pick" class="flex-1">
            {idea.garments.map((g) => (
              <input type="hidden" name="garmentId" value={String(g.id)} />
            ))}
            <StateFields state={model.state} />
            <button type="submit" class="btn btn-primary w-full">
              {pickLabel(destination)}
            </button>
          </PostForm>
          <details class="dropdown dropdown-top dropdown-end">
            <summary class="btn btn-ghost">{t('gallery.NOT_THIS')}</summary>
            <div class="dropdown-content bg-base-100 rounded-box shadow-md z-20 w-72 p-3 mb-1 flex flex-col gap-2">
              <div class="flex flex-wrap gap-2">
                {model.weather && (
                  <PostForm action="/outfits/ideas/feedback" class="contents">
                    <StateFields state={model.state} />
                    <button
                      type="submit"
                      name="feeling"
                      value="too-warm"
                      class="btn btn-outline btn-xs"
                    >
                      {t('gallery.TOO_WARM')}
                    </button>
                    <button
                      type="submit"
                      name="feeling"
                      value="too-cold"
                      class="btn btn-outline btn-xs"
                    >
                      {t('gallery.TOO_COLD')}
                    </button>
                  </PostForm>
                )}
                {/* A dismissal only: nothing is stored. */}
                <button
                  type="button"
                  class="btn btn-outline btn-xs"
                  onclick="this.closest('[data-idea]').remove()"
                >
                  {t('gallery.NOT_TODAY')}
                </button>
              </div>
              <p class="text-xs text-muted">{t('gallery.CLASHES_PROMPT')}</p>
              <div class="flex flex-wrap gap-2">
                {pairs.map(([a, b]) => (
                  // htmx removes the card on success; without script the
                  // same form posts natively and comes back to the gallery.
                  <form
                    method="post"
                    action="/outfits/ideas/avoid"
                    hx-post="/outfits/ideas/avoid"
                    hx-target="closest [data-idea]"
                    hx-swap="delete"
                    data-needs-network=""
                  >
                    <input
                      type="hidden"
                      name="garmentId"
                      value={String(a.id)}
                    />
                    <input
                      type="hidden"
                      name="garmentId"
                      value={String(b.id)}
                    />
                    <StateFields state={model.state} />
                    <button type="submit" class="btn btn-outline btn-xs">
                      {t('gallery.PAIR', {
                        a: a.name ?? categoryLabel(a.category),
                        b: b.name ?? categoryLabel(b.category),
                      })}
                    </button>
                  </form>
                ))}
              </div>
            </div>
          </details>
        </div>
      </div>
    </article>
  );
}

/**
 * Why this idea: how it meets the weather and the occasion, and what the
 * rotation brought back. Today's cards show it too (src/web/today).
 */
export function Reasons({
  idea,
  weather,
}: {
  idea: Idea<PoolGarment>;
  weather: IdeasWeather | null;
}) {
  const rested = idea.garments
    .filter((g) => idea.rested.includes(g.id) && g.name)
    .map((g) => g.name)
    .slice(0, 2);
  // A broken rule is named, one chip each (brokenRuleLabels), not the flag.
  const chips: Chip[] = [
    ...idea.problems.flatMap((problem) =>
      problem === 'breaks-rule' ? [] : [problemChip(problem)],
    ),
    ...brokenRuleLabels(idea).map(warningChip),
    ...(weather && idea.problems.length === 0 ? [fitsChip(weather)] : []),
    ...(rested.length > 0
      ? [
          {
            text: t('gallery.RESTED', { names: rested.join(', ') }),
            tone: 'badge-ghost' as const,
          },
        ]
      : []),
  ];
  return <ChipList chips={chips} />;
}
