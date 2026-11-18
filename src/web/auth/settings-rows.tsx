import { type StringKey, t } from '../i18n';
import { PUSH_SETTINGS_ID, PUSH_SETTINGS_PATH } from '../push/urls';
import { SHARING_PATH, SHARING_SECTION_ID } from '../sharing/urls';
import { SIZES_PATH, SIZES_SECTION_ID } from '../sizes/urls';
import { STYLE_PROFILE_PATH } from '../style/urls';
import type { ViewContext } from '../view-context';
import { WEATHER_SETTINGS_ID, WEATHER_SETTINGS_PATH } from '../weather/urls';
import { WEEK_SETTINGS_ID, WEEK_SETTINGS_PATH } from '../week-plan/urls';
import {
  AGENT_ACCESS_SECTION_ID,
  DEVICES_PATH,
  DEVICES_SECTION_ID,
  STYLE_SECTION_ID,
  TOKENS_PATH,
} from './urls';

/** One setting under Profile: the id its row keeps (`/auth/profile#<id>`), its page and its name. */
interface SettingsRowDefinition {
  id: string;
  href: string;
  label: StringKey;
  when?: (ctx: ViewContext) => boolean;
}

/**
 * Profile's settings, in the order Profile lists them: the one list behind
 * both the index (`ProfilePage`, a row with a summary each) and the nav
 * beside every setting's page (`SettingsNav`, labels only), so a new setting
 * is added once. A row with a `when` exists only under that condition, which
 * reads the deployment's config and never a row of data: the nav is on every
 * settings page and reads nothing, so Profile and the nav always agree.
 */
const SETTINGS_ROWS = [
  { id: SHARING_SECTION_ID, href: SHARING_PATH, label: 'WARDROBE_SHARING' },
  {
    // Web Push needs the service worker, which only PWA_ENABLED serves.
    id: PUSH_SETTINGS_ID,
    href: PUSH_SETTINGS_PATH,
    label: 'PUSH_HEADING',
    when: (ctx) => ctx.pwaEnabled,
  },
  {
    id: WEATHER_SETTINGS_ID,
    href: WEATHER_SETTINGS_PATH,
    label: 'weather.SETTINGS_HEADING',
    when: (ctx) => ctx.weatherEnabled,
  },
  {
    id: WEEK_SETTINGS_ID,
    href: WEEK_SETTINGS_PATH,
    label: 'weekPlan.template.HEADING',
  },
  { id: STYLE_SECTION_ID, href: STYLE_PROFILE_PATH, label: 'style.TITLE' },
  { id: SIZES_SECTION_ID, href: SIZES_PATH, label: 'sizes.TITLE' },
  {
    id: AGENT_ACCESS_SECTION_ID,
    href: TOKENS_PATH,
    label: 'agentAccess.TITLE',
  },
  { id: DEVICES_SECTION_ID, href: DEVICES_PATH, label: 'devices.TITLE' },
] as const satisfies readonly SettingsRowDefinition[];

/** The ids, as literals: a table keyed by them (Profile's summaries) must cover every row. */
export type SettingsRowId = (typeof SETTINGS_ROWS)[number]['id'];

/** A setting a user or deployment may have: what Profile and the nav render of it. */
export interface SettingsRowSpec {
  id: SettingsRowId;
  href: string;
  label: StringKey;
}

/** The settings that exist for this deployment and account. */
export function settingsRows(ctx: ViewContext): SettingsRowSpec[] {
  return SETTINGS_ROWS.filter(
    (row: SettingsRowDefinition) => row.when?.(ctx) ?? true,
  );
}

/**
 * The settings' siblings, beside a setting's page from lg (the `index`
 * layout's aside, a `<nav aria-label>` its shell renders): Profile's rows as
 * labels only, the page's own `aria-current`. It reads nothing, so it lists
 * exactly what `settingsRows` gives Profile.
 */
export function SettingsNav(props: { ctx: ViewContext; current: string }) {
  const rows = settingsRows(props.ctx);
  return (
    <ul class="menu w-full p-0">
      {rows.map((row) => (
        <li>
          <a
            href={row.href}
            class={row.id === props.current ? 'menu-active' : undefined}
            aria-current={row.id === props.current ? 'page' : undefined}
          >
            {t(row.label)}
          </a>
        </li>
      ))}
    </ul>
  );
}
