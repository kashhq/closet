import type { Child } from 'hono/jsx';
import type { Idea } from '../../wardrobe/generator';
import type { Occasion } from '../../wardrobe/occasions';
import { AgentBadge } from '../agent-badge';
import { Card } from '../card';
import { PostForm } from '../form';
import type { IsoDate } from '../../calendar-date';
import { type CalendarEntry, entryPieces } from '../calendar/calendar-view';
import { dayLabel, occasionLabel } from '../date-labels';
import { ideaName, type IdeasWeather } from '../gallery/ideas';
import { adviceChips, ChipList } from '../gallery/chips';
// eslint-disable-next-line closet/no-foreign-page-import -- Today draws Ideas' Reasons chips; they move to a shared view piece (#718)
import { Reasons } from '../gallery/ideas-page';
import type { PoolGarment } from '../gallery/queries';
import { ideasUrl } from '../gallery/urls';
import { t } from '../i18n';
import { museName } from '../write-origin';
import { AwayLink } from '../trips/away-link';
import { IDEA_GRID } from '../layout/columns';
import { PageShell } from '../layout/page-shell';
import { HangerIcon, SavedToast, StripFlags } from '../layout/parts';
import { sheetOpener } from '../layout/sheet';
import { OutfitCollage, outfitLabel } from '../outfits/collage';
import type { NeedsToDecide } from '../wishlist/inbox';
import { roundReviewPath, roundWhat } from '../wishlist/round-text';
import type { MuseRound } from '../wishlist/rounds';
import { WISHLIST_PATH } from '../wardrobe/urls';
import { ADD_SHEET_ID, AddSheet } from '../wardrobe/wardrobe-header';
import { EntrySelfie } from '../selfies/views';
import { WornControl } from '../wears/worn-control';
import { SnapStrip, SnapStripsInit, snapItem } from '../strip/snap-strip';
import type { ViewContext } from '../view-context';
import { UserWeatherLine } from '../weather/views';
import { PlanWeekForm } from '../week-plan/views';
import type { FirstRun, IdeasRow, PlannedRow, TodayModel } from './today';
import { TODAY_PATH, todayIdeasUrl, WEAR_THIS_PATH, WORE_FLAG } from './urls';

/**
 * Today (#15; docs/plans/2026-09-26-redesign.md, "Today"): the day's date,
 * its weather line, Muse's one card while a round or a need waits on the
 * owner (#333, #337), then a row per occasion: a planned outfit with "Wore
 * it" and "Change", or three ideas to swipe with "Wear this" and Refresh. A
 * summary with one decision on it: every card leads into another tab's page
 * with the destination set, and Today stores nothing of its own.
 *
 * Network-first, not a stale-while-revalidate tab root (src/web/page-cache.ts):
 * all of it is the day's (the plan, the ideas, what was worn), so a copy
 * from yesterday would offer yesterday's decision. Offline, the worker's
 * last copy shows with its age, and every write is data-needs-network.
 * Being the day's anyway, it renders the weather line itself, from the
 * read its ideas are matched with, where the stale-while-revalidate pages
 * load it after them (WeatherSlot): one request and one weather read
 * fewer on every open of the app (#158).
 *
 * Until the closet can be dressed as an outfit (`model.firstRun`, #666)
 * the page is the first-run path instead: a welcome and one primary
 * action, "Add your first garment", opening the add sheet (camera first);
 * the weather line (the city) once a garment is in; no plan controls and
 * no ideas until then, as they could plan nothing.
 */
