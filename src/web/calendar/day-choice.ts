import type { Db } from '../../db/client';
import { selectScalars } from '../../db/select-scalars';
import type { Occasion } from '../../wardrobe/occasions';
import { t } from '../i18n';
import type { DayDestination } from '../outfits/destination';
import type { OutfitList } from '../outfits/outfit-list';
import {
  type OutfitPage,
  type OutfitPageAsk,
  type SavedOutfit,
  savedOutfitsSql,
} from '../outfits/queries';
import { occasionLabel } from '../date-labels';
import { type DayEntry, entriesOfDaySql } from './queries';

/**
 * What a list of saved outfits needs to pick one for a day: the plan page
 * (GET /calendar/plan) and the Outfits page's Saved tab with `?for=day:`
 * (R5) read it the same way, so they never disagree on what can be picked.
 */
export interface DayChoice {
  /** The outfits already on the day, with their occasion: an outfit is on a day once. */
  planned: Map<number, Occasion>;
  /**
   * `replace`'s entry when it is the owner's, on the day and for the
   * occasion (#69); undefined otherwise (the page then plans one more:
   * navigation state, never a 404, and the write checks again). A worn one
   * cannot change: the page plans another outfit beside it and says why.
   */
  replacing?: { entryId: number; outfitName: string | null; worn: boolean };
}

/**
 * The plan page's read, one statement (#165, #660): a page of the owner's
 * own outfits of `list`, as every picker lists them (savedOutfitsSql:
 * ownersOutfit, keptOutfit; Muse's proposals are the Outfits tab's own
 * section, #335, one-offs behind the segment, #659), and the day's
 * entries. GET /calendar/plan and its sentinel's GET /calendar/plan/more.
 */
export async function planContext(
  db: Db,
  ownerId: number,
  destination: DayDestination,
  list: OutfitList,
  page: OutfitPageAsk,
): Promise<{ page: OutfitPage<SavedOutfit>; choice: DayChoice }> {
  const row = await selectScalars(db, {
    page: savedOutfitsSql(ownerId, list, page),
    entries: entriesOfDaySql(ownerId, destination.day),
  });
  return { page: row.page, choice: readDayChoice(row.entries, destination) };
}

/**
 * The DayChoice of the day's entries (entriesOfDaySql): planContext's, and
 * the Saved tab's, which reads the entries in its grid's statement
 * (savedContext, src/web/outfits/page-context.ts).
 */
export function readDayChoice(
  entries: readonly DayEntry[],
  destination: DayDestination,
): DayChoice {
  const replacing = entries.find(
    (entry) =>
      entry.id === destination.replace &&
      entry.occasion === destination.occasion,
  );
  return {
    planned: new Map(entries.map((entry) => [entry.outfitId, entry.occasion])),
    replacing: replacing && {
      entryId: replacing.id,
      outfitName: replacing.outfitName,
      worn: replacing.worn,
    },
  };
}

/**
 * The destination a pick posts: with `replace` only while that entry can
 * still change (found, and not worn); else one more outfit on the day.
 */
export function pickDestination(
  destination: DayDestination,
  choice: DayChoice,
): DayDestination {
  const { replace, ...day } = destination;
  return replace !== undefined && choice.replacing?.worn === false
    ? { ...day, replace }
    : day;
}

/**
 * Why an outfit cannot be picked for the day: it is already on it ("On
 * this day · Work"), since the same outfit is on a day once
 * (outfit_calendar's unique key). Undefined when it can be picked.
 */
export function plannedNote(
  choice: DayChoice,
  outfitId: number,
): string | undefined {
  const plannedFor = choice.planned.get(outfitId);
  return (
    plannedFor && `${t('CALENDAR_PLAN_ON_DAY')} · ${occasionLabel(plannedFor)}`
  );
}
