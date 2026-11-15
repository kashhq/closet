import { Card } from '../card';
import {
  type PackingRow,
  type PackingWarning,
  wearableToday,
} from '../../wardrobe/packing';
import { AgentBadge } from '../agent-badge';
import { PostForm } from '../form';
import { AutosaveForm } from '../autosave';
import { ShownId } from '../checklist';
import type { IsoDate } from '../../calendar-date';
import { occasionLabel } from '../date-labels';
import { imageUrl } from '../files/image-url';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { DayHeading } from '../layout/day-heading';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { HangerIcon, SavedToast, StripFlags } from '../layout/parts';
import {
  type OfflineNotice,
  offlineNotice,
  type QueueableKind,
  queuedTarget,
} from '../../offline-writes';
import { collagePieces, OutfitCollage } from '../outfits/collage';
import { OutboxPending, outboxRegion } from '../outbox';
import type { ViewContext } from '../view-context';
import { PLACE_QUERY_MAX, PLACE_QUERY_MIN } from '../weather/place-input';
import { WornControl } from '../wears/worn-control';
import { phaseLabel, tripDates } from './labels';
import { roleGroupLabel } from '../wardrobe/labels';
import type { PackingGarmentView, TripModel, TripOutfitView } from './model';
import {
  addOutfitUrl,
  dayAnchor,
  TRIPS_PATH,
  tripIdeasUrl,
  tripUrl,
} from './urls';
import { TRIP_ITEM_MAX } from './validation';

/**
 * GET /trips/:id (#10): a trip, phone first. The header (dates,
 * destination), the destination's weather (a fragment loaded after the page,
 * GET /trips/:id/weather, with the search that finds the place on the map),
 * a section per day with its outfits (and "Any day"), each with "+ Add" (a
 * saved outfit) and Ideas (the gallery for that day, with the destination's
 * forecast), "Wore it" (and its Undo) while the trip is on, the packing list
 * (the garments by role with the copies to pack and warnings, checkboxes
 * saved on change) and the extras (checkboxes, add, copy from a previous
 * trip). Network first like every page but the tab roots; offline the
 * worker's copy shows with its writes disabled.
 */

export interface TripPageModel extends TripModel {
  /** The owner's other trips with extras, for "Copy extras from". */
  copyFrom: { id: number; name: string; extras: number }[];
  created: boolean;
  /** An idea from the gallery was just added (`?picked=1`). */
  picked: boolean;
  /** Extras copied just now (`?copied=N`). */
  copied: number | undefined;
}

const PACKED_SUMMARY_ID = 'trip-packed-summary';
const ITEMS_SUMMARY_ID = 'trip-items-summary';

const NOTICE_TEXT = {
  none: 'offlineNotice.NONE',
  wears: 'offlineNotice.WEARS',
  washes: 'offlineNotice.WASHES',
  ticks: 'offlineNotice.TICKS',
  changes: 'offlineNotice.CHANGES',
} as const satisfies Record<OfflineNotice, string>;

/** The kinds this page's controls queue offline: what the notice derives from. */
function queuedKinds(model: TripPageModel): QueueableKind[] {
  return [
    ...(model.packing.garments > 0 ? (['packed'] as const) : []),
    ...(model.items.length > 0 ? (['item'] as const) : []),
    ...(model.wornToday.size > 0 ? (['entry'] as const) : []),
  ];
}

const FLAGS = ['created', 'picked', 'copied'] as const;

