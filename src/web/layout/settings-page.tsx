import type { Child } from 'hono/jsx';
import type { ViewContext } from '../view-context';
import { AppBar } from './app-bar';
import { Dock } from './dock';
import { Layout } from './layout';
import { PageMain } from './page-main';

/**
 * A setting's own page under Profile (#728): sharing, weather, the week
 * template, notifications, devices. The title is the page's one h1, the
 * back arrow returns to the setting's row on Profile (`profileSection`),
 * and `formPage` marks a page whose native posts land back on it (Back
 * then skips the copies before the save, layout/AGENTS.md).
 */
export function SettingsPage(props: {
  ctx: ViewContext;
  title: string;
  back: string;
  formPage?: boolean;
  children: Child;
}) {
  const { ctx } = props;
  return (
    <Layout ctx={ctx} title={props.title}>
      <AppBar
        ctx={ctx}
        title={props.title}
        back={props.back}
        formPage={props.formPage}
      />
      <PageMain class="p-4 pt-20 pb-24 flex flex-col gap-4">
        {props.children}
      </PageMain>
      <Dock ctx={ctx} />
    </Layout>
  );
}
