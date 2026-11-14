/**
 * The outbox (#178; docs/plans/2026-11-12-offline-queued-writes.md sections
 * 3, 5 and 6; src/web/shell/outbox.md): wears, washes and packing ticks
 * tapped offline are kept in IndexedDB and replayed when the server answers
 * again. Bundled by `npm run generate:outbox` into public/js/outbox.js,
 * which the layout loads on signed-in pages; the rules it shares with the
 * server (keys, paths, the answer table, the queue over its store) are
 * src/offline-writes.ts.
 *
 * - **IndexedDB is the only truth.** Every decision (does this tap queue?
 *   is the queue full? what is left at sign-out?) and every render reads
 *   the store as committed; there is no copy in memory to disagree with it.
 *   A write is pending once its put commits, never before; a failed put
 *   leaves nothing. Every write is announced on a BroadcastChannel, so the
 *   other tabs re-read and re-render (and drain, after a put).
 * - **What queues** is marked by the server (src/web/outbox.tsx): a form
 *   `data-offline-queue` and its regions (`data-outbox-key`). Each submit is
 *   held (htmx: `htmx:confirm` cancelled, then `issueRequest`; a native
 *   post: a capture-phase `submit`, before submit-once.js, resubmitted)
 *   while the store says whether it goes through the outbox
 *   (`routesThroughOutbox`: offline, or one of its keys pending in any tab);
 *   an htmx queueable request that never reached the server or got no
 *   answer in time (`htmx:sendError`, `htmx:timeout`: it may have landed,
 *   the replay is idempotent) is queued too. One record per key: a new intent replaces the old one in
 *   the same transaction (Wore today then Undo replays only the Undo).
 * - **What shows** is the server's markup: a region with a pending record
 *   shows the state its `<template data-outbox-state>` holds when the shown
 *   one would ask for what is queued, and `data-outbox="pending"` its
 *   "Waiting to sync"; a record that ends failed puts the server's state
 *   back. Re-derived from the store after every load, swap and change.
 * - **One scheduler** (`schedule`) owns every drain: after each enqueue, on
 *   reconnect (`connectivity:change`), load, `visibilitychange`, another
 *   tab's put and its own backoff timer. One tab drains at a time
 *   (`navigator.locks`; another tab's drain waits, then finds what is
 *   left), oldest first, each replay given REPLAY_TIMEOUT_MS; a record
 *   replaced while the drain ran is never sent, nor written back after its
 *   answer; a network error, a timeout or a 5xx stops it and keeps the
 *   order (backoff), a 401 keeps everything for the next sign-in, a
 *   404/409/400 is a failure the notice shows until it is dismissed.
 * - **Accounts**: a record is its page's account's (`data-account`). A page
 *   of another account deletes the others' records unsent; signing out
 *   and deleting the account drain for at most SIGN_OUT_DRAIN_MS; then
 *   only signing out asks before discarding what is left (deletion never
 *   asks: the next other account's page deletes it unsent).
 *
 * Listeners sit on the document once, at module evaluation (a module runs
 * once per document; boosted navigations swap only the body).
 */
import { singleFlight } from 'single-flight';
import { confirmAction } from 'confirm-sheet';
import { showToast } from 'toast';
import { parseIsoDate, todayIn } from '../../src/calendar-date';
import {
  dayOfStamp,
  dayText,
  wearQueuesOn,
  wornState,
} from '../../src/page-day';
import {
  enqueue,
  isChecklist,
  packedCount,
  OUTBOX_MAX_PENDING,
  OUTBOX_SYNCED,
  type OutboxStore,
  type QueueableKind,
  queueableKindOf,
  reasonTextName,
  REPLAY_HEADER,
  REPLAY_TIMEOUT_MS,
  type ReplayFailure,
  type ReplayVerdict,
  isStuck,
  type ReplayDriver,
  replayQueue,
  replayVerdict,
  routesThroughOutbox,
  takesDay,
  takesInstant,
  actionBusyAttributes,
  createTurns,
  type Exclusively,
  discardStuck,
  retryStuck,
  type StuckActionStore,
} from '../../src/offline-writes';
import { openOutboxChannel, outbox, type OutboxChange } from './outbox-store';

type Fields = Record<string, string | string[]>;

interface OutboxRecord {
  /** A v4 uuid: the replay's Idempotency-Key, and a wear's clientId. */
  id: string;
  account: string;
  kind: QueueableKind;
  key: string;
  path: string;
  fields: Fields;
  /** The garment, outfit or extra, for the notice. */
  label: string;
  queuedAt: number;
  attempts: number;
  /** Consecutive 5xx answers, and when it became stuck (replayQueue): absent on a record without either. */
  serverErrors?: number;
  stuckAt?: number;
  state: 'pending' | 'failed';
  reason?: ReplayFailure;
}

/** A region's write, read from the page at the tap. */
interface Draft {
  region: HTMLElement;
  kind: QueueableKind;
  key: string;
  path: string;
  label: string;
  fields: Fields;
}

declare global {
  interface Window {
    htmx?: { process(element: Element): void };
  }
}

/** What one drain did: its saves, and when to retry, if it must. */
interface DrainResult {
  saved: number;
  /** The saved records' paths: OUTBOX_SYNCED's. */
  savedPaths: string[];
  retryInMs?: number;
}

const DRAIN_LOCK = 'closet-outbox-drain';
// The posts that leave the account on this device: its queue drains first.
const SIGN_OUT = '/auth/logout';
const LEAVES_ACCOUNT: ReadonlySet<string> = new Set([
  SIGN_OUT,
  '/auth/delete-account',
]);
// Sign-out and deletion wait this long for the queue to drain, then asks about the rest.
const SIGN_OUT_DRAIN_MS = 5_000;
// frontend-pwa.md: a sync says so only once it is slow.
const SYNCING_QUIET_MS = 2_000;
const SAVED_TOAST_MS = 3_000;
const REFUSAL_TOAST_MS = 6_000;