export function TripPage(props: { ctx: ViewContext; model: TripPageModel }) {
  const { ctx, model } = props;
  const { trip } = model;
  return (
    <Layout ctx={ctx} title={trip.name}>
      <AppBar
        ctx={ctx}
        title={trip.name}
        back={TRIPS_PATH}
        actions={
          <a href={tripUrl(trip.id, '/edit')} class="btn btn-ghost btn-sm">
            {t('trips.EDIT_SHORT')}
          </a>
        }
      />
      <main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto flex flex-col gap-6">
        <div>
          <p class="text-sm text-base-content/70">
            {tripDates(trip)} · {phaseLabel(model.phase)}
          </p>
          {trip.destination && (
            <p class="text-sm text-muted">{trip.destination}</p>
          )}
        </div>
        <p
          data-offline-note=""
          class="alert alert-warning alert-soft py-2 text-sm"
          role="note"
        >
          {t(NOTICE_TEXT[offlineNotice(queuedKinds(model))])}
        </p>
        {ctx.weatherEnabled && <TripWeatherSection model={model} />}
        <OutfitsSection model={model} />
        <PackingSection model={model} />
        <ExtrasSection model={model} />
        {trip.notes && (
          <section>
            <h2 class="text-xs font-semibold uppercase tracking-wide text-muted mb-1">
              {t('NOTES')}
            </h2>
            <p class="text-sm whitespace-pre-line">{trip.notes}</p>
          </section>
        )}
      </main>
      {model.created && (
        <SavedToast id="trip-created" text={t('trips.CREATED')} />
      )}
      {model.picked && <SavedToast id="trip-picked" text={t('trips.PICKED')} />}
      {model.copied !== undefined && (
        <SavedToast
          id="trip-copied"
          text={t('trips.COPIED', { count: model.copied })}
        />
      )}
      <StripFlags names={FLAGS} />
      <Dock ctx={ctx} />
    </Layout>
  );
}

function SectionHeading(props: { id?: string; children: string }) {
  return (
    <h2
      id={props.id}
      class="text-xs font-semibold uppercase tracking-wide text-muted"
    >
      {props.children}
    </h2>
  );
}

/**
 * The destination's weather: where it is on the map (found through the
 * weather's geocoding, prefilled with the typed destination) and the
 * forecast fragment, loaded once in place with its own indicator.
 */
function TripWeatherSection({ model }: { model: TripPageModel }) {
  const { trip } = model;
  const slot = 'trip-weather';
  return (
    <section class="flex flex-col gap-2" aria-labelledby="trip-weather-heading">
      <SectionHeading id="trip-weather-heading">
        {t('trips.WEATHER')}
      </SectionHeading>
      {model.phase !== 'past' && (
        <>
          <form
            class="join w-full"
            role="search"
            hx-get={tripUrl(trip.id, '/places')}
            hx-target="#trip-places"
            hx-swap="innerHTML"
            data-needs-network=""
          >
            <input
              type="search"
              name="q"
              required
              minlength={PLACE_QUERY_MIN}
              maxlength={PLACE_QUERY_MAX}
              value={trip.location ? undefined : (trip.destination ?? '')}
              class="input input-sm join-item w-full"
              placeholder={t('trips.FIND_PLACE')}
              aria-label={t('trips.FIND_PLACE')}
            />
            <button type="submit" class="btn btn-sm join-item">
              {t(trip.location ? 'trips.CHANGE_PLACE' : 'trips.FIND')}
            </button>
          </form>
          <div id="trip-places" aria-live="polite"></div>
        </>
      )}
      <div
        id={slot}
        class="min-h-5"
        hx-get={tripUrl(trip.id, '/weather')}
        hx-trigger="load"
        hx-swap="innerHTML"
        hx-indicator={`#${slot}`}
      ></div>
    </section>
  );
}

function OutfitsSection({ model }: { model: TripPageModel }) {
  const { trip } = model;
  return (
    <section class="flex flex-col gap-4" aria-labelledby="trip-outfits-heading">
      <div class="flex items-center justify-between gap-2">
        <SectionHeading id="trip-outfits-heading">
          {t('trips.OUTFITS')}
        </SectionHeading>
        <a
          href={tripIdeasUrl(trip.id)}
          class="btn btn-ghost btn-xs"
          data-trip-ideas=""
        >
          {t('trips.IDEAS')}
        </a>
      </div>
      {model.days.map(({ day, outfits }) => (
        <DayBlock model={model} day={day} outfits={outfits} />
      ))}
      <DayBlock model={model} day={null} outfits={model.undated} />
    </section>
  );
}