export function TodayPage(props: {
  ctx: ViewContext;
  model: TodayModel;
  timeZone: string;
  now: Date;
  /** After "Wear this" (WORE_FLAG): the entry it wore. */
  wore?: number;
}) {
  const { ctx, model } = props;
  const firstRun = model.firstRun ?? null;
  // Only an entry the page shows worn: a stale or edited flag says nothing.
  const wore = model.rows.some(
    (row) =>
      row.kind === 'planned' &&
      row.entries.some((entry) => entry.id === props.wore && entry.worn),
  )
    ? props.wore
    : undefined;
  return (
    <PageShell
      ctx={ctx}
      name="today"
      title={t('today.TITLE')}
      bar={{ title: dayLabel(model.today) }}
      width="wide"
      body={{ gap: 4 }}
      overlays={
        <>
          {firstRun && (
            <AddSheet
              tab="closet"
              viewOwner={undefined}
              canEdit
              newCapsule={false}
            />
          )}
          {wore !== undefined && (
            <SavedToast id="wore-toast" text={t('wear.status.WORN')} />
          )}
          <StripFlags names={[WORE_FLAG]} />
        </>
      }
    >
      {firstRun && <FirstRunCard stage={firstRun} />}
      <WeatherRow model={model} timeZone={props.timeZone} now={props.now} />
      {model.away.map((trip) => (
        <AwayLink trip={trip} class="self-start" />
      ))}
      <p
        data-offline-note=""
        class="alert alert-warning alert-soft py-2 text-sm"
        role="note"
      >
        {t('today.OFFLINE')}
      </p>
      <MuseCard round={model.round} needs={model.needs} />
      {model.rows.map((row) =>
        row.kind === 'planned' ? (
          <PlannedRowView row={row} today={model.today} wore={wore} />
        ) : (
          <IdeasRowView row={row} today={model.today} />
        ),
      )}
      <SnapStripsInit />
      {!firstRun && (
        <div class="flex flex-wrap items-center gap-2">
          <a
            href={`/calendar/plan?for=day:${model.today}`}
            class="btn btn-ghost btn-sm"
          >
            + {t('today.PLAN_ANOTHER')}
          </a>
          {/* The week ahead (#16): lands on the calendar with what it
                planned. From lg it is the one beside the weather. */}
          <PlanWeekForm small class="lg:hidden" />
        </div>
      )}
    </PageShell>
  );
}

/**
 * The weather line (the city once a garment is in, on the first-run path)
 * and, from lg, "Plan my week" beside it. Below lg that button stays in the
 * foot's row, the phone's place for it: the server cannot know the width,
 * so it renders both and CSS shows one, rather than reordering the DOM
 * (a phone's focus order follows what it sees). `max-lg:contents`: below
 * lg the row draws no box, so the line is the body's own child as before
 * and no gap is added when it renders nothing.
 */
function WeatherRow(props: { model: TodayModel; timeZone: string; now: Date }) {
  const firstRun = props.model.firstRun ?? null;
  const weather = firstRun === 'empty' ? null : props.model.weather;
  if (!weather && firstRun) return null;
  return (
    <div class="max-lg:contents lg:flex lg:items-start lg:gap-4">
      {weather && (
        <UserWeatherLine
          weather={weather}
          timeZone={props.timeZone}
          now={props.now}
        />
      )}
      {!firstRun && (
        <PlanWeekForm small class="hidden lg:block lg:ml-auto lg:shrink-0" />
      )}
    </div>
  );
}

/**
 * The first-run path's card (#666): the welcome and "Add your first
 * garment" on an empty closet; once garments are in but no outfit's worth,
 * what is missing and "Add a garment". Its button opens the add sheet in
 * place (a dialog, no navigation), so the camera is one more tap.
 */
function FirstRunCard({ stage }: { stage: FirstRun }) {
  const empty = stage === 'empty';
  return (
    <Card
      as="section"
      variant="content"
      bodyClass="p-4 gap-3 items-center text-center"
      data-first-run={stage}
      aria-labelledby="first-run-title"
    >
      <HangerIcon class="size-12 text-muted" strokeWidth="1.5" />
      <h2 id="first-run-title" class="card-title">
        {t(
          empty
            ? 'today.firstRun.WELCOME_TITLE'
            : 'today.firstRun.INCOMPLETE_TITLE',
        )}
      </h2>
      <p class="text-sm text-muted">
        {t(empty ? 'today.firstRun.WELCOME' : 'today.firstRun.INCOMPLETE')}
      </p>
      <button
        type="button"
        class="btn btn-primary"
        {...sheetOpener(ADD_SHEET_ID)}
        data-first-run-add=""
      >
        {t(empty ? 'today.firstRun.ADD_FIRST' : 'today.firstRun.ADD_MORE')}
      </button>
    </Card>
  );
}