const REGION = '[data-outbox-key]';
// public/js/freshness.js's, on the document whenever its stamp is set.
const FRESHNESS_CHANGE = 'freshness:change';
const QUEUE_FORM = 'form[data-offline-queue]';
const ALTERNATE = ':scope > template[data-outbox-state]';
const FULL_MARK = 'outboxFull';
/**
 * On a region showing a queued intent instead of the server's state: what
 * to put back if the record fails. `flipped`: its template's state is shown;
 * `ticked`: its checkbox is the record's.
 */
const INTENT_MARK = 'outboxIntent';

const ACTION_TEXT: Record<QueueableKind, string> = {
  wear: 'textOutboxActionWear',
  wash: 'textOutboxActionWash',
  entry: 'textOutboxActionEntry',
  packed: 'textOutboxActionPacked',
  item: 'textOutboxActionPacked',
};

// ---- The page ---------------------------------------------------------------

const appStatus = () => document.getElementById('app-status')?.dataset ?? {};
/** The page's account; absent on a signed-out page, where nothing runs. */
const pageAccount = () => appStatus().account;
const text = (name: string) => appStatus()[name] ?? '';

/** A string with a count: its `One` or `Many` form, `{count}` filled. */
function counted(
  name: 'Waiting' | 'Syncing' | 'Retrying' | 'Saved' | 'SignIn' | 'Discard',
  count: number,
): string {
  return text(`textOutbox${name}${count === 1 ? 'One' : 'Many'}`).replace(
    '{count}',
    String(count),
  );
}

const fullText = () =>
  text('textOutboxFull').replace('{count}', String(OUTBOX_MAX_PENDING));

/** connectivity.js's state, on <html>; absent until its first change (online). */
function offline(): boolean {
  const state = document.documentElement.dataset.connectivity;
  return state === 'offline' || state === 'reconnecting';
}

// ---- The store --------------------------------------------------------------

/** One transaction over the store, settled when it commits. */
async function transact(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => void,
): Promise<void> {
  await outbox.transact(mode, work);
}

/**
 * The other tabs of this origin, and the worker, which posts here when it
 * deletes records at a session boundary.
 */
const channel = openOutboxChannel();

/**
 * A committed write: re-rendered here, announced to the other tabs. Every
 * readwrite transaction goes through it, so no tab shows a store it has
 * not re-read.
 */
async function write(
  work: (store: IDBObjectStore) => void,
  { drain = false } = {},
): Promise<void> {
  await transact('readwrite', work);
  channel?.postMessage({ drain } satisfies OutboxChange);
  void refresh();
}

async function readAll(): Promise<OutboxRecord[]> {
  let records: OutboxRecord[] = [];
  await transact('readonly', (store) => {
    const request = store.getAll();
    request.onsuccess = () => {
      records = request.result;
    };
  });
  return records.sort((a, b) => a.queuedAt - b.queuedAt);
}

const store: OutboxStore<OutboxRecord> = {
  async records(account) {
    return (await readAll()).filter((record) => record.account === account);
  },
  putCollapsed(records) {
    return write(
      (objects) => {
        for (const record of records) {
          const same = objects.index('key').getAll(record.key);
          same.onsuccess = () => {
            const olds: OutboxRecord[] = same.result;
            for (const old of olds) {
              if (old.account === record.account) objects.delete(old.id);
            }
            objects.put(record);
          };
        }
      },
      { drain: true },
    );
  },
};

/** The account's records, or none when the store cannot be read (logged). */
async function recordsOf(account: string): Promise<OutboxRecord[]> {
  try {
    return await store.records(account);
  } catch (error) {
    console.warn('[outbox] could not read the queue', error);
    return [];
  }
}

/** Whether a record is still in the store: not replaced by a newer intent. */
async function isQueued(record: OutboxRecord): Promise<boolean> {
  let queued = false;
  await transact('readonly', (objects) => {
    const request = objects.getKey(record.id);
    request.onsuccess = () => {
      queued = request.result !== undefined;
    };
  });
  return queued;
}

/**
 * A replay's answer applied to its record (`next` in its place, or deleted)
 * only if it is still queued, in one transaction: a newer intent for its
 * key that replaced it while it was in flight must not get the old one
 * back beside it. Whether it was still queued.
 */
async function settle(
  record: OutboxRecord,
  next?: OutboxRecord,
): Promise<boolean> {
  let queued = false;
  await write((objects) => {
    const request = objects.getKey(record.id);
    request.onsuccess = () => {
      queued = request.result !== undefined;
      if (!queued) return;
      if (next) objects.put(next);
      else objects.delete(record.id);
    };
  });
  return queued;
}

const remove = (records: OutboxRecord[]) =>
  write((objects) => {
    for (const record of records) objects.delete(record.id);
  });

/**
 * A page of another account than the records' deletes them unsent (plan
 * section 6): never replayed into, or shown to, the new account.
 */
async function claimForAccount(): Promise<void> {
  const account = pageAccount();
  const others = (await readAll()).filter(
    (record) => record.account !== account,
  );
  if (others.length === 0) return;
  await remove(others);
  console.info(
    `[outbox] ${others.length} queued change(s) of another account deleted unsent`,
  );
}

// ---- Rendering --------------------------------------------------------------

/** The last replay was a 401: everything waits for a sign-in. */
let signedOut = false;
/** A drain has been running past SYNCING_QUIET_MS. */
let syncing = false;

const isPending = (record: OutboxRecord) => record.state === 'pending';

/**
 * Re-reads the store and draws it. Single-flight: a call during a render
 * runs once more after it, so the last one drawn is never an older read.
 */
const refresh = singleFlight(async () => {
  const account = pageAccount();
  if (!account) return;
  render(await recordsOf(account));
});

