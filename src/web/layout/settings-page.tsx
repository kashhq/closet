import type { Child } from 'hono/jsx';
import type { ViewContext } from '../view-context';
import { PageShell } from './page-shell';

/**
 * A setting's own page under Profile (#728): sharing, weather, the week
 * template, notifications, devices. A preset of `PageShell`: `single` and
 * narrow today; D14 of the desktop plan gives it the `index` layout, whose
 * frame width is main.css's, so this preset then drops `width`. The title
 * is the page's one h1, the back arrow returns to the setting's row on
 * Profile (`profileSection`), and `formPage` marks a page whose native
 * posts land back on it (Back then skips the copies before the save,
 * layout/AGENTS.md).
 */
export function SettingsPage(props: {
  ctx: ViewContext;
  title: string;
  back: string;
  formPage?: boolean;
  children: Child;
}) {
  const { title } = props;
  return (
    <PageShell
      ctx={props.ctx}
      name="settings"
      layout="single"
      width="narrow"
      bar={{ title, back: props.back, formPage: props.formPage }}
      body={{ gap: 4 }}
    >
      {props.children}
    </PageShell>
  );
}
