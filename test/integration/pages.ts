import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import { outfit as outfitTable } from '../../src/db/schema';
import { addDays } from '../../src/calendar-date';
import { QUEUEABLE_ROUTES } from '../../src/offline-writes';
import { STATUS_EVENT } from '../../src/web/announce';
import { classOf } from '../../src/web/error-page';
import { REQUEST_FAILED_EVENT } from '../../src/web/errors';
import { t as text } from '../../src/web/i18n';
import {
  createGarment,
  createWishlistItem,
  garmentRow,
  jpegPhoto,
  uploadPhoto,
} from './garments';
import { TestApp, unescapeHtml } from './harness';
import { addLook } from './inspiration';
import { planEntry, takeSelfie } from './selfies';

/**
 * Used by pages.spec.ts: the fixture every page renders against, the route
 * table, and the checks every rendered page must pass.
 */

/** A `lang.KEY` that reached the HTML untranslated. */
const RAW_I18N_KEY = /\blang\.[A-Z_]{3,}/;

export const HX_FRAGMENT = { 'hx-request': 'true' };
export const HX_BOOSTED = { 'hx-request': 'true', 'hx-boosted': 'true' };

export interface PageFixture {
  garmentId: number;
  /** A wishlist item replacing the garment. */
  wishlistId: number;
  garmentShareableId: string;
  capsuleId: number;
  outfitId: number;
  outfitShareableId: string;
  /** The outfit's selfie (#19) of today's entry: Today, the week, the outfit page. */
  selfieFileName: string;
  /** A trip (#10) on now, the outfit on today, packed, with an extra. */
  tripId: number;
  /** A saved look (#22) with a photo. */
  inspirationId: number;
}

/**
 * One garment with a photo, a capsule holding it and one outfit wearing it,
 * worn today with a selfie, created through the same requests the UI makes,
 * so detail, edit, clone and share pages have something real to render.
 */
export async function createPageFixture(
  t: TestApp,
  cookie?: string,
): Promise<PageFixture> {
  const headers = cookie ? { cookie } : {};
  const garmentId = await createGarment(t, {
    name: 'Black Linen Blazer',
    category: 'shirt',
    cookie,
  });
  await uploadPhoto(t, garmentId, await jpegPhoto(), cookie);
  const wishlistId = await createWishlistItem(t, {
    name: 'Charcoal Linen Blazer',
    category: 'shirt',
    replaces: garmentId,
    price: '120',
    sourceUrl: 'https://shop.example/blazer',
    cookie,
  });

  const capsule = await t.inject({
    method: 'POST',
    url: '/capsules',
    payload: { name: 'Office' },
    headers,
  });
  expect(capsule.statusCode).toBe(303);
  const capsuleId = Number(
    /^\/capsules\/(\d+)\?/.exec(capsule.headers.location as string)?.[1],
  );
  const chosen = await t.inject({
    method: 'POST',
    url: `/capsules/${capsuleId}/garments`,
    payload: { ids: [garmentId] },
    headers,
  });
  expect(chosen.statusCode).toBe(303);

  const res = await t.inject({
    method: 'POST',
    url: '/outfits',
    payload: {
      name: 'Office look',
      category: 'shirt',
      garmentId: String(garmentId),
    },
    headers,
  });
  expect(res.statusCode).toBe(302);
  const match = /^\/outfits\/(\d+)$/.exec(res.headers.location as string);
  if (!match) {
    throw new Error(`Unexpected outfit redirect: ${res.headers.location}`);
  }
  const outfitId = Number(match[1]);
  const { fileName: selfieFileName } = await takeSelfie(
    t,
    await planEntry(t, outfitId, t.today(), cookie),
    cookie,
  );

  const today = t.today();
  const trip = await t.inject({
    method: 'POST',
    url: '/trips',
    payload: {
      name: 'Lisbon',
      destination: 'Lisbon',
      startsOn: today,
      endsOn: addDays(today, 2),
    },
    headers,
  });
  expect(trip.statusCode).toBe(303);
  const tripId = Number(
    /^\/trips\/(\d+)\?/.exec(trip.headers.location as string)?.[1],
  );
  for (const [url, payload] of [
    [`/trips/${tripId}/outfits`, { outfitId: String(outfitId), day: today }],
    [`/trips/${tripId}/items`, { label: 'Charger' }],
    [`/trips/${tripId}/packed`, { packed: String(garmentId) }],
  ] as const) {
    const res = await t.inject({ method: 'POST', url, payload, headers });
    expect(res.statusCode, url).toBe(303);
  }

  const look = await addLook(t, await jpegPhoto(), cookie);
  // A piece read in it (#22b), so the look's page draws a piece's form.
  const tagged = await t.inject({
    method: 'POST',
    url: `/inspiration/${look.id}/pieces`,
    payload: { kind: 'top/t-shirt', color: 'white', accent: '', pattern: '' },
    headers,
  });
  expect(tagged.statusCode).toBe(303);

  // A public link exists only once Share is tapped (#669).
  for (const url of [
    `/wardrobe/${garmentId}/share`,
    `/outfits/${outfitId}/share`,
  ]) {
    const res = await t.inject({ method: 'POST', url, headers });
    expect(res.statusCode, url).toBe(200);
  }
  const garment = (await garmentRow(t, garmentId))!;
  const [outfit] = await t.db
    .select({ shareableId: outfitTable.shareableId })
    .from(outfitTable)
    .where(eq(outfitTable.id, outfitId));
  if (!garment.shareableId || !outfit.shareableId) {
    throw new Error('Share left the fixture without a public link');
  }
  return {
    garmentId,
    wishlistId,
    garmentShareableId: garment.shareableId,
    capsuleId,
    outfitId,
    outfitShareableId: outfit.shareableId,
    selfieFileName,
    tripId,
    inspirationId: look.id,
  };
}

