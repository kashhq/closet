import { t } from '../i18n';
import { OfflineIcon } from '../layout/app-status';
import { sectionLabel } from '../layout/dock';
import { PageShell } from '../layout/page-shell';
import { SECTION_HOME } from '../layout/sections';
import { OPENS_STALE, PAGES_CACHE } from '../page-cache';
import type { ViewContext } from '../view-context';
import { offlineFallback, savedPages, savedPagesNone } from '../page-contract';

/**
 * The service worker's navigation fallback (FALLBACK_HTML_URL in
 * views/assets/src-sw.ts), precached at install, possibly before sign-in: it
 * renders whatever session the install request had. It says the page asked
 * for is not on the device and offers the tab roots the worker keeps
 * (OPENS_STALE). The page is precached, so it cannot know which of them
 * this device saved: the links start hidden and connectivity.js reveals
 * those whose page is in the page cache. `data-offline-fallback` makes connectivity.js leave out its
 * "showing saved data" banner, which this page would contradict. A signed-out
 * copy links nothing: every tab would bounce to the login page.
 */
export function OfflinePage({ ctx }: { ctx: ViewContext }) {
  return (
    <PageShell
      ctx={ctx}
      name="offline"
      layout="centred"
      bar={{ title: t('OFFLINE_TITLE') }}
    >
      <div
        class="px-16 gap-2 flex flex-col items-center"
        {...offlineFallback()}
      >
        <OfflineIcon class="size-6 text-error animate-pulse" />
        <h2 class="font-semibold">{t('OFFLINE_NOT_SAVED')}</h2>
        {ctx.user && (
          <>
            <p>{t('OFFLINE_DESC')}</p>
            <ul
              class="flex flex-wrap gap-2 justify-center"
              {...savedPages(PAGES_CACHE)}
            >
              {OPENS_STALE.map((section) => (
                <li hidden>
                  <a href={SECTION_HOME[section]} class="btn">
                    {sectionLabel(section)}
                  </a>
                </li>
              ))}
            </ul>
            <p hidden {...savedPagesNone()}>
              {t('OFFLINE_NONE_SAVED')}
            </p>
          </>
        )}
      </div>
    </PageShell>
  );
}