function render(records: OutboxRecord[]): void {
  const waiting = records.filter(isPending).length;
  renderRegions(records);
  renderPackedCounts(records);
  // Online with a record that has been tried and not saved: the drain is
  // waiting out its backoff (a 5xx, a timeout), which nothing else shows.
  renderBanner(
    waiting,
    records.some(
      (record) => isPending(record) && !isStuck(record) && record.attempts > 0,
    ),
  );
  renderNotice(
    records.filter((record) => !isPending(record) || isStuck(record)),
  );
  guardFull(waiting);
}

/**
 * The trip's "N of M packed" lines (`data-packed-count`: the string with
 * `{packed}` left in it, `data-packed-served` the server's number,
 * src/web/trips/trip-page.tsx): while ticks wait to sync, the server's
 * count plus the pending records' net (`packedCount`), so a queued tick
 * moves the counter before the server has saved it. With nothing pending in
 * the counter's section the line is left as the server rendered it.
 */
function renderPackedCounts(records: OutboxRecord[]): void {
  const waiting = new Map(
    records.filter(isPending).map((record) => [record.key, record]),
  );
  for (const counter of document.querySelectorAll<HTMLElement>(
    '[data-packed-count]',
  )) {
    const regions = counter
      .closest('section')
      ?.querySelectorAll<HTMLElement>(`${REGION}:has(input[name="packed"])`);
    const rows = Array.from(regions ?? []).map((region) => ({
      served:
        region.querySelector<HTMLInputElement>('input[name="packed"]')
          ?.defaultChecked ?? false,
      queued: intentOf(waiting.get(regionKey(region))),
    }));
    if (rows.every((row) => row.queued === undefined)) {
      if (counter.dataset.counted === undefined) continue;
      delete counter.dataset.counted;
    } else {
      counter.dataset.counted = '';
    }
    const count = packedCount(Number(counter.dataset.packedServed), rows);
    counter.textContent = (counter.dataset.packedCount ?? '').replace(
      '{packed}',
      String(count),
    );
  }
}

/** A pending tick's intent: ticked or not; undefined without a record. */
const intentOf = (record: OutboxRecord | undefined) =>
  record && [record.fields.packed ?? []].flat().length > 0;

/**
 * A region with a pending record is marked and shows the intent it waits
 * to save; one whose record failed shows the server's state again; one
 * whose record was saved keeps what it shows, now the server's too.
 */
function renderRegions(records: OutboxRecord[]): void {
  const waiting = new Map(
    records.filter(isPending).map((record) => [record.key, record]),
  );
  const failed = new Set(
    records.filter((r) => !isPending(r)).map((r) => r.key),
  );
  for (const region of document.querySelectorAll<HTMLElement>(REGION)) {
    const key = regionKey(region);
    const record = waiting.get(key);
    if (record) {
      showIntent(region, record);
      region.dataset.outbox = 'pending';
      continue;
    }
    delete region.dataset.outbox;
    if (failed.has(key)) showServerState(region);
    delete region.dataset[INTENT_MARK];
  }
}

/**
 * The region shows the record's state: a checklist row its tick, a control
 * its other state when the one shown would ask for what is already queued
 * (a tap, a cached page reopened, Wore today then Undo flipping back).
 * Idempotent: once flipped, the shown form no longer asks for it.
 */
function showIntent(region: HTMLElement, record: OutboxRecord): void {
  const checkbox = region.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  if (isChecklist(record.kind) && checkbox) {
    checkbox.checked = [record.fields.packed ?? []].flat().length > 0;
    region.dataset[INTENT_MARK] = 'ticked';
  } else if (asksFor(region, record)) {
    flip(region);
    // Twice flipped is the server's markup again: nothing to put back.
    if (region.dataset[INTENT_MARK] === 'flipped') {
      delete region.dataset[INTENT_MARK];
    } else {
      region.dataset[INTENT_MARK] = 'flipped';
    }
  }
}

/**
 * A failed record's region back to what the server rendered (the notice
 * says it was not saved): a tick to its markup's `checked`, a flipped
 * control flipped back.
 */
function showServerState(region: HTMLElement): void {
  const mark = region.dataset[INTENT_MARK];
  if (mark === 'ticked') {
    const checkbox = region.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (checkbox) checkbox.checked = checkbox.defaultChecked;
  } else if (mark === 'flipped') {
    flip(region);
  }
}

/** A discarded record's region back to the server's state, its intent mark gone. */
function revertRegions(key: string): void {
  for (const region of document.querySelectorAll<HTMLElement>(REGION)) {
    if (regionKey(region) !== key) continue;
    showServerState(region);
    delete region.dataset[INTENT_MARK];
  }
}

/** The form shown posts what the record posts (its day and ids aside). */
function asksFor(region: HTMLElement, record: OutboxRecord): boolean {
  if (!region.querySelector(ALTERNATE)) return false;
  const form = region.querySelector<HTMLFormElement>(':scope > form');
  if (!form) return false;
  for (const [name, value] of new FormData(form)) {
    if (name !== 'returnTo' && record.fields[name] !== value) return false;
  }
  return true;
}

/** Swaps the region's shown state with the one in its template. */
function flip(region: HTMLElement): void {
  const template = region.querySelector<HTMLTemplateElement>(ALTERNATE);
  if (!template) return;
  const focused = region.contains(document.activeElement);
  const shown = Array.from(region.children).filter(
    (child) => child !== template && !child.matches('[data-outbox-chip]'),
  );
  const next = Array.from(template.content.childNodes);
  template.content.replaceChildren(...shown);
  template.before(...next);
  window.htmx?.process(region);
  if (focused)
    region.querySelector<HTMLElement>(':scope > form button')?.focus();
}