export interface PageRoute {
  url: string;
  /** `config: { public: true }`: renders for an anonymous visitor too, instead of a login redirect. */
  public: boolean;
  /**
   * An add or edit page, which its save is done with: its app bar says so
   * (`AppBar formPage`, `data-form-page`), and the back arrow of the page
   * the save lands on skips it (public/js/back.js). `expectFormPageFlag`.
   */
  formPage: boolean;
}

/**
 * Every GET route that renders a full page; all render for a signed-in user.
 * A new add or edit page is listed with `form`, so a page that forgets its
 * `formPage` fails, as does a page that claims it wrongly.
 */
export function pageRoutes(f: PageFixture, inviteToken: string): PageRoute[] {
  const app = (url: string): PageRoute => ({
    url,
    public: false,
    formPage: false,
  });
  const form = (url: string): PageRoute => ({
    url,
    public: false,
    formPage: true,
  });
  const open = (url: string): PageRoute => ({
    url,
    public: true,
    formPage: false,
  });
  return [
    app('/'),
    app('/wardrobe'),
    app('/wardrobe?archived=true'),
    form('/wardrobe/new'),
    app(`/wardrobe/${f.garmentId}`),
    form(`/wardrobe/${f.garmentId}/edit`),
    form(`/wardrobe/${f.garmentId}/clone`),
    app('/wardrobe/tag'),
    app(`/wardrobe?capsule=${f.capsuleId}`),
    app(`/wardrobe?pick=${f.capsuleId}`),
    app('/wardrobe/wishlist'),
    form('/wardrobe/new?to=wishlist'),
    form(`/wardrobe/new?to=wishlist&replaces=${f.garmentId}`),
    form('/wardrobe/new/from-link?to=wishlist'),
    app(`/wardrobe/${f.wishlistId}`),
    form(`/wardrobe/${f.wishlistId}/edit`),
    form(`/wardrobe/${f.wishlistId}/bought`),
    app('/capsules'),
    form('/capsules/new'),
    app(`/capsules/${f.capsuleId}`),
    form(`/capsules/${f.capsuleId}/edit`),
    app('/outfits'),
    app('/outfits?for=day:2030-10-09&occasion=evening'),
    form('/styling'),
    form(`/styling?capsule=${f.capsuleId}`),
    form(`/styling?with=${f.garmentId}`),
    form(`/styling?outfit=${f.outfitId}&returnTo=%2Fcalendar`),
    app(`/outfits/${f.outfitId}`),
    app('/calendar'),
    app('/calendar/month'),
    app('/calendar/month?month=2030-10'),
    app('/calendar/plan?for=day:2030-10-09&occasion=evening'),
    form('/styling?for=day:2030-10-09&occasion=evening'),
    form(`/styling?for=trip:${f.tripId}`),
    app('/outfits/ideas'),
    app('/inspiration'),
    form('/inspiration/new'),
    form('/inspiration/share/confirm'),
    app(`/inspiration/${f.inspirationId}`),
    app(`/inspiration/${f.inspirationId}?unread=blocked-by-site`),
    app(`/inspiration/${f.inspirationId}/recreate`),
    app('/outfits/ideas?for=day:2030-10-09&occasion=evening'),
    app(`/outfits/ideas?capsule=${f.capsuleId}&with=${f.garmentId}`),
    app('/trips'),
    form('/trips/new'),
    app(`/trips/${f.tripId}`),
    form(`/trips/${f.tripId}/edit`),
    form(`/trips/${f.tripId}/outfits/new`),
    form(`/trips/${f.tripId}/outfits/new?day=2030-10-09&occasion=evening`),
    app(`/outfits/ideas?for=trip:${f.tripId}`),
    app('/wardrobe/insights'),
    app('/wardrobe/insights?unworn=30'),
    app('/wardrobe/recap'),
    app('/wardrobe/recap?year=2025'),
    app('/auth/profile'),
    form('/auth/profile/style'),
    form('/auth/profile/sizes'),
    app('/auth/update-email'),
    app('/auth/delete-account'),
    app('/auth/change-password'),
    app('/auth/sign-out-everywhere'),
    form('/auth/tokens'),
    // Public, but a signed-out visitor is sent to log in like any app page.
    app('/auth/logout'),
    open('/about'),
    open('/offline.html'),
    open('/auth/login'),
    open('/auth/register'),
    open(`/wardrobe-share/invite/${inviteToken}`),
    open(`/share?shareableId=${f.garmentShareableId}&type=garment`),
    open(`/share?shareableId=${f.outfitShareableId}&type=outfit`),
  ];
}

