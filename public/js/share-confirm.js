/**
 * The share confirmation (#22d; GET /inspiration/share/confirm,
 * src/web/inspiration/share-confirm-page.tsx, which loads this through
 * the importmap). Why a module: the shared photo is on the device, in the
 * Cache Storage entry the service worker kept it under
 * (src/web/inspiration/share-target.ts). The worker never posts a share to
 * the server, since a cross-site page can submit the same share, so the
 * server cannot render the photo; the page's data attributes name the
 * stash, so its names live in that one TS module.
 *
 * The URL's fragment is the stash's id, or a notice (too large, not
 * opened). A share found, and younger than its age, goes into the form's
 * file input (prepared like a chosen photo: photo-input's preparePhoto),
 * its link and title into the hidden fields; it is shown, and Save look
 * opens SAVE_DELAY_MS after the photo is decoded and on a visible page,
 * refusing a tap that began earlier (click-gate.js), so a page cannot time
 * a tap to the moment it appears. The form's own native post to
 * POST /inspiration is the only write. Cancel deletes the share; Save marks
 * it and the look's page deletes it once the save landed (share-saved.js),
 * so a failed save keeps it. One past its age is deleted when read and
 * shown as gone, like one that is not there, as is one that cannot be
 * decoded.
 */
import { gateClicks, visibleFor } from 'click-gate';
import { preparePhoto } from 'photo-input';
import { clearSaving, markSaving } from 'share-saved';

/** How long Save stays shut once the photo is on screen. */
const SAVE_DELAY_MS = 800;

/** Shows the element for `state` (none for a ready share), hides the rest. */
function show(root, state) {
  for (const el of root.querySelectorAll('[data-share-state]')) {
    el.classList.toggle('hidden', el.dataset.shareState !== state);
  }
}

/**
 * Save look, enabled, unless the page is offline right now: then it is left
 * to the offline guard (views/assets/page/connectivity.ts), marked as one it
 * disabled, so it is enabled with the guard's others on reconnecting. The
 * guard skips a control already disabled, which this one was until now.
 */
function enable(button) {
  const connectivity = document.documentElement.dataset.connectivity;
  if (connectivity && connectivity !== 'online') {
    button.dataset.offlineDisabled = '';
    button.setAttribute('aria-disabled', 'true');
    return;
  }
  button.disabled = false;
}

/** A header the worker URI-encoded, or '' (share-target.ts). */
const decoded = (response, header) =>
  decodeURIComponent(response.headers.get(header) ?? '');

/**
 * The share stashed under `id`, as a File with its link and title, and
 * where it is kept; undefined when there is none, or it is past its age
 * (deleted then).
 */
async function readShare(root, id) {
  const {
    stashCache,
    stashKeyPrefix,
    stashMaxAgeMs,
    sharedAtHeader,
    sharedNameHeader,
    sharedUrlHeader,
    sharedTitleHeader,
  } = root.dataset;
  const cache = await caches.open(stashCache);
  const key = `${stashKeyPrefix}${encodeURIComponent(id)}`;
  const response = await cache.match(key);
  if (!response) return undefined;
  const sharedAt = Number(response.headers.get(sharedAtHeader));
  if (!(Date.now() - sharedAt < Number(stashMaxAgeMs))) {
    await cache.delete(key);
    console.info('[share] the shared photo was past its age: deleted');
    return undefined;
  }
  // The bytes copied out of the entry, so deleting it (Cancel, or the look's
  // page) cannot take the file's data with it.
  const file = new File(
    [await response.arrayBuffer()],
    decoded(response, sharedNameHeader) || 'shared-photo',
    { type: response.headers.get('Content-Type') ?? '' },
  );
  return {
    file,
    link: decoded(response, sharedUrlHeader),
    title: decoded(response, sharedTitleHeader),
    stash: { cache: stashCache, key },
    discard: () => cache.delete(key),
  };
}

/**
 * The share in the form: the photo prepared like a chosen one, shown once
 * decoded, its link and title in the hidden fields. Throws when the photo
 * cannot be read or decoded.
 */
async function fill(root, form, share) {
  const input = root.querySelector('input[type=file]');
  const transfer = new DataTransfer();
  transfer.items.add(share.file);
  input.files = transfer.files;
  const photo = await preparePhoto(input);
  const preview = root.querySelector('[data-share-preview]');
  preview.src = URL.createObjectURL(photo);
  await preview.decode();
  form.elements.namedItem('url').value = share.link;
  form.elements.namedItem('title').value = share.title.slice(
    0,
    Number(root.dataset.titleMax),
  );
  if (share.link) {
    root.querySelector('[data-share-link-text]').textContent = share.link;
    root.querySelector('[data-share-link]').classList.remove('hidden');
  }
  preview.classList.remove('hidden');
  return photo;
}

/** @param {HTMLElement | null} root the page's #share-confirm */
export async function confirmShare(root) {
  if (!root) return;
  clearSaving();
  const id = location.hash.slice(1);
  if (id && root.dataset.notices.split(' ').includes(id)) {
    show(root, id);
    console.info(`[share] notice: ${id}`);
    return;
  }
  const form = root.closest('form');
  const button = form.querySelector('button[type=submit]');
  const open = gateClicks(form, button);
  let share;
  let photo;
  try {
    if (id && 'caches' in window) share = await readShare(root, id);
    if (share) photo = await fill(root, form, share);
  } catch (err) {
    console.warn('[share] could not open the shared photo', err);
    share = undefined;
  }
  if (!share) {
    root.querySelector('[data-share-preview]').classList.add('hidden');
    show(root, 'missing');
    console.info('[share] no shared photo to confirm');
    return;
  }
  show(root, 'ready');
  form.addEventListener('submit', (event) => {
    if (!event.defaultPrevented) markSaving(share.stash);
  });
  form
    .querySelector('[data-history-back]')
    ?.addEventListener('click', () => void share.discard());
  await visibleFor(document, SAVE_DELAY_MS);
  open();
  enable(button);
  console.info(`[share] shared photo ready to save (${photo.size} B)`);
}