function DayBlock(props: {
  model: TripPageModel;
  day: IsoDate | null;
  outfits: TripOutfitView[];
}) {
  const { model, day, outfits } = props;
  const tripId = model.trip.id;
  const slot = day ? { day } : {};
  return (
    <div
      id={dayAnchor(day)}
      class="flex flex-col gap-2 scroll-mt-20"
      data-trip-day={day ?? 'any'}
    >
      <div class="flex items-baseline justify-between gap-2">
        {day ? (
          <DayHeading as="h3" date={day} isToday={day === model.today} />
        ) : (
          <h3 class="text-sm font-semibold">{t('trips.ANY_DAY')}</h3>
        )}
        <div class="flex gap-1">
          <a href={tripIdeasUrl(tripId, slot)} class="btn btn-ghost btn-xs">
            {t('trips.DAY_IDEAS')}
          </a>
          <a
            href={addOutfitUrl(tripId, slot)}
            class="btn btn-ghost btn-xs"
            data-add-outfit=""
          >
            + {t('trips.ADD_OUTFIT')}
          </a>
        </div>
      </div>
      {outfits.length === 0 && day !== null && (
        <p class="text-xs text-muted">{t('trips.DAY_EMPTY')}</p>
      )}
      {outfits.map((outfit) => (
        <TripOutfitRow model={model} outfit={outfit} />
      ))}
    </div>
  );
}

/** Worn today (undo), wearable today (mark it), or nothing (null). */
function tripWornControl(model: TripPageModel, outfit: TripOutfitView) {
  const tripId = model.trip.id;
  const wornEntry = model.wornToday.get(outfit.id);
  if (wornEntry !== undefined) {
    return (
      <WornControl
        entryId={wornEntry}
        worn
        label={outfit.name || t('UNTITLED_OUTFIT')}
        size="pill"
        returnTo={tripUrl(tripId)}
      />
    );
  }
  if (!wearableToday(model.trip, outfit.day, model.today)) return null;
  return (
    <WornControl
      worn={false}
      createUrl={tripUrl(tripId, `/outfits/${outfit.id}/wear`)}
      size="pill"
      returnTo={tripUrl(tripId)}
    />
  );
}

/**
 * An outfit of the trip: its whole picture (the `row` collage the pickers'
 * SavedOutfitButton shows, #360) with Remove at its edge, then the name and
 * the occasion with its worn control.
 */
function TripOutfitRow(props: {
  model: TripPageModel;
  outfit: TripOutfitView;
}) {
  const { model, outfit } = props;
  const tripId = model.trip.id;
  const name = outfit.name || t('UNTITLED_OUTFIT');
  const worn = tripWornControl(model, outfit);
  return (
    <Card
      as="article"
      variant="content"
      class="gap-2 p-2"
      data-trip-outfit={outfit.id}
    >
      <div class="flex items-start gap-2">
        {/* The picture links too, but the name's link is the one assistive tech reads. */}
        <a
          href={`/outfits/${outfit.outfitId}`}
          class="flex min-w-0"
          aria-hidden="true"
          tabindex={-1}
        >
          <OutfitCollage
            garments={collagePieces(outfit.garments, { warn: false })}
            size="row"
          />
        </a>
        <PostForm
          action={tripUrl(tripId, `/outfits/${outfit.id}/delete`)}
          class="ms-auto shrink-0"
          confirm={t('trips.CONFIRM_REMOVE_OUTFIT')}
        >
          <button
            type="submit"
            class="btn btn-ghost btn-xs btn-square"
            aria-label={t('trips.REMOVE_OUTFIT')}
          >
            ×
          </button>
        </PostForm>
      </div>
      {/* The worn control sits beside the occasion, not beside the name: a
          "✓ Worn Undo" there crowds the name down to a letter at 390 px. It
          wraps under the occasion where the column is narrow. */}
      <div class="flex flex-col min-w-0">
        {/* The truncation is the span's: on the link it would clip the
            theme's touch hit area (.link, views/assets/main.css). */}
        <a
          href={`/outfits/${outfit.outfitId}`}
          class="link link-hover min-w-0 text-sm font-medium"
        >
          <span class="block truncate">{name}</span>
        </a>
        {(outfit.occasion || outfit.agent || worn !== null) && (
          <span class="flex flex-wrap items-center gap-x-2 text-xs text-muted">
            {outfit.occasion && <span>{occasionLabel(outfit.occasion)}</span>}
            <AgentBadge agent={outfit.agent} />
            {worn}
          </span>
        )}
      </div>
    </Card>
  );
}

