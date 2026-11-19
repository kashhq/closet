/**
 * Web Push, page side (the worker's side is the push and notificationclick
 * handlers in views/assets/src-sw.ts). Script because the Push API is
 * imperative: permission, PushManager, the VAPID key as bytes. Imported by
 * pwa.ts on signed-in pages (the layout marks them `data-signed-in` on
 * <html>: the session cookie is httpOnly, so the server's word is the only
 * way to know).
 *
 *  - syncSubscription(): once per document, sends this browser's existing
 *    subscription to the server, which upserts it by endpoint. That keeps
 *    the row's keys current and moves it to whoever is signed in here now.
 *  - <push-settings> (the profile page, src/web/push/settings.tsx): shows
 *    this browser's state and turns notifications on or off. The permission
 *    prompt only comes from a tap on its enable button: browsers penalize
 *    prompts without a gesture, and iOS refuses them. Once on, it asks for
 *    this device's reminders (#15): only the browser knows which device it
 *    is (its subscription's endpoint), so it posts that and htmx swaps the
 *    server's form into the slot.
 *  - <push-endpoint> (the change-password form) names this device, so the
 *    new password keeps its subscription; <push-signed-out> (the login page
 *    shown signed out) drops the browser's subscription. pwa.ts also imports
 *    this module on a signed-out page that carries <push-signed-out>.
 */
import {
  PUSH_ACTION,
  PUSH_REMINDERS_ID,
  PUSH_SHOW,
  type PushAction,
  type PushState,
} from '../../../src/web/page-contract';

const SUBSCRIBE_URL = '/push/subscribe';
const REMINDERS_FORM_URL = '/push/reminders/form';
const UNSUBSCRIBE_URL = '/push/unsubscribe';
const PUBLIC_KEY_URL = '/push/vapid-public-key';

function pushSupported() {
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
}

async function fetchPublicKey() {
  const response = await fetch(PUBLIC_KEY_URL);
  if (!response.ok) {
    throw new Error(`${PUBLIC_KEY_URL} answered ${response.status}`);
  }
  return base64UrlToBytes((await response.text()).trim());
}

function base64UrlToBytes(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

let synced: Promise<PushSubscription | null> | undefined;

/**
 * This browser's subscription once the server has it, or null when there is
 * none (or permission is not granted). Runs once per document; a failure is
 * not remembered, so the next caller tries again.
 */
export function syncSubscription(): Promise<PushSubscription | null> {
  synced ??= (async () => {
    if (!pushSupported() || Notification.permission !== 'granted') return null;
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await postJson(SUBSCRIBE_URL, subscription.toJSON());
      console.info('[push] subscription confirmed with the server');
    }
    return subscription;
  })().catch((error: unknown) => {
    synced = undefined;
    throw error;
  });
  return synced;
}

class PushSettingsElement extends HTMLElement {
  /** Prepared before any tap, so enabling awaits nothing before subscribe(). */
  #registration: ServiceWorkerRegistration | null = null;
  #publicKey: Uint8Array<ArrayBuffer> | null = null;

  connectedCallback() {
    this.addEventListener('click', this);
    void this.#refresh();
  }

  disconnectedCallback() {
    this.removeEventListener('click', this);
  }

  handleEvent(event: Event) {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>(`[${PUSH_ACTION}]`);
    if (!button || button.disabled) return;
    const action = button.getAttribute(PUSH_ACTION) as PushAction;
    if (action === 'enable') void this.#run(() => this.#enable());
    if (action === 'disable') void this.#run(() => this.#disable());
  }

