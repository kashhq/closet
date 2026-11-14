import type { Location } from '../../weather/location';
import type { Feeling, TemperatureUnit } from '../../weather/temperature';
import { type ActionDeps, logOp } from '../op-log';
import type { Actor } from '../sharing/access';
import {
  clearHere,
  clearHome,
  nudgeTemperatureOffset,
  resetTemperatureOffset,
  setHere,
  setHome,
  setTemperatureUnit,
} from './queries';

/**
 * The person's weather settings (#712): the one place each write logs its
 * outcome, whichever door called it (the Profile and Ideas pages,
 * `/api/v1/weather/*`). The place's name and its coordinates are never
 * fields: they are where the person is.
 */

export async function setWeatherHome(
  { db, logger }: ActionDeps,
  actor: Actor,
  home: Parameters<typeof setHome>[2],
): Promise<void> {
  await setHome(db, actor.userId, home);
  logOp(logger, actor, 'weather.home.set');
}

export async function removeWeatherHome(
  { db, logger }: ActionDeps,
  actor: Actor,
): Promise<void> {
  await clearHome(db, actor.userId);
  logOp(logger, actor, 'weather.home.removed');
}

/** "Use my location": this phone's position, fresh as of `at`. */
export async function setWeatherHere(
  { db, logger }: ActionDeps,
  actor: Actor,
  location: Location,
  at: Date,
): Promise<void> {
  await setHere(db, actor.userId, location, at);
  logOp(logger, actor, 'weather.here.set');
}

export async function removeWeatherHere(
  { db, logger }: ActionDeps,
  actor: Actor,
): Promise<void> {
  await clearHere(db, actor.userId);
  logOp(logger, actor, 'weather.here.removed');
}

export async function setWeatherUnit(
  { db, logger }: ActionDeps,
  actor: Actor,
  unit: TemperatureUnit,
): Promise<void> {
  await setTemperatureUnit(db, actor.userId, unit);
  logOp(logger, actor, 'weather.unit.set', { unit });
}

/** "Too warm" / "too cold": the offset moves a step; answers where it is now. */
export async function nudgeWeatherOffset(
  { db, logger }: ActionDeps,
  actor: Actor,
  feeling: Feeling,
): Promise<number> {
  const offset = await nudgeTemperatureOffset(db, actor.userId, feeling);
  logOp(logger, actor, 'weather.offset.nudged', { feeling, offset });
  return offset;
}

export async function resetWeatherOffset(
  { db, logger }: ActionDeps,
  actor: Actor,
): Promise<void> {
  await resetTemperatureOffset(db, actor.userId);
  logOp(logger, actor, 'weather.offset.reset');
}