/** "3 of 8 packed · 11 pieces · 2 need attention": the autosave answers it out of band. */
export function PackedSummary(props: {
  packing: TripModel['packing'];
  oob?: boolean;
}) {
  const { packing } = props;
  return (
    <p
      id={PACKED_SUMMARY_ID}
      class="text-sm text-base-content/70"
      hx-swap-oob={props.oob ? 'true' : undefined}
      data-packed={packing.packed}
    >
      <span
        data-packed-served={packing.packed}
        data-packed-count={t('trips.PACKED_SUMMARY', {
          packed: '{packed}',
          garments: packing.garments,
          pieces: packing.pieces,
        })}
      >
        {t('trips.PACKED_SUMMARY', {
          packed: packing.packed,
          garments: packing.garments,
          pieces: packing.pieces,
        })}
      </span>
      {packing.warned > 0 && (
        <span class="text-warning">
          {' '}
          · {t('trips.NEED_ATTENTION', { count: packing.warned })}
        </span>
      )}
    </p>
  );
}

function PackingSection({ model }: { model: TripPageModel }) {
  const { packing, trip } = model;
  return (
    <section class="flex flex-col gap-2" aria-labelledby="trip-packing-heading">
      <SectionHeading id="trip-packing-heading">
        {t('trips.PACKING')}
      </SectionHeading>
      {packing.garments === 0 ? (
        <p class="text-sm text-muted">{t('trips.PACKING_EMPTY')}</p>
      ) : (
        <>
          <PackedSummary packing={packing} />
          {/* Each tick queues offline as its own record (#178). */}
          <AutosaveForm
            action={tripUrl(trip.id, '/packed')}
            native
            offlineQueue="packed"
          >
            <div class="flex flex-col gap-3">
              {packing.groups.map((group) => (
                <fieldset data-role={group.role} class="min-w-0">
                  <legend class="text-xs text-muted mb-1">
                    {roleGroupLabel(group.role)}
                  </legend>
                  <ul class="flex flex-col">
                    {group.rows.map((row) => (
                      <PackingRowView tripId={trip.id} row={row} />
                    ))}
                  </ul>
                </fieldset>
              ))}
            </div>
          </AutosaveForm>
        </>
      )}
    </section>
  );
}