function renderBanner(count: number, backingOff: boolean): void {
  const banner = document.getElementById('outbox-banner');
  const slot = banner?.querySelector('[data-role="text"]');
  if (!banner || !slot) return;
  let message = '';
  if (count === 0) message = '';
  else if (signedOut) message = counted('SignIn', count);
  else if (offline() && count >= OUTBOX_MAX_PENDING) message = fullText();
  else if (offline()) message = counted('Waiting', count);
  else if (syncing) message = counted('Syncing', count);
  else if (backingOff) message = counted('Retrying', count);
  slot.textContent = message;
  banner.classList.toggle('hidden', message === '');
}

function renderNotice(unsaved: OutboxRecord[]): void {
  const notice = document.getElementById('outbox-notice');
  const list = notice?.querySelector('[data-role="list"]');
  if (!notice || !list) return;
  list.replaceChildren(
    ...unsaved.map((record) => {
      const item = document.createElement('li');
      item.className = 'flex flex-wrap items-center gap-x-2';
      const line = document.createElement('span');
      line.textContent = noticeText(record);
      item.append(line);
      if (isStuck(record)) {
        item.append(
          noticeButton('data-outbox-retry', record.id, 'textOutboxTryAgain'),
          noticeButton(
            'data-outbox-discard',
            record.id,
            'textOutboxDiscardWrite',
          ),
        );
      }
      return item;
    }),
  );
  notice
    .querySelector('[data-outbox-dismiss]')
    ?.classList.toggle('hidden', !unsaved.some((r) => !isPending(r)));
  notice.classList.toggle('hidden', unsaved.length === 0);
}

/** Notice buttons whose action waits for the drain's turn: shown busy across re-renders. */
const busyActions = new Set<string>();

function noticeButton(
  attribute: string,
  id: string,
  label: string,
): HTMLButtonElement {
  const button = document.createElement('button');
  for (const [name, value] of Object.entries(
    actionBusyAttributes(busyActions.has(id)),
  ))
    button.setAttribute(name, value);
  button.type = 'button';
  button.className = 'btn btn-ghost btn-xs';
  button.setAttribute(attribute, id);
  button.textContent = text(label);
  return button;
}

/**
 * "Navy chinos, Wore today: not saved, it was deleted." A stuck write is
 * still queued: "Navy chinos, Wore today: not saved yet, the server keeps
 * answering with an error."
 */
function noticeText(record: OutboxRecord): string {
  // Replaced through functions: a label's `$&` is not a pattern.
  return text(isStuck(record) ? 'textOutboxStuck' : 'textOutboxNotSaved')
    .replace('{label}', () => record.label)
    .replace('{action}', () => text(ACTION_TEXT[record.kind]))
    .replace('{reason}', () => text(reasonTextName(record.reason)));
}

/**
 * Past OUTBOX_MAX_PENDING the queueable controls are disabled offline, like
 * connectivity.js's, and the banner says why; marked, so only those come
 * back.
 */
function guardFull(waiting: number): void {
  const full = offline() && waiting >= OUTBOX_MAX_PENDING;
  for (const form of document.querySelectorAll<HTMLFormElement>(QUEUE_FORM)) {
    for (const control of form.querySelectorAll<
      HTMLButtonElement | HTMLInputElement
    >('button, input:not([type="hidden"])')) {
      if (full && !control.disabled) {
        control.disabled = true;
        control.dataset[FULL_MARK] = '';
      } else if (!full && FULL_MARK in control.dataset) {
        control.disabled = false;
        delete control.dataset[FULL_MARK];
      }
    }
  }
}

// ---- Queueing ---------------------------------------------------------------

/**
 * What a submit of a queueable form writes. A form inside a region is that
 * region's write, its fields as posted. A form holding regions writes each
 * row by itself: the packing lists the tapped row (its tick as `shown` and
 * `packed`, the checklist protocol, so the replay changes only it), the
 * laundry every checked row (a wash, replayed through the garment's Washed).
 */
function drafts(form: HTMLFormElement, trigger: EventTarget | null): Draft[] {
  const own = form.closest<HTMLElement>(REGION);
  if (own) return [draftOf(own, formFields(form))].filter(isDraft);
  const tapped =
    trigger instanceof Element ? trigger.closest<HTMLElement>(REGION) : null;
  const rows =
    tapped && form.contains(tapped)
      ? [tapped]
      : Array.from(form.querySelectorAll<HTMLElement>(REGION));
  return rows
    .map((row) => {
      const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
      const kind = kindOf(row);
      if (!box || !kind) return undefined;
      if (isChecklist(kind)) {
        return draftOf(row, {
          shown: [box.value],
          packed: box.checked ? [box.value] : [],
        });
      }
      return box.checked ? draftOf(row, {}) : undefined;
    })
    .filter(isDraft);
}

const isDraft = (draft: Draft | undefined): draft is Draft =>
  draft !== undefined;

const kindOf = (region: HTMLElement) =>
  queueableKindOf(region.dataset.outboxPath ?? '');

function draftOf(region: HTMLElement, fields: Fields): Draft | undefined {
  const { outboxPath: path, outboxLabel: label } = region.dataset;
  const key = regionKey(region);
  const kind = kindOf(region);
  if (!key || !path || !kind) {
    console.warn(`[outbox] a region names no queueable write (${path})`);
    return undefined;
  }
  return { region, kind, key, path, label: label ?? '', fields };
}

/** The form's fields as it would post them (repeated names as a list). */
function formFields(form: HTMLFormElement): Fields {
  const fields: Fields = {};
  for (const [name, value] of new FormData(form)) {
    if (typeof value !== 'string') continue;
    const prior = fields[name];
    fields[name] = prior === undefined ? value : [prior, value].flat();
  }
  return fields;
}

/**
 * crypto.randomUUID() needs a secure context, which the household's HTTP
 * twin is not; getRandomValues does not.
 */
function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4),
    hex.slice(4, 6),
    hex.slice(6, 8),
    hex.slice(8, 10),
    hex.slice(10),
  ]
    .map((part) => part.join(''))
    .join('-');
}

