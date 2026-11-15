/**
 * The weekly auto-plan's addresses (#16). "Plan my week" and its Undo are
 * calendar writes (the dock marks Calendar); the template is Profile › Your
 * week, its own page since #728, saved by a post to the same address.
 */

import { CALENDAR_PATH, dayAnchor } from '../calendar/urls';
import { type IsoDate, startOfWeek } from '../../calendar-date';

export const PLAN_WEEK_PATH = '/calendar/plan-week';

/** Undo of one "Plan my week". */
export function undoWeekPlanUrl(weekPlanId: number): string {
  return `${PLAN_WEEK_PATH}/${weekPlanId}/undo`;
}

/**
 * What a plan answers: the week holding the batch's first planned day,
 * scrolled to that day, with the banner (`?planned=`); the current week
 * with the banner alone when nothing was left to plan ('none').
 */
export function plannedWeekUrl(
  planned: number | 'none',
  firstDay?: IsoDate,
): string {
  const flag = `${PLANNED_FLAG}=${planned}`;
  if (!firstDay) return `${CALENDAR_PATH}?${flag}`;
  return `${CALENDAR_PATH}?week=${startOfWeek(firstDay)}&${flag}#${dayAnchor(firstDay)}`;
}

/** The calendar's one-shot flags: the banner after a plan, the toast after an undo. */
export const PLANNED_FLAG = 'planned';
export const UNDONE_FLAG = 'undone';

/**
 * Profile's Your week row (its id: `/auth/profile#week`, from before the
 * split, lands on it) and the template's page, where its form posts.
 */
export const WEEK_SETTINGS_ID = 'week';
export const WEEK_SETTINGS_PATH = '/auth/profile/week';
/** The page's one-shot flag after the template is saved. */
export const WEEK_SAVED_FLAG = 'saved';
