import { Card } from '../card';
import { tripPhase } from '../../wardrobe/packing';
import { calendarTabs } from '../calendar/calendar-tabs';
import { CARD_GRID } from '../layout/columns';
import type { IsoDate } from '../../calendar-date';
import { t } from '../i18n';
import { PageShell } from '../layout/page-shell';
import { EmptyState } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { phaseLabel, tripDates } from './labels';
import type { TripSummary } from './queries';
import { TRIPS_PATH, tripUrl } from './urls';

const PHASE_BADGE = {
  current: 'badge-primary',
  upcoming: 'badge-soft badge-primary',
  past: 'badge-ghost',
} as const;

/**
 * GET /trips: the Calendar's Trips tab (#10). The owner's trips, those ahead
 * or under way first (soonest first), then the past ones, each a card with
 * its dates, destination and how many outfits and extras it holds: one
 * column on a phone, as many as fit from lg (`CARD_GRID`, #1071).
 */
export function TripsPage(props: {
  ctx: ViewContext;
  trips: TripSummary[];
  today: IsoDate;
}) {
  const { ctx, trips, today } = props;
  return (
    <PageShell
      ctx={ctx}
      name="trips"
      title={t('trips.TITLE')}
      bar={{
        title: t('CALENDAR'),
        actions: (
          <a href={`${TRIPS_PATH}/new`} class="btn btn-primary btn-sm">
            + {t('trips.NEW')}
          </a>
        ),
        tabs: calendarTabs('trips'),
      }}
      width="wide"
      body={{ gap: 3 }}
    >
      {trips.length === 0 ? (
        <EmptyState message={t('trips.EMPTY')}>
          <a href={`${TRIPS_PATH}/new`} class="btn btn-primary btn-sm">
            {t('trips.NEW')}
          </a>
        </EmptyState>
      ) : (
        <ul class={`${CARD_GRID} gap-2`} data-trips="">
          {trips.map((trip) => {
            const phase = tripPhase(trip, today);
            return (
              <li>
                <Card
                  as="a"
                  variant="content"
                  class="h-full hover:bg-base-200 transition-colors"
                  bodyClass="p-4 gap-1"
                  href={tripUrl(trip.id)}
                  data-trip={trip.id}
                >
                  <div class="flex items-start justify-between gap-2">
                    <h2 class="font-semibold truncate">{trip.name}</h2>
                    <span class={`badge badge-sm ${PHASE_BADGE[phase]}`}>
                      {phaseLabel(phase)}
                    </span>
                  </div>
                  <p class="text-sm text-base-content/70">{tripDates(trip)}</p>
                  {trip.destination && (
                    <p class="text-sm text-muted truncate">
                      {trip.destination}
                    </p>
                  )}
                  <p class="text-xs text-muted">
                    {t('trips.COUNTS', {
                      outfits: trip.outfits,
                      extras: trip.extras,
                    })}
                  </p>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </PageShell>
  );
}