function toRecord(
  draft: Draft,
  account: string,
  queuedAt: number,
  today: string,
): OutboxRecord {
  const id = newId();
  const fields = { ...draft.fields };
  // The tap's day, not the replay's: a Sunday-night wear replayed Monday is
  // Sunday's (the server takes it back to REPLAY_WINDOW_DAYS). Its instant
  // too, for an entry marked worn as well, so a same-day wear and wash keep
  // the tap's order (#676); a replay without one is an unknown instant.
  if (takesDay(draft.kind)) fields.day = today;
  if (takesInstant(draft.kind)) fields.at = new Date(queuedAt).toISOString();
  if (draft.kind === 'wear' && fields.worn === '1') fields.clientId = id;
  return {
    id,
    account,
    kind: draft.kind,
    key: draft.key,
    path: draft.path,
    fields,
    label: draft.label,
    queuedAt,
    attempts: 0,
    state: 'pending',
  };
}

/** A tap that cannot be queued: why, and a checklist's tick put back. */
function refuse(message: string, trigger: EventTarget | null): void {
  if (trigger instanceof HTMLInputElement && trigger.type === 'checkbox') {
    trigger.checked = !trigger.checked;
  }
  showToast({ text: message, kind: 'warning', ttlMs: REFUSAL_TOAST_MS });
}

/**
 * Queues a tap's writes, read from the page at the tap. Pending only once
 * stored (`enqueue`); then drained at once if online, after any drain in
 * flight.
 */
async function queue(
  writes: Draft[],
  trigger: EventTarget | null,
): Promise<void> {
  const account = pageAccount();
  const timeZone = appStatus().timeZone;
  if (!account || !timeZone || writes.length === 0) return;
  const now = new Date();
  const today = todayIn(timeZone, now);
  // Wore today's state is its page's day's (#708): a copy from another day,
  // a page left open overnight included, would queue the wrong toggle, and
  // one whose day is unknown queues nothing, never under an unknown day.
  const wear = writes.find((w) => w.kind === 'wear');
  if (wear) {
    const day = pageDayOf(wear.region, timeZone);
    if (!wearQueuesOn(day, today)) {
      console.info(
        `[outbox] ${wear.key} refused: the page is ${day ? `of ${day}` : 'of an unknown day'}, the tap of ${today}`,
      );
      refuse(text('textOutboxStaleDay'), trigger);
      return;
    }
  }
  const queued = writes.map((w) => toRecord(w, account, now.getTime(), today));
  const keys = queued.map((record) => record.key).join(', ');
  const result = await enqueue(store, account, queued);
  if (result.outcome === 'full') {
    console.info(`[outbox] ${keys} refused: ${OUTBOX_MAX_PENDING} waiting`);
    refuse(fullText(), trigger);
  } else if (result.outcome === 'unavailable') {
    console.warn(`[outbox] could not queue ${keys}`, result.error);
    refuse(text('textOutboxUnavailable'), trigger);
  } else {
    console.info(`[outbox] queued ${keys}`);
    // The autosave line says "Saved" for the last answer the server gave;
    // this tap has none, and the row's "Waiting to sync" is the state.
    for (const write of writes) {
      write.region
        .closest('form')
        ?.querySelector('[data-autosave-status]')
        ?.replaceChildren();
    }
    void schedule('queued');
  }
}

/**
 * Taps are decided and queued one at a time in a tab: a second tap on a
 * key reads the store after the first one's put has committed.
 */
let taps: Promise<void> = Promise.resolve();

function serially(task: () => Promise<void>): Promise<void> {
  const run = taps.then(task);
  taps = run.catch((error: unknown) => {
    console.warn('[outbox] a tap failed', error);
  });
  return taps;
}

/**
 * The one rule for a tap of a queueable form, over the store as committed
 * (routesThroughOutbox): queued offline, and online while any of its keys
 * has a pending record in any tab, so it replaces that record and replays
 * after it rather than racing it; otherwise `proceed` lets it go to the server.
 * Online with the store unreadable, it goes straight on.
 */
function route(
  form: HTMLFormElement,
  trigger: EventTarget | null,
  proceed: () => void,
): Promise<void> {
  // Read at the tap: a checklist's tick is the tapped state.
  const writes = drafts(form, trigger);
  const keys = writes.map((draft) => draft.key);
  return serially(async () => {
    const account = pageAccount() ?? '';
    let through: boolean;
    try {
      through = await routesThroughOutbox(store, account, offline(), keys);
    } catch (error) {
      console.warn('[outbox] could not read the queue; sent directly', error);
      through = false;
    }
    if (through) await queue(writes, trigger);
    else proceed();
  });
}

/** The queueable form an event came from, on a signed-in page. */
function queueFormOf(element: unknown): HTMLFormElement | null {
  if (!(element instanceof Element) || !pageAccount()) return null;
  return element.closest<HTMLFormElement>(QUEUE_FORM);
}

interface HtmxRequestEvent {
  elt?: Element;
  verb?: string;
  triggeringEvent?: Event;
  requestConfig?: { triggeringEvent?: Event };
  /** htmx:confirm's: sends the request it held (true: without asking again). */
  issueRequest?: (skipConfirmation: boolean) => void;
}

// htmx's own forms (Wore today, Washed, the calendar's pill, the packing
// lists): held until the store answers, then queued or sent.
document.addEventListener('htmx:confirm', (event) => {
  const detail = (event as CustomEvent<HtmxRequestEvent>).detail;
  const form = queueFormOf(detail.elt);
  const issue = detail.issueRequest;
  if (!form || detail.verb !== 'post' || !issue) return;
  event.preventDefault();
  void route(form, detail.triggeringEvent?.target ?? null, () => issue(true));
});