  #show(state: PushState) {
    this.dataset.state = state;
    for (const element of this.querySelectorAll<HTMLElement>(
      `[${PUSH_SHOW}]`,
    )) {
      element.hidden = !(element.getAttribute(PUSH_SHOW) ?? '')
        .split(' ')
        .includes(state);
    }
  }

  async #refresh() {
    try {
      this.#showState(await this.#currentState());
    } catch (error) {
      console.warn('[push] could not read this device state', error);
      this.#show('error');
    }
  }

  #showState(state: PushState) {
    this.#show(state);
    if (state === 'on') void this.#loadReminders();
  }

  // This device's reminders, from the server, into their slot (the form it
  // answers keeps the slot's id, so a later load replaces it again).
  async #loadReminders() {
    const slot = this.querySelector(`#${PUSH_REMINDERS_ID}`);
    try {
      const subscription = await syncSubscription();
      if (!slot || !subscription) return;
      await window.htmx.ajax('POST', REMINDERS_FORM_URL, {
        target: slot,
        swap: 'outerHTML',
        values: { endpoint: subscription.endpoint },
      });
    } catch (error) {
      console.warn('[push] could not load this device reminders', error);
    }
  }

  async #currentState(): Promise<PushState> {
    if (!pushSupported()) {
      // iOS and iPadOS have push only in the Home Screen app;
      // navigator.standalone exists only there, false in a Safari tab.
      return navigator.standalone === false ? 'install' : 'unsupported';
    }
    if (Notification.permission === 'denied') return 'blocked';
    if (await syncSubscription()) return 'on';
    await this.#prepare();
    return 'off';
  }

  async #prepare() {
    this.#registration ??= await navigator.serviceWorker.ready;
    this.#publicKey ??= await fetchPublicKey();
    return { registration: this.#registration, publicKey: this.#publicKey };
  }

  // Buttons stay disabled while a change is in flight; the outcome decides
  // the state shown.
  async #run(change: () => Promise<PushState>) {
    const buttons = this.querySelectorAll('button');
    for (const button of buttons) button.disabled = true;
    try {
      this.#showState(await change());
    } catch (error) {
      console.warn('[push] change failed', error);
      this.#show(this.#stateAfterFailure());
    } finally {
      for (const button of buttons) button.disabled = false;
    }
  }

  #stateAfterFailure(): PushState {
    // A refused or dismissed prompt is the user's answer, not an error.
    if (Notification.permission === 'denied') return 'blocked';
    if (Notification.permission === 'default') return 'off';
    return 'error';
  }

  async #enable(): Promise<PushState> {
    // subscribe() asks for permission itself. It must be the first thing
    // awaited after the tap (iOS drops the gesture across other awaits), so
    // the registration and key come from #prepare() when they can.
    const { registration, publicKey } =
      this.#registration && this.#publicKey
        ? { registration: this.#registration, publicKey: this.#publicKey }
        : await this.#prepare();
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: publicKey,
    });
    await postJson(SUBSCRIBE_URL, subscription.toJSON());
    synced = Promise.resolve(subscription);
    console.info('[push] enabled on this device');
    return 'on';
  }

  async #disable(): Promise<PushState> {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      // Server first: if that fails nothing has changed, and the browser's
      // subscription is still there to try again with.
      await postJson(UNSUBSCRIBE_URL, { endpoint: subscription.endpoint });
      await subscription.unsubscribe();
    }
    synced = Promise.resolve(null);
    console.info('[push] disabled on this device');
    return 'off';
  }
}

/**
 * The change-password form's hidden field (PushEndpointField,
 * src/web/push/settings.tsx), filled with this browser's subscription so
 * the new password keeps this device's notifications while revoking every
 * other device's.
 */
class PushEndpointElement extends HTMLElement {
  connectedCallback() {
    const input = this.querySelector('input');
    syncSubscription()
      .then((subscription) => {
        if (input && subscription) input.value = subscription.endpoint;
      })
      .catch((error: unknown) =>
        console.warn('[push] could not name this device for the form', error),
      );
  }
}

/**
 * Drops this browser's subscription where the server says nobody is signed
 * in (<push-signed-out> on the login page, PushSignedOut in
 * src/web/push/settings.tsx): the session ended away from this device (a
 * password changed elsewhere, a rotated secret, expiry), so it must stop
 * receiving the account's notifications. Browser side only: the server
 * already removed the row with the password change, and otherwise removes it
 * when the push service answers 410 for the dropped subscription. No
 * permission check: a subscription is dropped whatever the permission says.
 * The sign-out button's own drop is the service worker's.
 */
async function dropSubscription() {
  if (!pushSupported()) return;
  // getRegistration, not ready: without a worker (PWA off, a first visit)
  // there is no subscription, and ready would never resolve.
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  synced = Promise.resolve(null);
  if (!subscription) return;
  await subscription.unsubscribe();
  console.info('[push] signed out: this device push subscription dropped');
}

class PushSignedOutElement extends HTMLElement {
  connectedCallback() {
    dropSubscription().catch((error: unknown) =>
      console.warn('[push] could not drop the push subscription', error),
    );
  }
}

// Modules run once per document; the elements upgrade wherever a boosted
// navigation later swaps them in.
customElements.define('push-settings', PushSettingsElement);
customElements.define('push-endpoint', PushEndpointElement);
customElements.define('push-signed-out', PushSignedOutElement);