/** One Muse card at most: the waiting round's, else the needs'. */
function MuseCard(props: Pick<TodayModel, 'round' | 'needs'>) {
  if (props.round) return <RoundCard round={props.round} />;
  if (props.needs) return <NeedsCard needs={props.needs} />;
  return null;
}

/**
 * "Muse: 3 outfits, 7 pieces to consider", with Review (#337): the latest
 * round while any of it waits, counted live, so it shrinks as the owner
 * decides and goes at zero (nothing to dismiss). It takes the needs
 * card's place: one Muse card at most. Muse's one line under it, clamped.
 */
function RoundCard({ round }: { round: MuseRound }) {
  return (
    <Card
      as="article"
      variant="content"
      bodyClass="p-3 flex-row items-center gap-3"
      data-muse-round={String(round.id)}
    >
      <div class="flex-1 min-w-0">
        <p class="text-sm font-semibold break-words">
          {t('muse.round.CARD', {
            agent: museName(round.agent),
            what: roundWhat(round),
          })}
        </p>
        {round.summary && (
          <p class="text-sm text-muted line-clamp-1">{round.summary}</p>
        )}
      </div>
      <a href={roundReviewPath(round)} class="btn btn-primary btn-sm shrink-0">
        {t('muse.REVIEW')}
      </a>
    </Card>
  );
}

/**
 * "Muse has 4 needs for you to decide on", with Review (the Wishlist
 * inbox, #333). Gone by itself once no open need has an option left to
 * choose: nothing to dismiss.
 */
function NeedsCard({ needs }: { needs: NeedsToDecide }) {
  const params = { agent: museName(needs.agent), count: needs.count };
  return (
    <Card
      as="article"
      variant="content"
      bodyClass="p-3 flex-row items-center gap-3"
      data-muse-needs={String(needs.count)}
    >
      <p class="text-sm flex-1 min-w-0 break-words">
        {needs.count === 1
          ? t('muse.TODAY_CARD_ONE', params)
          : t('muse.TODAY_CARD', params)}
      </p>
      <a href={WISHLIST_PATH} class="btn btn-primary btn-sm shrink-0">
        {t('muse.REVIEW')}
      </a>
    </Card>
  );
}

/** An occasion's heading and its Refresh: at the row's far edge on a phone, beside the heading from lg, where the edge is a screen away. */
function RowHeading(props: { occasion: Occasion; children?: Child }) {
  return (
    <div class="flex items-center justify-between gap-2 px-2 lg:justify-start lg:gap-4">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">
        {occasionLabel(props.occasion)}
      </h2>
      {props.children}
    </div>
  );
}

function PlannedRowView(props: {
  row: PlannedRow;
  today: IsoDate;
  wore: number | undefined;
}) {
  const { row, today } = props;
  return (
    <section
      class="flex flex-col gap-2"
      data-today-row="planned"
      data-occasion={row.occasion}
    >
      <RowHeading occasion={row.occasion} />
      {/* The ideas' tracks from lg, so a planned card is an idea card's
            size; below lg the section's own stack. */}
      <div class={`flex flex-col gap-2 ${IDEA_GRID}`}>
        {row.entries.map((entry, index) => (
          <PlannedCard
            entry={entry}
            today={today}
            eager={index === 0}
            focused={entry.id === props.wore}
          />
        ))}
      </div>
    </section>
  );
}

function PlannedCard(props: {
  entry: CalendarEntry;
  today: IsoDate;
  eager: boolean;
  /** The entry "Wear this" just wore: its Undo takes focus. */
  focused: boolean;
}) {
  const { entry, today } = props;
  const name = entry.outfit.name || t('UNTITLED_OUTFIT');
  const pieces = entryPieces(entry, today);
  return (
    <Card
      as="article"
      variant="content"
      bodyClass="p-3 gap-3"
      data-entry={entry.id}
    >
      <a
        href={`/outfits/${entry.outfit.id}`}
        aria-label={outfitLabel(name, pieces)}
      >
        <OutfitCollage garments={pieces} eager={props.eager} />
      </a>
      <div class="flex items-center gap-2">
        <h3 class="font-semibold text-sm line-clamp-2 flex-1">{name}</h3>
        <AgentBadge agent={entry.agent} />
        {/* The mirror photo, or the camera to take it: taking one marks
              the entry worn (#19). */}
        <EntrySelfie
          entryId={entry.id}
          day={today}
          selfie={entry.selfie}
          canTake
          returnTo={TODAY_PATH}
          size="card"
        />
      </div>
      <div class="flex items-center gap-2">
        <WornControl
          entryId={entry.id}
          worn={entry.worn}
          label={name}
          size="button"
          returnTo={TODAY_PATH}
          autofocus={props.focused}
        />
        {/* The gallery for this entry's place: a pick changes its outfit
              rather than adding one (#69). Not once worn: a worn entry is
              that day's record. */}
        {!entry.worn && (
          <a
            href={ideasUrl({
              destination: {
                kind: 'day',
                day: today,
                occasion: entry.occasion,
                replace: entry.id,
              },
            })}
            class="btn btn-ghost btn-sm"
            data-change-entry={entry.id}
          >
            {t('today.CHANGE')}
          </a>
        )}
      </div>
    </Card>
  );
}

