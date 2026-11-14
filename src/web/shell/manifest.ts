import { APP_ICON_SIZES, appIconFile } from '../app-icon';
import { THEME_BASE_100 } from '../theme-colors';
import {
  INSPIRATION_SHARE_PATH,
  SHARE_PHOTO_FIELD,
  SHARED_TEXT_FIELDS,
} from '../inspiration/share-target';
import { LINK_IMPORT_PATH } from '../wardrobe/urls';

/**
 * Android's share sheet (iOS has no share targets). A manifest has one
 * `share_target`, so one target takes both links and photos: a POST
 * (multipart, the only way a file is shared) that the service worker
 * answers on the device and never sends on (receiveShare,
 * src/web/inspiration/share-target.ts): a photo waits for the confirmation
 * page's Save, a link opens the link import, fetching nothing until Fetch.
 * When no worker controls the page, the server's route answers it, writing
 * nothing (share-fallback.ts). Without the worker at all (PWA_ENABLED off)
 * the target stays the link import's GET, links only.
 */
function shareTarget(pwaEnabled: boolean): Record<string, unknown> {
  const params = Object.fromEntries(
    SHARED_TEXT_FIELDS.map((field) => [field, field]),
  );
  if (!pwaEnabled) {
    return { action: LINK_IMPORT_PATH, method: 'GET', params };
  }
  return {
    action: INSPIRATION_SHARE_PATH,
    method: 'POST',
    enctype: 'multipart/form-data',
    params: {
      ...params,
      files: [{ name: SHARE_PHOTO_FIELD, accept: ['image/*'] }],
    },
  };
}

/**
 * The web app manifest, served at GET /manifest.json (routes.tsx). Built
 * from config so the installed PWA's name and icon follow APP_NAME and
 * ICON_NAME; there is no public/manifest.json (the static handler would
 * shadow the route), and the service worker does not precache it.
 */
export function webManifest(config: {
  appName: string;
  iconName: string;
  pwaEnabled: boolean;
}): Record<string, unknown> {
  const { appName, iconName } = config;
  return {
    short_name: appName,
    name: appName,
    // Smallest first: <pwa-install> shows icons[0] (at 48 px) and fetches
    // nothing else. The 1000 px ICON_NAME is left to link previews.
    icons: APP_ICON_SIZES.map((size) => ({
      src: `/assets/${appIconFile(iconName, size)}`,
      sizes: `${size}x${size}`,
      type: 'image/png',
      purpose: 'maskable any',
    })),
    // The app's identity since it was first installed: never changes, or
    // every installed app becomes another one (the Web Install API reads it
    // too). Where it opens can (#15).
    id: '/wardrobe',
    start_url: '/',
    // One value each, so the light theme's page colour: the app bar's
    // (the title bar blends into it) and the splash screen's.
    theme_color: THEME_BASE_100.light,
    background_color: THEME_BASE_100.light,
    display: 'standalone',
    scope: '/',
    shortcuts: [
      {
        name: 'Today',
        short_name: 'Today',
        description: "Today's outfit",
        url: '/',
      },
      {
        name: 'My wardrobe',
        short_name: 'Wardrobe',
        description: 'Browse your clothing items',
        url: '/wardrobe',
      },
      {
        // Styling (#42), the dock's Styling: composing an outfit is the
        // shortcut; Outfits is a tap away in the dock.
        name: 'Style an outfit',
        short_name: 'Styling',
        description: 'Compose an outfit from your wardrobe',
        url: '/styling',
      },
      {
        name: 'Add garment',
        short_name: 'Add garment',
        description: 'Catalog a new clothing item',
        url: '/wardrobe/new',
      },
    ],
    // A shared link arrives in `url`, or inside `text` after the title,
    // depending on the app.
    share_target: shareTarget(config.pwaEnabled),
    description: 'Wardrobe organizer: garments, outfits, and a calendar.',
    // No `screenshots` (issue #4): the install dialogs (the browser's and
    // <pwa-install>) would fetch them for a household whose phones already
    // have the app.
    categories: ['lifestyle', 'utilities'],
  };
}
