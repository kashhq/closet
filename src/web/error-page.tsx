import { t } from './i18n';
import { sectionLabel } from './layout/dock';
import { PageShell } from './layout/page-shell';
import { EmptyState } from './layout/parts';
import { SECTION_HOME, sectionOf } from './layout/sections';
import type { ViewContext } from './view-context';

export type ErrorClass =
  | 'missing'
  | 'refused'
  | 'retry'
  | 'rejected'
  | 'failed';

/**
 * The shape of the page by what the person can do about it: a place that is
 * not there (404, 410), one they may not open (403), a moment that will pass
 * (409, 412, 429, 503: Try again), a request that must change (the other
 * 4xx), and our failure (the other 5xx).
 */
export function classOf(status: number): ErrorClass {
  if (status === 404 || status === 410) return 'missing';
  if (status === 403) return 'refused';
  if ([409, 412, 429, 503].includes(status)) return 'retry';
  return status < 500 ? 'rejected' : 'failed';
}

/**
 * The error page (#644): a sentence, then the way on. Back goes back in
 * history like the app bar's arrow (`data-history-back`, public/js/back.js;
 * its href is the cold-entry fallback), and the section's home link is the
 * way in when there is nothing to go back to. "Try again" is the request's
 * own GET URL (`retryHref`, chosen by the error handler: absent for a write
 * or a secret path). Only a 5xx shows the request id, as the one line a
 * report quotes.
 */
export function ErrorPage(props: {
  ctx: ViewContext;
  status: number;
  message: string;
  /** The request's path, for the section its home link names. */
  path: string;
  retryHref?: string;
  requestId: string;
}) {
  const kind = classOf(props.status);
  const section = sectionOf(props.path);
  const home =
    section === undefined || section === 'today'
      ? { href: SECTION_HOME.today, label: t('RETURN_TO_HOME') }
      : {
          href: SECTION_HOME[section],
          label: t('errorPage.OPEN_SECTION', {
            section: sectionLabel(section),
          }),
        };
  return (
    <PageShell ctx={props.ctx} bar={{ title: t(`errorPage.title.${kind}`) }}>
      <EmptyState message={props.message}>
        <div class="flex flex-wrap justify-center gap-2">
          {props.retryHref !== undefined && kind === 'retry' && (
            <a href={props.retryHref} class="btn btn-primary">
              {t('errorPage.TRY_AGAIN')}
            </a>
          )}
          <a href={home.href} class="btn btn-ghost" data-history-back="">
            {t('BACK')}
          </a>
          <a href={home.href} class="btn btn-outline">
            {home.label}
          </a>
        </div>
        {props.status >= 500 && (
          <p class="text-xs text-muted select-all">
            {t('REQUEST_ID')}: {props.requestId}
          </p>
        )}
      </EmptyState>
    </PageShell>
  );
}
