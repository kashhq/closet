import type { TemplateSlot } from '../../wardrobe/week';
import { type ActionDeps, logOp } from '../op-log';
import type { Actor } from '../sharing/access';
import type { WeatherService } from '../weather/service';
import { type PlannedNow, planMyWeekNow, undoWeekPlan } from './plan';
import { saveWeekTemplate } from './template';

/**
 * The weekly auto-plan's writes (#712): the one place each logs its outcome,
 * whichever door called it (the calendar's button, `POST /week-plans`,
 * plan_week). The daily re-plan (replan.ts) is a job with its own lines.
 */

/** What planning a week needs besides the log: the forecast's source and the household's zone. */
export interface PlanWeekDeps extends ActionDeps {
  weather: WeatherService | undefined;
  timeZone: string;
}

/**
 * "Plan my week" (planMyWeekNow). `changed` is false when nothing was
 * planned: no week template (`templateSet` false) or every slot filled
 * already, the retry that plans nothing.
 */
export async function planWeekFor(
  { db, logger, weather, timeZone }: PlanWeekDeps,
  actor: Actor,
  now: Date,
): Promise<PlannedNow> {
  const started = performance.now();
  const planned = await planMyWeekNow(
    { db, weather, timeZone },
    actor.userId,
    now,
  );
  const { today, forecast, result } = planned;
  logOp(logger, actor, 'week.planned', {
    from: today,
    templateSet: result.templateSet,
    changed: result.weekPlanId !== null,
    weekPlanId: result.weekPlanId,
    planned: result.planned.length,
    entries: result.planned.map((p) => p.entryId),
    unfilled: result.unfilled.length,
    weatherDays: forecast.days.size,
    ms: Math.round(performance.now() - started),
  });
  return planned;
}

/** Undo a Plan my week (undoWeekPlan): another's plan is the 404 of an unknown id. */
export async function undoWeekPlanFor(
  { db, logger }: ActionDeps,
  actor: Actor,
  weekPlanId: number,
): Promise<{ entries: number; outfits: number }> {
  const undone = await undoWeekPlan(db, actor, weekPlanId);
  logOp(logger, actor, 'week.plan.undone', {
    weekPlanId,
    entries: undone.entries,
    outfits: undone.outfits,
  });
  return undone;
}

/** The week template, whole (saveWeekTemplate). */
export async function saveWeekTemplateFor(
  { db, logger }: ActionDeps,
  actor: Actor,
  slots: TemplateSlot[],
): Promise<void> {
  await saveWeekTemplate(db, actor.userId, slots);
  logOp(logger, actor, 'week.template.saved', {
    slots: slots.length,
    days: new Set(slots.map((slot) => slot.weekday)).size,
  });
}
