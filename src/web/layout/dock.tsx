import type { Child } from 'hono/jsx';
import { PROFILE_PATH } from '../auth/urls';
import { t } from '../i18n';
import type { ViewContext } from '../view-context';
import { onProfile, ProfileAvatar } from './app-bar';
import { HANGER_PATHS } from './parts';
import { DOCK_TABS, type Section, SECTION_HOME, sectionOf } from './sections';

/**
 * Bottom navigation (daisyUI dock): a tab per section in DOCK_TABS
 * (sections.ts). A tab is active on every page of its section, so a
 * garment, a filtered grid, a capsule or an outfit page keeps its tab lit.
 * Rendered by the server into the body, so a boosted navigation, an htmx
 * history restore and the service worker's cached tab roots all carry the
 * dock of the page they show. Signed out it renders nothing: every tab
 * would bounce to the login page, so the one rule lives here and every
 * signed-out page (sign in, register, the 404) inherits it. Its z-index (above page content) and its
 * restyling as a left rail at lg (one markup, CSS only) are in main.css.
 * The rail carries every place (docs/plans/2026-11-16-desktop-layout.md
 * §3.1, owner decision 1), so from lg Profile is its last link, at its
 * foot, and the app bar's avatar (a phone's way there) hides.
 */
export function Dock({ ctx }: { ctx: ViewContext }) {
  if (!ctx.user) return null;
  const active = sectionOf(ctx.path);
  const profile = onProfile(ctx.path);
  return (
    <nav class="dock" aria-label={t('NAV_MAIN')}>
      {DOCK_TABS.map((section) => (
        <DockLink
          active={active === section}
          href={SECTION_HOME[section]}
          label={TABS[section].label()}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke-width="1.5"
            stroke="currentColor"
            class="size-6"
          >
            {TABS[section].icon}
          </svg>
        </DockLink>
      ))}
      <DockLink
        active={profile}
        href={PROFILE_PATH}
        label={t('PROFILE')}
        class="hidden lg:flex mt-auto"
      >
        <ProfileAvatar email={ctx.user.email} current={profile} />
      </DockLink>
    </nav>
  );
}

/** A section's name as the dock shows it (the error page's link home). */
export function sectionLabel(section: Section): string {
  return TABS[section].label();
}

/** Each tab's label (read at render, from the catalog) and its icon's SVG paths. */
const TABS: Readonly<Record<Section, { label: () => string; icon: Child }>> = {
  today: {
    label: () => t('today.TITLE'),
    // Heroicons' sun, outline.
    icon: (
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"
      />
    ),
  },
  wardrobe: {
    label: () => t('WARDROBE'),
    // The hanger HangerIcon draws for a garment too.
    icon: HANGER_PATHS,
  },
  styling: {
    label: () => t('styling.DOCK'),
    // Heroicons' sparkles, outline.
    icon: (
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z"
      />
    ),
  },
  outfits: {
    label: () => t('OUTFITS'),
    icon: (
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12"
      />
    ),
  },
  calendar: {
    label: () => t('CALENDAR'),
    icon: (
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5m-9-6h.008v.008H12v-.008ZM12 15h.008v.008H12V15Zm0 2.25h.008v.008H12v-.008ZM9.75 15h.008v.008H9.75V15Zm0 2.25h.008v.008H9.75v-.008ZM7.5 15h.008v.008H7.5V15Zm0 2.25h.008v.008H7.5v-.008Zm6.75-4.5h.008v.008h-.008v-.008Zm0 2.25h.008v.008h-.008V15Zm0 2.25h.008v.008h-.008v-.008Zm2.25-4.5h.008v.008H16.5v-.008Zm0 2.25h.008v.008H16.5V15Z"
      />
    ),
  },
};

function DockLink(props: {
  /** The link leads to the page on screen's section (or Profile). */
  active: boolean;
  href: string;
  label: string;
  /** Profile's: shown only as the rail, at its foot. */
  class?: string;
  /** The icon. */
  children: Child;
}) {
  const classes = [props.active && 'dock-active', props.class]
    .filter(Boolean)
    .join(' ');
  return (
    <a
      class={classes || undefined}
      aria-current={props.active ? 'page' : undefined}
      href={props.href}
    >
      {props.children}
      <span class="dock-label">{props.label}</span>
    </a>
  );
}
