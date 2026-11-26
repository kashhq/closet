import { t, tHtml } from '../i18n';
import { PageShell } from '../layout/page-shell';
import type { ViewContext } from '../view-context';

export function AboutPage({ ctx }: { ctx: ViewContext }) {
  const appName = ctx.appName;
  return (
    <PageShell
      ctx={ctx}
      name="about"
      title={t('ABOUT_TITLE')}
      meta={{
        ogTitle: t('ABOUT_OG_TITLE', { appName }),
        ogDescription: t('ABOUT_OG_DESC', { appName }),
      }}
      bar={{ title: t('ABOUT_HEADING', { appName }) }}
    >
      <div class="prose">
        <p class="mb-6">{t('ABOUT_INTRO', { appName })}</p>
        <h2 class="text-xl font-semibold mt-8 mb-3">
          {t('ABOUT_OPEN_SOURCE')}
        </h2>
        {/* The licence and the link to the source: the page's one string
            with markup. */}
        <p
          class="mb-6"
          dangerouslySetInnerHTML={{
            __html: tHtml('ABOUT_OPEN_SOURCE_DESC', { appName }),
          }}
        />
        <h2 class="text-xl font-semibold mt-8 mb-3">{t('ABOUT_NOTICES')}</h2>
        <p class="mb-6">
          {t('ABOUT_NOTICES_DESC', { appName })}{' '}
          {/* A text file, not a page: boosting it would swap plain text into the shell. */}
          <a class="link" href="/THIRD-PARTY-NOTICES.txt" hx-boost="false">
            {t('ABOUT_NOTICES')}
          </a>
        </p>
        <h2 class="text-xl font-semibold mt-8 mb-3">{t('ABOUT_TECH')}</h2>
        <p class="mb-6">{t('ABOUT_TECH_DESC')}</p>
        <p class="text-sm text-muted">
          {t('APP_VERSION')} {ctx.release}
        </p>
      </div>
    </PageShell>
  );
}
