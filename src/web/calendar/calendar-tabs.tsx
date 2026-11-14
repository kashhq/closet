import { t } from '../i18n';
import { LinkTabs } from '../layout/link-tabs';
import { TRIPS_PATH } from '../trips/urls';
import { CALENDAR_MONTH_PATH, CALENDAR_PATH } from './urls';

export type CalendarTab = 'week' | 'month' | 'trips';

/**
 * The Calendar's views: the week agenda (`/calendar`), the month of
 * collages (`/calendar/month`, R6) and Trips (`/trips`, #10), plain
 * boosted links like the Outfits and Wardrobe tabs (the redesign's
 * "Calendar", docs/plans/2026-09-26-redesign.md). Static on purpose:
 * `/calendar` is a stale-while-revalidate tab root and must render the
 * same bytes while nothing changes.
 */
export function CalendarTabs({ active }: { active: CalendarTab }) {
  return (
    <LinkTabs
      active={active}
      label={t('NAV_CALENDAR_VIEWS')}
      tabs={[
        { name: 'week', href: CALENDAR_PATH, label: t('calendar.TAB_WEEK') },
        {
          name: 'month',
          href: CALENDAR_MONTH_PATH,
          label: t('calendar.TAB_MONTH'),
        },
        { name: 'trips', href: TRIPS_PATH, label: t('calendar.TAB_TRIPS') },
      ]}
    />
  );
}