/** The app bar marks exactly the pages `pageRoutes` lists as form pages. */
export function expectFormPageFlag(
  route: PageRoute,
  res: LightMyRequestResponse,
): void {
  const header = /<header class="app-bar\b[^>]*>/.exec(res.body)?.[0] ?? '';
  expect({
    url: route.url,
    formPage: header.includes('data-form-page'),
  }).toEqual({ url: route.url, formPage: route.formPage });
}

/**
 * An add or edit page's writes are disabled offline (#411, `FormPage`): its
 * native post to `action` and any `hx-delete` carry `data-needs-network`,
 * which public/js/connectivity.js disables while the heartbeat fails. A
 * cached copy posting without a connection lands on the worker's offline
 * page and loses what was typed.
 */
export function expectOfflineGuarded(
  res: LightMyRequestResponse,
  action: string,
): void {
  const forms = Array.from(
    res.body.matchAll(/<form method="post"[^>]*>/g),
    ([form]) => form,
  ).filter((form) => form.includes(`action="${action}"`));
  expect(forms, action).toHaveLength(1);
  expect(forms[0]).toContain('data-needs-network=""');
  for (const remove of res.body.match(/<button[^>]*hx-delete=[^>]*>/g) ?? []) {
    expect(remove).toContain('data-needs-network=""');
  }
}

export function expectNoRawI18nKeys(res: LightMyRequestResponse): void {
  expect(res.body).not.toMatch(RAW_I18N_KEY);
}