/**
 * A row of today's ideas for an occasion: the whole answer of Refresh
 * (GET /today/ideas, swapped over this row), so the next page, its own
 * Refresh and the strip arrive together.
 */
export function IdeasRowView(props: { row: IdeasRow; today: IsoDate }) {
  const { row, today } = props;
  return (
    <section
      class="flex flex-col gap-2"
      data-today-row="ideas"
      data-occasion={row.occasion}
      data-page={row.page}
    >
      <RowHeading occasion={row.occasion}>
        {row.ideas.length > 0 && (
          <button
            type="button"
            class="btn btn-ghost btn-xs"
            hx-get={todayIdeasUrl(row.occasion, row.nextPage)}
            hx-target="closest [data-today-row]"
            hx-swap="outerHTML"
            aria-label={t('today.REFRESH_LABEL')}
          >
            <span aria-hidden="true">⤮</span> {t('today.REFRESH')}
          </button>
        )}
      </RowHeading>
      {row.ideas.length > 0 && <ChipList chips={adviceChips(row.weather)} />}
      {row.ideas.length > 0 ? (
        <SnapStrip
          size="peek"
          label={t('today.STRIP_LABEL')}
          listbox={false}
          desktop="grid"
          tapThrough
          class="pb-2"
        >
          {row.ideas.map((idea, index) => (
            <IdeaCard
              idea={idea}
              occasion={row.occasion}
              weather={row.weather}
              eager={index === 0}
            />
          ))}
        </SnapStrip>
      ) : (
        <p class="px-2 text-sm text-muted">
          {t('gallery.EMPTY')}{' '}
          <a href="/wardrobe" class="link">
            {t('gallery.EMPTY_ACTION')}
          </a>
        </p>
      )}
      {row.ideas.length > 0 && (
        <a
          href={ideasUrl({
            destination: { kind: 'day', day: today, occasion: row.occasion },
          })}
          class="link link-hover text-sm px-2 self-start"
        >
          {t('today.MORE_IDEAS')}
        </a>
      )}
    </section>
  );
}

function IdeaCard(props: {
  idea: Idea<PoolGarment>;
  occasion: Occasion;
  weather: IdeasWeather | null;
  eager: boolean;
}) {
  const { idea } = props;
  const ideaKey = idea.garments.map((g) => g.id).join(',');
  return (
    <Card
      as="article"
      variant="content"
      bodyClass="p-3 gap-3"
      {...snapItem({
        value: ideaKey,
        selected: props.eager,
        size: 'peek',
        listbox: false,
        desktop: 'grid',
      })}
      data-idea={ideaKey}
    >
      <OutfitCollage garments={idea.garments} eager={props.eager} />
      <h3 class="font-semibold text-sm line-clamp-2">
        {ideaName(idea.garments)}
      </h3>
      <Reasons idea={idea} weather={props.weather} />
      <PostForm action={WEAR_THIS_PATH} class="mt-auto">
        {idea.garments.map((g) => (
          <input type="hidden" name="garmentId" value={String(g.id)} />
        ))}
        <input type="hidden" name="occasion" value={props.occasion} />
        <button type="submit" class="btn btn-primary w-full">
          {t('today.WEAR_THIS')}
        </button>
      </PostForm>
    </Card>
  );
}