// Sent but never reached the server, though connectivity.js had not seen
// the drop yet, or sent with no answer before htmx's timeout (HTMX_CONFIG,
// REPLAY_TIMEOUT_MS; request-failures.js leaves these to us): queued, in
// case it never landed, and drained by the scheduler, which no
// connectivity:change may ever wake (the probe after the error can still
// say online).
function queueUnanswered(event: Event): void {
  const detail = (event as CustomEvent<HtmxRequestEvent>).detail;
  const form = queueFormOf(detail.elt);
  if (!form) return;
  const trigger = detail.requestConfig?.triggeringEvent?.target ?? null;
  const writes = drafts(form, trigger);
  void serially(() => queue(writes, trigger));
}
document.addEventListener('htmx:sendError', queueUnanswered);
document.addEventListener('htmx:timeout', queueUnanswered);

/** Native posts let through after their decision: the resubmit is not held again. */
const released = new WeakSet<HTMLFormElement>();
/** Native posts held for their decision: a double tap meanwhile is dropped, as submit-once.js would. */
const deciding = new WeakSet<HTMLFormElement>();

// Native posts (the laundry, Today's and a trip's worn control): in the
// capture phase, before submit-once.js would disable the buttons.
document.addEventListener(
  'submit',
  (event) => {
    const form = queueFormOf(event.target);
    if (!form || form.hasAttribute('hx-post')) return;
    if (released.delete(form)) return;
    event.preventDefault();
    if (deciding.has(form)) return;
    deciding.add(form);
    const submitter = event.submitter;
    void route(form, submitter, () => {
      released.add(form);
      form.requestSubmit(submitter);
    }).finally(() => deciding.delete(form));
  },
  true,
);

// ---- Replay -----------------------------------------------------------------

/** Only a same-origin path of a queueable route is ever posted (plan section 7). */
function replayUrl(path: string): URL | undefined {
  try {
    const url = new URL(path, location.origin);
    const ours =
      url.origin === location.origin &&
      url.search === '' &&
      queueableKindOf(url.pathname) !== undefined;
    return ours ? url : undefined;
  } catch {
    return undefined;
  }
}

function formBody(fields: Fields): URLSearchParams {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of [value].flat()) body.append(name, item);
  }
  return body;
}

async function send(record: OutboxRecord, url: URL): Promise<ReplayVerdict> {
  // A timer, not AbortSignal.timeout: one clock with the rest of the page
  // (the specs move it with Playwright's).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REPLAY_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      body: formBody(record.fields),
      credentials: 'same-origin',
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        [REPLAY_HEADER]: record.account,
        'Idempotency-Key': record.id,
      },
    });
    return replayVerdict(
      response.status,
      response.headers.get('X-Closet-Outcome'),
    );
  } catch {
    if (controller.signal.aborted) {
      console.info(
        `[outbox] ${record.key} (key ${record.id.slice(0, 8)}) had no answer in ${REPLAY_TIMEOUT_MS / 1000} s`,
      );
    }
    return { verdict: 'retry', cause: 'unreachable' };
  } finally {
    clearTimeout(timeout);
  }
}

/** Replays the account's pending records (replayQueue's rules). */
async function replayAll(
  account: string,
  reason: string,
): Promise<DrainResult> {
  const queued = (await store.records(account)).filter(isPending);
  const result: DrainResult = { saved: 0, savedPaths: [] };
  if (queued.length === 0) return result;
  console.info(`[outbox] sync (${reason}): ${queued.length} pending`);
  const quiet = setTimeout(() => {
    syncing = true;
    void refresh();
  }, SYNCING_QUIET_MS);
  const nameOf = (record: OutboxRecord) =>
    `${record.key} (key ${record.id.slice(0, 8)})`;
  const driver: ReplayDriver<OutboxRecord> = {
    now: Date.now,
    async skip(record) {
      if (!replayUrl(record.path)) {
        await remove([record]);
        console.warn(
          `[outbox] ${nameOf(record)} deleted: ${record.path} is not a queued write`,
        );
        return true;
      }
      // Replaced by a newer intent since the drain read the store: that one
      // replays instead, this one never.
      if (!(await isQueued(record))) {
        console.info(`[outbox] ${nameOf(record)} superseded before its replay`);
        return true;
      }
      return false;
    },
    send(record) {
      return send(record, replayUrl(record.path) as URL);
    },
    async settle(record, step) {
      const key = nameOf(record);
      if (step.step === 'saved') {
        // A replaced one's save is not the user's last word: its successor
        // replays next and is the one counted.
        const current = await settle(record);
        if (current) {
          result.saved += 1;
          result.savedPaths.push(record.path);
        }
        console.info(
          `[outbox] ${key} saved (${step.changed ? 'changed' : 'unchanged'})${current ? '' : ', superseded meanwhile'}`,
        );
        return current;
      }
      const current = await settle(record, step.record);
      const meanwhile = current ? '' : ', superseded meanwhile';
      if (step.step === 'failed') {
        console.warn(
          `[outbox] ${key} not saved: ${step.record.reason}${meanwhile}`,
        );
      } else {
        console.info(
          `[outbox] ${key} ${step.why}, retry ${step.record.attempts}${meanwhile}`,
        );
      }
      return current;
    },
  };
  try {
    // The heartbeat saw the server answer again: the stuck ones get their turn.
    const end = await replayQueue(queued, driver, {
      serverAnswering: reason === 'online',
    });
    if (end.end !== 'backoff') signedOut = end.end === 'no-session';
    if (end.end === 'backoff') {
      result.retryInMs = end.retryInMs;
      console.info(`[outbox] retry in ${end.retryInMs / 1000} s`);
    } else if (end.end === 'no-session') {
      console.info(`[outbox] needs a sign-in; ${queued.length} kept`);
    }
    return result;
  } finally {
    clearTimeout(quiet);
    syncing = false;
  }
}

const tabTurns = createTurns();

/**
 * The drain's turn: across tabs `navigator.locks`, in this tab a queue of
 * turns (also the only guard where locks are missing: they need a secure
 * context). The notice's Try again and Discard take it too, so neither
 * races a replay of the record (retryStuck, discardStuck).
 */