/** A whole document: layout, exactly one htmx config, every string translated. */
export function expectFullPage(res: LightMyRequestResponse): void {
  expect(res.headers['content-type']).toMatch(/^text\/html/);
  expect(res.body).toMatch(/^<!DOCTYPE html>/i);
  // htmx reads only the first htmx-config meta (AGENTS.md Gotchas).
  expect(res.body.match(/<meta\s+name="htmx-config"/g)).toHaveLength(1);
  expectNoRawI18nKeys(res);
  expectNativePostForms(res);
  expectPostFormsOfflineGuarded(res);
  expect(misannouncedSessionForms(res.body)).toEqual([]);
  expectAutosaveControls(res);
  expectInPlaceWritesKeepFocus(res);
  expectOneStatusRegion(res);
  expectNoScriptNavigation(res);
  expectAppBar(res);
  // _hyperscript left the app (2026-09-26): an `_=` attribute would do
  // nothing at all.
  expect(res.body).not.toMatch(/\s_="/);
  expect(res.body).not.toContain('_hyperscript');
}

/**
 * Every page has the one app bar (src/web/layout/app-bar.tsx) and its title
 * is the page's only h1; signed in, the avatar opens Profile, signed out
 * the bar offers a way in. The drawer is gone (#82).
 */
export function expectAppBar(res: LightMyRequestResponse): void {
  const body = res.body;
  expect(body.match(/<header class="app-bar\b/g)).toHaveLength(1);
  expect(body.match(/<h1\b/g)).toHaveLength(1);
  expect(body).not.toContain('drawer-toggle');
  if (res.headers['x-page-account']) {
    expect(body.match(/<a href="\/auth\/profile" id="avatar"/g)).toHaveLength(
      1,
    );
  } else {
    // A link in (carrying the page to return to, #661), or on the login
    // page its own form.
    expect(body).toMatch(
      /(?:href|action)="\/auth\/(?:login|register)(?:\?returnTo=[^"]+)?"/,
    );
  }
}

/** The app bar's title, the page's h1, as text. */
export function pageTitle(body: string): string | undefined {
  return /<h1\b[^>]*>([^<]*)<\/h1>/.exec(body)?.[1];
}

/**
 * Navigation is a link or an htmx request, never script setting the
 * location: that is a full document load, which re-runs every shell script
 * and the service worker update check, and races a boosted click on a link
 * inside the element (client audit H4).
 */
export function expectNoScriptNavigation(res: LightMyRequestResponse): void {
  expect(res.body).not.toMatch(/\blocation(\.href)?\s*=/);
}

/**
 * The layout boosts every form, and htmx drops a boosted 4xx: a refused
 * native post would do nothing on screen (the boosted registration form is
 * how the owner lost their password). Every `<form method="post">` must opt
 * out with hx-boost="false"; forms that post through htmx (hx-post) handle
 * their own responses and are not native posts.
 */
export function expectNativePostForms(res: LightMyRequestResponse): void {
  const offenders = (res.body.match(/<form\b[^>]*>/gi) ?? []).filter(
    (tag) =>
      /\bmethod=["']?post\b/i.test(tag) &&
      !/\bhx-post=/i.test(tag) &&
      !/\bhx-boost=["']?false\b/i.test(tag),
  );
  expect(offenders).toEqual([]);
}

/**
 * The posts that change whose session this device has. The service worker
 * never sees them (#542), so each form says so itself (`PostForm`
 * `endsSession`, `data-ends-session`): public/js/pwa.js tells the worker as
 * it posts, and the worker drops the session caches before the landing
 * page. One missing the mark leaves the previous account's pages cached.
 */
export const SESSION_BOUNDARY_ACTIONS = [
  '/auth/login',
  '/auth/register',
  '/auth/logout',
  '/auth/delete-account',
];

/** The page's forms posting a sign-in or sign-out without the mark, or the mark on another. */
export function misannouncedSessionForms(html: string): string[] {
  return (html.match(/<form\b[^>]*>/gi) ?? []).filter((tag) => {
    const action = /\baction="([^"]*)"/.exec(tag)?.[1] ?? '';
    const marked = /\bdata-ends-session=/.test(tag);
    return marked !== SESSION_BOUNDARY_ACTIONS.includes(action);
  });
}

/** A form the outbox queues offline, of a kind it replays. */
const QUEUED_FORM = new RegExp(
  `\\bdata-offline-queue="(?:${Object.keys(QUEUEABLE_ROUTES).join('|')})"`,
);

/**
 * The `PostForm`s (marked by their `data-submit-once`) a page renders that
 * would post while offline: neither `data-needs-network`, which
 * public/js/connectivity.js disables offline with every control that
 * submits the form, nor an `allowOffline` reason (`data-allow-offline`),
 * nor a write the outbox queues (`data-offline-queue`, #178).
 * Disabled is the default (#411; owner, 2026-10-22): a cached form posting
 * without a connection lands on the worker's offline page and loses what was
 * typed. Read per page, so a new form is checked by the page rendering it.
 */
export function offlineUnguardedPostForms(html: string): string[] {
  return (html.match(/<form\b[^>]*>/gi) ?? []).filter(
    (tag) =>
      /\bdata-submit-once=/.test(tag) &&
      !/\bdata-needs-network=/.test(tag) &&
      !/\bdata-allow-offline="[^"]+"/.test(tag) &&
      !QUEUED_FORM.test(tag),
  );
}

function expectPostFormsOfflineGuarded(res: LightMyRequestResponse): void {
  expect(offlineUnguardedPostForms(res.body)).toEqual([]);
}

/**
 * Every control that posts on `change` is built by src/web/autosave.tsx
 * (`AutosaveForm`, `autosaveAttributes`): queued per form, latest last, and
 * marked for public/js/autosave.js, which drops answers a newer edit
 * overtook. One built by hand loses quick edits (found on #62). The auth
 * forms' inline check is exempt: it swaps nothing of its own
 * (`hx-swap="none"`, messages out of band), so it cannot redraw a field.
 */
export function expectAutosaveControls(res: LightMyRequestResponse): void {
  const offenders = (res.body.match(/<[a-z-]+\b[^>]*>/gi) ?? []).filter(
    (tag) =>
      /\bhx-post=/i.test(tag) &&
      /\bhx-trigger="[^"]*\bchange\b/i.test(tag) &&
      !/\bhx-swap="none"/i.test(tag) &&
      !(
        /\bhx-sync="closest form:queue last"/i.test(tag) &&
        /\bdata-autosave=""/i.test(tag)
      ),
  );
  expect(offenders).toEqual([]);
}

