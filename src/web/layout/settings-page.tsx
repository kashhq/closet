import type { Child } from 'hono/jsx';
import { SettingsNav } from '../auth/settings-rows';
import { profileSection } from '../auth/urls';
import { t } from '../i18n';
import type { ViewContext } from '../view-context';
import { type PageBodyFrame, PageShell } from './page-shell';

/**
 * A setting's own page under Profile (#728): sharing, weather, the week
 * template, notifications, style, sizes, agent access, devices. A preset of
 * `PageShell` in the `index` layout (D14): from lg `SettingsNav` sits beside
 * it listing its siblings, below lg the page is Profile's child in a narrow
 * column. `section` is the page's row on Profile (`settingsRows`): its back
 * arrow returns to that row (`profileSection`) and the nav marks it current.
 * The title is the page's one h1, and `formPage` marks a page whose native
 * posts land back on it (Back then skips the copies before the save,
 * layout/AGENTS.md).
 */
export function SettingsPage(props: {
  ctx: ViewContext;
  title: string;
  section: string;
  formPage?: boolean;
  /** The body's flow; the default is the settings' 1rem stack. */
  body?: PageBodyFrame;
  /** The page's toasts and sheets (PageShell). */
  overlays?: Child;
  children: Child;
}) {
  const { ctx, title, section } = props;
  return (
    <PageShell
      ctx={ctx}
      name="settings"
      layout="index"
      aside={<SettingsNav ctx={ctx} current={section} />}
      asideLabel={t('profile.SETTINGS')}
      bar={{ title, back: profileSection(section), formPage: props.formPage }}
      body={props.body ?? { gap: 4 }}
      overlays={props.overlays}
    >
      {props.children}
    </PageShell>
  );
}