const exclusively: Exclusively = (task) =>
  tabTurns(async () =>
    navigator.locks ? await navigator.locks.request(DRAIN_LOCK, task) : task(),
  );

/** The backoff's next drain; only `drain` sets it, one at a time per tab. */
let retryTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * One drain at a time in this tab (a call during one runs once more after
 * it, single-flight.js) and across tabs (the lock: a tab finding it held
 * waits, then drains what the other left, so a tap queued here while the
 * other tab replays is not stranded until the next reconnect). Every
 * replay is bounded (REPLAY_TIMEOUT_MS), so the lock always comes back.
 */
const drain = singleFlight(async (reason: string) => {
  const account = pageAccount();
  if (!account) return;
  clearTimeout(retryTimer);
  retryTimer = undefined;
  let result: DrainResult;
  try {
    result = await exclusively(() => replayAll(account, reason));
  } catch (error) {
    console.warn(`[outbox] sync (${reason}) failed`, error);
    result = { saved: 0, savedPaths: [] };
  }
  if (result.retryInMs !== undefined) {
    retryTimer = setTimeout(() => void schedule('retry'), result.retryInMs);
  }
  await refresh();
  if (result.saved > 0) {
    showToast({
      text: counted('Saved', result.saved),
      kind: 'success',
      ttlMs: SAVED_TOAST_MS,
    });
  }
  if (result.saved > 0) refetchSyncedPages(result.savedPaths);
});

/**
 * The worker refetches its cached copies of the pages that show what was
 * saved (src-sw.ts, OUTBOX_SYNCED), so one reopened offline later shows it,
 * and tells every open tab which changed (PAGES_RENEWED), this one
 * included: freshness.js swaps in the server's copy of a page on screen
 * among them, so its counts and lines are the server's. A failure needs
 * neither: its region is put back here (showServerState). Without a
 * controlling worker there is nothing cached and nobody to tell.
 */
function refetchSyncedPages(paths: string[]): void {
  navigator.serviceWorker?.controller?.postMessage({
    type: OUTBOX_SYNCED,
    paths,
  });
}

/**
 * The one way a drain starts, whatever woke it: an enqueue, reconnecting,
 * a load, the app back in front, another tab's put, the backoff. Offline
 * it waits for connectivity.js's change to online, which schedules again.
 */
function schedule(reason: string): Promise<void> {
  if (offline()) return Promise.resolve();
  return drain(reason);
}

// ---- Signing out --------------------------------------------------------------

/**
 * Sign-out and account deletion drain first (online by definition), for at
 * most SIGN_OUT_DRAIN_MS so a slow link never strands the tap; what is left,
 * failed, unreachable or still in flight, is named in a confirm and
 * discarded (owner decision 2, 2026-11-13). False when the person keeps
 * them: nothing is posted.
 *
 * A deletion drains but never asks or discards: its own confirm and password
 * check come after this hold and may refuse, which must leave the queue
 * alone. What a deleted account leaves queued is deleted unsent by the next
 * page of another account (claimForAccount).
 */
async function drainBeforeLeaving(
  account: string,
  discardLeftovers: boolean,
): Promise<boolean> {
  if ((await recordsOf(account)).length === 0) return true;
  let waited: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([
    schedule('sign-out').then(() => true),
    new Promise<false>((resolve) => {
      waited = setTimeout(() => resolve(false), SIGN_OUT_DRAIN_MS);
    }),
  ]);
  clearTimeout(waited);
  if (!drained) {
    console.info(
      `[outbox] sign-out: still syncing after ${SIGN_OUT_DRAIN_MS / 1000} s`,
    );
  }
  const left = await recordsOf(account);
  if (left.length === 0 || !discardLeftovers) return true;
  const discard = await confirmAction({
    question: counted('Discard', left.length),
  });
  if (!discard) return false;
  await remove(left);
  console.info(
    `[outbox] ${left.length} unsynced change(s) discarded at sign-out`,
  );
  return true;
}

// Held in the capture phase, before the form's own confirm (deletion's),
// submit-once.js and pwa.js see it, then resubmitted as it was (released):
// the post then leaves like any other, its confirm asked, its buttons
// disabled, and the worker told (data-ends-session, SESSION_ENDING).
document.addEventListener(
  'submit',
  (event) => {
    const form = event.target;
    const account = pageAccount();
    if (!(form instanceof HTMLFormElement) || !account) return;
    const action = form.getAttribute('action') ?? '';
    if (!LEAVES_ACCOUNT.has(action)) return;
    // released/deciding: the per-form hold sets declared above the queueable-form hold (~line 742); released = resubmit let through once, deciding = a decision is pending.
    if (released.delete(form)) return;
    // Held while the store is read: what is queued is known only there.
    event.preventDefault();
    event.stopPropagation();
    if (deciding.has(form)) return;
    deciding.add(form);
    const submitter = event.submitter;
    void drainBeforeLeaving(account, action === SIGN_OUT)
      .then((leave) => {
        if (!leave) return;
        released.add(form);
        form.requestSubmit(submitter);
      })
      .finally(() => deciding.delete(form));
  },
  true,
);

// ---- The page's day (#708) ------------------------------------------------------

/**
 * The day what `element` shows is of: a live htmx answer's own
 * (`data-as-of-day`, Wore today's and Washed's), else the page's, from the
 * stamp freshness.js keeps on `#freshness` (the load, the cached copy's
 * arrival, or its last revalidation; kept in htmx's history snapshots).
 * Undefined while the page has none (no worker).
 */
function pageDayOf(element: Element, timeZone: string): string | undefined {
  const answered = element.closest<HTMLElement>('[data-as-of-day]');
  if (answered) return parseIsoDate(answered.dataset.asOfDay);
  return dayOfStamp(
    document.getElementById('freshness')?.dataset.fetchedAt,
    timeZone,
  );
}