/**
 * The page's one polite status region (#679, `#toast-host` in AppStatus,
 * src/web/layout/app-status.tsx), where every toast lands
 * (public/js/toast.js). One per page, and never in a fragment
 * (expectFragment): a swap that brought one would replace it, and a region
 * inserted with its message is not reliably read.
 */
export function expectOneStatusRegion(res: LightMyRequestResponse): void {
  const regions = res.body.match(/<div\b[^>]*\bid="toast-host"[^>]*>/g);
  expect(regions).toHaveLength(1);
  expect(regions![0]).toContain('role="status"');
  expect(regions![0]).toContain('aria-live="polite"');
  // The same node across boosted navigations (public/js/toast.js).
  expect(regions![0]).toContain('hx-preserve');
}

/**
 * A write swapped in place keeps keyboard focus (#679): htmx gives focus
 * back to the element with the focused one's id, so every submit button of
 * an in-place queued write (an `hx-post` form the outbox queues: Wore today,
 * Washed, the calendar's worn pill) carries an id, the same in each of its
 * states. Autosave forms are AutosaveForm's (expectAutosaveControls). The
 * answer says what it did through expectStatusMessage.
 */
export function expectInPlaceWritesKeepFocus(
  res: LightMyRequestResponse,
): void {
  const forms = (
    res.body.match(/<form\b[^>]*\bhx-post=[^>]*>[\s\S]*?<\/form>/g) ?? []
  ).filter((form) => {
    const tag = /^<form\b[^>]*>/.exec(form)![0];
    return /\bdata-offline-queue=/.test(tag) && !/\bdata-autosave=/.test(tag);
  });
  const offenders = forms
    .flatMap((form) => form.match(/<button\b[^>]*>/g) ?? [])
    .filter((button) => !/\bid="[^"]+"/.test(button));
  expect(offenders).toEqual([]);
}

/**
 * How an htmx write's answer says what it did (#679, `announce`,
 * src/web/announce.ts): the STATUS_EVENT `HX-Trigger` public/js/toast.js
 * puts in the status region.
 */
export function expectStatusMessage(
  res: LightMyRequestResponse,
  message: string,
): void {
  const trigger = res.headers['hx-trigger'];
  expect(typeof trigger).toBe('string');
  expect(JSON.parse(String(trigger))).toEqual({
    [STATUS_EVENT]: { message },
  });
}

/**
 * An htmx swap target: no layout around it. Status is the caller's to
 * check.
 */
export function expectFragment(res: LightMyRequestResponse): void {
  expect(res.headers['content-type']).toMatch(/^text\/html/);
  expect(res.body).not.toMatch(/<html\b/i);
  expect(res.body).not.toContain('htmx-config');
  expect(res.body).not.toContain('id="toast-host"');
  expect(res.body.trim().length).toBeGreaterThan(0);
  expectNoRawI18nKeys(res);
}

/**
 * How an htmx fragment request's failure answers (#642, the root error
 * handler, src/web/errors.tsx): its status, no body, and the failure as an
 * `HX-Trigger` event carrying the message people read and the reply's own
 * request id, which public/js/request-failures.js toasts.
 */
export function expectFailureTrigger(
  res: LightMyRequestResponse,
  status: number,
  message: string | RegExp,
): void {
  expect(res.statusCode, res.body).toBe(status);
  expect(res.body).toBe('');
  const trigger = res.headers['hx-trigger'];
  expect(typeof trigger).toBe('string');
  expect(JSON.parse(String(trigger))).toEqual({
    [REQUEST_FAILED_EVENT]: {
      message:
        typeof message === 'string' ? message : expect.stringMatching(message),
      requestId: res.headers['x-request-id'],
    },
  });
}

/** A boosted tap's (or a navigation's) failure: the error page, whole. */
export function expectErrorPage(
  res: LightMyRequestResponse,
  status: number,
  message: string,
): void {
  expect(res.statusCode).toBe(status);
  expect(res.headers['hx-trigger']).toBeUndefined();
  expectFullPage(res);
  expect(pageTitle(res.body)).toBe(text(`errorPage.title.${classOf(status)}`));
  expect(unescapeHtml(res.body)).toContain(message);
  // Only a 5xx shows the id (#644); the header carries it on every answer.
  expect(res.body.includes(String(res.headers['x-request-id']))).toBe(
    status >= 500,
  );
}