function PackingRowView(props: {
  tripId: number;
  row: PackingRow<PackingGarmentView>;
}) {
  const { row } = props;
  const { garment } = row;
  const id = String(garment.id);
  const name = garment.name ?? t('trips.UNNAMED_GARMENT');
  return (
    <li
      class="py-1.5"
      data-packing-garment={garment.id}
      {...outboxRegion(queuedTarget('packed', props.tripId, garment.id), name)}
    >
      <label class="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          name="packed"
          value={id}
          class="checkbox checkbox-sm"
          checked={row.packed}
        />
        {garment.photo ? (
          <img
            src={imageUrl(garment.photo, 'thumb')}
            alt=""
            class="size-10 rounded object-contain bg-base-200 shrink-0"
            width="40"
            height="40"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <span class="size-10 rounded bg-base-200 flex items-center justify-center shrink-0">
            <HangerIcon class="size-4 text-faint" strokeWidth="1.5" />
          </span>
        )}
        <span class="flex flex-col min-w-0 flex-1">
          <span class="text-sm truncate">
            {name}
            {row.pack > 1 && (
              <span class="font-semibold" data-pack={row.pack}>
                {' '}
                ×{row.pack}
              </span>
            )}
          </span>
          <span class="text-xs text-muted">
            {t(row.outfits === 1 ? 'trips.IN_ONE_OUTFIT' : 'trips.IN_OUTFITS', {
              count: row.outfits,
            })}
          </span>
        </span>
      </label>
      <ShownId id={id} />
      <OutboxPending class="ml-8" />
      {row.warnings.length > 0 && (
        <ul class="flex flex-wrap gap-1 mt-1 ml-8">
          {row.warnings.map((warning) => (
            <li
              class="badge badge-sm badge-soft badge-warning h-auto py-0.5"
              data-warning={warning.kind}
            >
              {warningText(warning, row)}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function warningText(
  warning: PackingWarning,
  row: { needed: number; garment: { quantity: number } },
): string {
  switch (warning.kind) {
    case 'too-few':
      return t('trips.warning.TOO_FEW', {
        owned: row.garment.quantity,
        needed: row.needed,
      });
    case 'wash':
      return t('trips.warning.WASH', { clean: warning.clean });
    case 'away':
      return t(`trips.warning.away.${warning.reason}`);
    case 'archived':
      return t('trips.warning.ARCHIVED');
  }
}

/** "2 of 5 packed": the extras' autosave answers it out of band. */
export function ItemsSummary(props: {
  items: TripModel['items'];
  oob?: boolean;
}) {
  const packed = props.items.filter((item) => item.packed).length;
  return (
    <p
      id={ITEMS_SUMMARY_ID}
      class="text-sm text-base-content/70"
      hx-swap-oob={props.oob ? 'true' : undefined}
    >
      <span
        data-packed-served={packed}
        data-packed-count={t('trips.ITEMS_SUMMARY', {
          packed: '{packed}',
          count: props.items.length,
        })}
      >
        {t('trips.ITEMS_SUMMARY', { packed, count: props.items.length })}
      </span>
    </p>
  );
}

function ExtrasSection({ model }: { model: TripPageModel }) {
  const { trip, items } = model;
  const removeForm = (itemId: number) => `trip-item-remove-${itemId}`;
  return (
    <section
      id="extras"
      class="flex flex-col gap-2 scroll-mt-20"
      aria-labelledby="trip-extras-heading"
    >
      <SectionHeading id="trip-extras-heading">
        {t('trips.EXTRAS')}
      </SectionHeading>
      {items.length > 0 && (
        <>
          <ItemsSummary items={items} />
          <AutosaveForm
            action={tripUrl(trip.id, '/items/packed')}
            native
            offlineQueue="item"
          >
            <ul class="flex flex-col">
              {items.map((item) => (
                <li
                  class="flex items-center gap-3 py-1"
                  data-trip-item={item.id}
                  {...outboxRegion(
                    queuedTarget('item', trip.id, item.id),
                    item.label,
                  )}
                >
                  <label class="flex items-center gap-3 flex-1 min-w-0 cursor-pointer">
                    <input
                      type="checkbox"
                      name="packed"
                      value={String(item.id)}
                      class="checkbox checkbox-sm"
                      checked={item.packed}
                    />
                    <span class="text-sm truncate">{item.label}</span>
                  </label>
                  <OutboxPending />
                  <ShownId id={item.id} />
                  {/* Submits its own form below (forms cannot nest). */}
                  <button
                    type="submit"
                    form={removeForm(item.id)}
                    class="btn btn-ghost btn-xs btn-square"
                    aria-label={t('trips.REMOVE_EXTRA', { label: item.label })}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </AutosaveForm>
          {items.map((item) => (
            <PostForm
              id={removeForm(item.id)}
              action={tripUrl(trip.id, `/items/${item.id}/delete`)}
              class="hidden"
            />
          ))}
        </>
      )}
      <PostForm action={tripUrl(trip.id, '/items')} class="join w-full">
        <input
          type="text"
          name="label"
          required
          maxlength={TRIP_ITEM_MAX}
          class="input input-sm join-item w-full"
          placeholder={t('trips.EXTRA_PLACEHOLDER')}
          aria-label={t('trips.EXTRA_PLACEHOLDER')}
        />
        <button type="submit" class="btn btn-sm join-item">
          {t('trips.ADD_EXTRA')}
        </button>
      </PostForm>
      {model.copyFrom.length > 0 && (
        <PostForm action={tripUrl(trip.id, '/items/copy')} class="join w-full">
          <select
            name="from"
            class="select select-sm join-item w-full"
            aria-label={t('trips.COPY_FROM')}
          >
            {model.copyFrom.map((other) => (
              <option value={String(other.id)}>
                {t('trips.COPY_OPTION', {
                  name: other.name,
                  count: other.extras,
                })}
              </option>
            ))}
          </select>
          <button type="submit" class="btn btn-sm join-item">
            {t('trips.COPY_FROM')}
          </button>
        </PostForm>
      )}
    </section>
  );
}