/**
 * A region's record key: its own, plus the page's day for a wear (one record
 * per garment and day, `wear:41:2026-11-12`; src/offline-writes.ts). A wear
 * region on a page of no known day keys no record (queue refuses its tap).
 */
function regionKey(region: HTMLElement): string {
  const key = region.dataset.outboxKey ?? '';
  if (kindOf(region) !== 'wear') return key;
  const day = pageDayOf(region, appStatus().timeZone ?? '');
  return day ? `${key}:${day}` : key;
}

/**
 * Words every `<time data-day-label>` against its day (src/web/day-time.tsx)
 * and sets each Wore today row to its state on that day (wear-section.tsx:
 * the undo when Wore today wore it, the calendar's badge when an entry did).
 * Before the queued intents (renderRegions), on every load, swap and stamp
 * change; idempotent. A row whose intent is shown (flipped) already shows
 * the other state: its new server state is then what it shows.
 */
function showPageDay(): void {
  const timeZone = appStatus().timeZone;
  if (!timeZone) return;
  const now = todayIn(timeZone, new Date());
  const { lang } = document.documentElement;
  for (const time of document.querySelectorAll<HTMLTimeElement>(
    'time[data-day-label]',
  )) {
    const day = parseIsoDate(time.dateTime);
    const kind = time.dataset.dayLabel === 'date' ? 'date' : 'relative';
    if (!day) continue;
    time.textContent = dayText(
      day,
      pageDayOf(time, timeZone) ?? now,
      kind,
      lang,
    );
  }
  for (const region of document.querySelectorAll<HTMLElement>(REGION)) {
    if (kindOf(region) !== 'wear') continue;
    const state = wornState(
      region.dataset.wornOn,
      region.dataset.wornBy,
      pageDayOf(region, timeZone) ?? now,
    );
    const badge = region.nextElementSibling;
    region.hidden = state === 'entry';
    if (badge instanceof HTMLElement && badge.matches('[data-worn-by-entry]')) {
      badge.hidden = state !== 'entry';
    }
    const shownUndo =
      region.querySelector<HTMLInputElement>(':scope > form input[name="worn"]')
        ?.value === '0';
    const flipped = region.dataset[INTENT_MARK] === 'flipped';
    const served = flipped ? !shownUndo : shownUndo;
    if (served === (state === 'single')) continue;
    if (flipped) delete region.dataset[INTENT_MARK];
    else flip(region);
  }
}

// ---- Wiring -------------------------------------------------------------------

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  if (!event.target.closest('[data-outbox-dismiss]')) return;
  const account = pageAccount();
  if (!account) return;
  void (async () => {
    const dismissed = (await recordsOf(account)).filter((r) => !isPending(r));
    await remove(dismissed);
    console.info(`[outbox] ${dismissed.length} failure(s) dismissed`);
  })().catch((error: unknown) => {
    console.warn('[outbox] could not dismiss', error);
  });
});

const actionStore: StuckActionStore<OutboxRecord> = {
  async find(id) {
    const account = pageAccount();
    return account
      ? (await recordsOf(account)).find((r) => r.id === id)
      : undefined;
  },
  settle,
};

// A stuck write's notice: Try again clears its count and drains; Discard
// deletes it and puts its region back to the server's state.
document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const retry = event.target.closest('[data-outbox-retry]');
  const discard = event.target.closest('[data-outbox-discard]');
  const id =
    retry?.getAttribute('data-outbox-retry') ??
    discard?.getAttribute('data-outbox-discard');
  const account = pageAccount();
  if (!id || !account) return;
  if (busyActions.has(id)) return;
  busyActions.add(id);
  void refresh();
  void (async () => {
    const announce = (name: string, record: OutboxRecord) =>
      showToast({
        text: text(name)
          .replace('{label}', () => record.label)
          .replace('{action}', () => text(ACTION_TEXT[record.kind])),
        kind: 'info',
        ttlMs: SAVED_TOAST_MS,
      });
    const name = (record: OutboxRecord) =>
      `${record.key} (key ${id.slice(0, 8)})`;
    try {
      if (retry) {
        const record = await retryStuck(actionStore, exclusively, id);
        if (!record) return;
        console.info(`[outbox] ${name(record)} retried by the user`);
        announce('textOutboxTriedAgain', record);
        busyActions.delete(id);
        await schedule('try again');
      } else {
        const record = await discardStuck(actionStore, exclusively, id);
        if (!record) return;
        revertRegions(record.key);
        console.info(`[outbox] ${name(record)} discarded by the user`);
        announce('textOutboxDiscarded', record);
      }
    } finally {
      busyActions.delete(id);
      void refresh();
    }
  })().catch((error: unknown) => {
    console.warn('[outbox] could not act on a stuck write', error);
  });
});

// Another tab wrote: what is shown is re-read; a put is drained here too
// when this tab can reach the server (the lock keeps it to one drainer).
channel?.addEventListener('message', (event: MessageEvent<OutboxChange>) => {
  void refresh();
  if (event.data.drain) void schedule('another tab');
});

document.addEventListener('connectivity:change', (event) => {
  const { state } = (event as CustomEvent<{ state: string }>).detail;
  void refresh();
  if (state === 'online') void schedule('online');
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // Without BroadcastChannel, another tab may have written meanwhile.
  void refresh();
  void schedule('visible');
});

// A boosted navigation or a swap brings regions (and #app-status) anew.
document.addEventListener('htmx:afterSettle', () => {
  showPageDay();
  void refresh();
});

// The page's stamp moved (freshness.js: another display, a revalidation
// that found the copy current, a re-stamped copy): so may its day.
document.addEventListener(FRESHNESS_CHANGE, () => {
  showPageDay();
  void refresh();
});

async function start(): Promise<void> {
  showPageDay();
  if (!pageAccount()) return;
  try {
    await claimForAccount();
  } catch (error) {
    console.warn('[outbox] unavailable', error);
  }
  await refresh();
  void schedule('load');
}

void start();
