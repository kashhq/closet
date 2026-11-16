import { t } from '../i18n';
import { ideasUrl } from '../gallery/urls';
import { INSPIRATION_PATH } from '../inspiration/urls';
import type { LinkTabsProps } from '../layout/link-tabs';
import type { DayDestination } from './destination';
import { savedUrl } from './urls';

export type OutfitsTab = 'saved' | 'ideas' | 'inspiration';

/**
 * The Outfits page's views, as the app bar's `tabs` on each of them: Saved
 * (the grid, `/outfits`), Ideas (the gallery, src/web/gallery) and
 * Inspiration (saved looks, #22, src/web/inspiration): plain boosted links,
 * like the Wardrobe's tabs (the redesign's "Outfits › Saved / Ideas", #43).
 * A day being planned (`?for=day:`) travels between the first two, so
 * "+ Plan" can go either way and still come back to the day; Inspiration
 * plans nothing, so its link is always the bare list. Without one the tabs
 * are static on purpose: `/outfits` is a stale-while-revalidate tab root and
 * must render the same bytes while nothing changes.
 */
export function outfitTabs(
  active: OutfitsTab,
  day?: DayDestination,
): LinkTabsProps<OutfitsTab> {
  const destination = day ?? { kind: 'none' };
  return {
    active,
    label: t('NAV_OUTFIT_VIEWS'),
    tabs: [
      {
        name: 'saved',
        href: savedUrl(destination),
        label: t('gallery.TAB_SAVED'),
      },
      {
        name: 'ideas',
        href: ideasUrl({ destination }),
        label: t('gallery.TAB_IDEAS'),
      },
      {
        name: 'inspiration',
        href: INSPIRATION_PATH,
        label: t('gallery.TAB_INSPIRATION'),
      },
    ],
  };
}
