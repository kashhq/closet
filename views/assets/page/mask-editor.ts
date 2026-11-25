/**
 * The mask editor: touching up a garment's stored cutout by hand. Erase
 * paints transparency; Restore paints the original photo back. The pencil
 * on the garment photo (EditMaskButton, garment-photo.tsx) opens it and
 * the edited cutout replaces the stored one (POST /wardrobe/:id/nobg); no
 * model runs here.
 *
 * The garment page binds it from an inline module (MASK_SCRIPT,
 * garment-page.tsx), so a boosted navigation back to the page binds it
 * again: on #garment-photo-slot, never the document, since the cutout's
 * polling swaps the pencil and the photo under it.
 */

import { openSheet } from 'confirm-sheet';
import {
  EDIT_MASK_ID,
  MASK_CUTOUT_URL,
  MASK_EDITOR_IDS,
  MASK_ORIGINAL_URL,
  MASK_SAVE_URL,
} from '../../../src/web/page-contract';

type Brush = 'erase' | 'restore';

/** What the save answers: the photo's new signed URLs (imageUrl). */
interface SavedPhoto {
  originalUrl: string;
  nobgUrl: string;
}

async function fetchBitmap(url: string): Promise<ImageBitmap> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
  return createImageBitmap(await response.blob());
}

/**
 * The original laid out as the cutout is: every stored cutout is the
 * original centred on a transparent square (Photos composeCutout), so the
 * original is placed the same way, scaled to the cutout's pixels, for the
 * restore brush to paint back exactly what was there.
 */
function alignOriginal(
  original: ImageBitmap,
  width: number,
  height: number,
): OffscreenCanvas {
  const side = Math.max(original.width, original.height);
  const scaleX = width / side;
  const scaleY = height / side;
  const aligned = new OffscreenCanvas(width, height);
  aligned
    .getContext('2d')!
    .drawImage(
      original,
      Math.floor((side - original.width) / 2) * scaleX,
      Math.floor((side - original.height) / 2) * scaleY,
      original.width * scaleX,
      original.height * scaleY,
    );
  return aligned;
}

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`#${id} is missing`);
  return element;
}

/**
 * One opening of the editor over `cutout`. Resolves with the edited cutout
 * on Accept, or null when the editor is left any other way (Skip, Close,
 * the backdrop, Escape): nothing is saved then. Rejects when Accept cannot
 * encode the canvas, so a lost edit is a failure, never a silent close.
 */
function editCutout(
  cutout: ImageBitmap,
  original: ImageBitmap,
): Promise<Blob | null> {
  const dialog = byId(MASK_EDITOR_IDS.dialog, HTMLDialogElement);
  const canvas = byId(MASK_EDITOR_IDS.canvas, HTMLCanvasElement);
  const eraseButton = byId(MASK_EDITOR_IDS.erase, HTMLButtonElement);
  const restoreButton = byId(MASK_EDITOR_IDS.restore, HTMLButtonElement);
  const sizeInput = byId(MASK_EDITOR_IDS.size, HTMLInputElement);
  const acceptButton = byId(MASK_EDITOR_IDS.accept, HTMLButtonElement);
  const skipButton = byId(MASK_EDITOR_IDS.skip, HTMLButtonElement);

  canvas.width = cutout.width;
  canvas.height = cutout.height;
  const context = canvas.getContext('2d')!;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(cutout, 0, 0);
  const source = alignOriginal(original, canvas.width, canvas.height);

  let brush: Brush = 'erase';
  // The stroke under way: the one pointer that owns it (a second finger is
  // ignored until it ends, or its moves would paint a streak between the two)
  // and where it last painted, in canvas pixels.
  let stroke: {
    pointerId: number;
    last: { x: number; y: number } | null;
  } | null = null;

  const selectBrush = (next: Brush) => {
    brush = next;
    eraseButton.classList.toggle('btn-active', next === 'erase');
    restoreButton.classList.toggle('btn-active', next === 'restore');
    eraseButton.setAttribute('aria-pressed', String(next === 'erase'));
    restoreButton.setAttribute('aria-pressed', String(next === 'restore'));
  };
  selectBrush('erase');

  /**
   * Paints from the stroke's last point to the pointer: discs a third of a
   * radius apart, so a fast stroke leaves no gaps. The size is in screen
   * pixels, the canvas drawn smaller or larger than its own.
   */
  const paintTo = (active: NonNullable<typeof stroke>, event: PointerEvent) => {
    const box = canvas.getBoundingClientRect();
    const scaleX = canvas.width / box.width;
    const scaleY = canvas.height / box.height;
    const point = {
      x: (event.clientX - box.left) * scaleX,
      y: (event.clientY - box.top) * scaleY,
    };
    const radius = Number(sizeInput.value) * scaleX;
    const from = active.last ?? point;
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(point.x - from.x, point.y - from.y) / (radius / 3)),
    );
    const stroke = new Path2D();
    for (let step = active.last ? 1 : 0; step <= steps; step += 1) {
      const x = from.x + ((point.x - from.x) * step) / steps;
      const y = from.y + ((point.y - from.y) * step) / steps;
      stroke.moveTo(x + radius, y);
      stroke.arc(x, y, radius, 0, Math.PI * 2);
    }
    context.save();
    if (brush === 'erase') {
      context.globalCompositeOperation = 'destination-out';
      context.fill(stroke);
    } else {
      context.clip(stroke);
      context.drawImage(source, 0, 0);
    }
    context.restore();
    active.last = point;
  };

  const startStroke = (event: PointerEvent) => {
    if (event.button !== 0 || stroke) return;
    canvas.setPointerCapture(event.pointerId);
    stroke = { pointerId: event.pointerId, last: null };
    paintTo(stroke, event);
  };
  const continueStroke = (event: PointerEvent) => {
    if (stroke?.pointerId === event.pointerId) paintTo(stroke, event);
  };
  const endStroke = (event: PointerEvent) => {
    if (stroke?.pointerId === event.pointerId) stroke = null;
  };

  const listeners = new AbortController();
  const { signal } = listeners;
  canvas.addEventListener('pointerdown', startStroke, { signal });
  canvas.addEventListener('pointermove', continueStroke, { signal });
  canvas.addEventListener('pointerup', endStroke, { signal });
  canvas.addEventListener('pointercancel', endStroke, { signal });
  canvas.addEventListener('lostpointercapture', endStroke, { signal });
  eraseButton.addEventListener('click', () => selectBrush('erase'), { signal });
  restoreButton.addEventListener('click', () => selectBrush('restore'), {
    signal,
  });

  return new Promise((resolve, reject) => {
    let accepted = false;
    acceptButton.addEventListener(
      'click',
      () => {
        accepted = true;
        dialog.close();
      },
      { signal },
    );
    skipButton.addEventListener('click', () => dialog.close(), { signal });
    // Every way out closes the dialog, so this is the one place it ends.
    dialog.addEventListener(
      'close',
      () => {
        listeners.abort();
        if (!accepted) {
          resolve(null);
          return;
        }
        canvas.toBlob(
          (edited) =>
            edited
              ? resolve(edited)
              : reject(new Error('the canvas has no image')),
          'image/webp',
          0.92,
        );
      },
      { signal },
    );
    openSheet(dialog, null);
  });
}

async function saveCutout(saveUrl: string, edited: Blob): Promise<SavedPhoto> {
  const body = new FormData();
  // WebP, or PNG where the browser cannot encode WebP: the server decodes
  // the bytes, whatever they are named.
  body.append('nobgPhoto', edited, 'cutout');
  const response = await fetch(saveUrl, { method: 'POST', body });
  if (!response.ok) throw new Error(`POST ${saveUrl}: ${response.status}`);
  return (await response.json()) as SavedPhoto;
}

/**
 * Every /file URL is immutable and signed over all its parameters, so the
 * pencil and the photo take the URLs the save answered, never one built or
 * rewritten here.
 */
async function editFrom(pencil: HTMLButtonElement) {
  const originalUrl = pencil.getAttribute(MASK_ORIGINAL_URL);
  const cutoutUrl = pencil.getAttribute(MASK_CUTOUT_URL);
  const saveUrl = pencil.getAttribute(MASK_SAVE_URL);
  if (!originalUrl || !cutoutUrl || !saveUrl) {
    throw new Error('the pencil names no photo');
  }
  const [originalResult, cutoutResult] = await Promise.allSettled([
    fetchBitmap(originalUrl),
    fetchBitmap(cutoutUrl),
  ]);
  if (originalResult.status === 'rejected') {
    if (cutoutResult.status === 'fulfilled') cutoutResult.value.close();
    throw originalResult.reason;
  }
  if (cutoutResult.status === 'rejected') {
    originalResult.value.close();
    throw cutoutResult.reason;
  }
  const original = originalResult.value;
  const cutout = cutoutResult.value;
  let edited: Blob | null;
  try {
    edited = await editCutout(cutout, original);
  } finally {
    original.close();
    cutout.close();
  }
  if (!edited) {
    console.info('[mask-editor] closed without saving');
    return;
  }
  const saved = await saveCutout(saveUrl, edited);
  pencil.setAttribute(MASK_ORIGINAL_URL, saved.originalUrl);
  pencil.setAttribute(MASK_CUTOUT_URL, saved.nobgUrl);
  const photo = pencil.closest('figure')?.querySelector('img');
  if (photo) photo.src = saved.nobgUrl;
  console.info('[mask-editor] edited cutout saved');
}

/** Binds the pencil inside `slot` (#garment-photo-slot), whatever replaces it. */
export function bindMaskEditor(slot: HTMLElement | null) {
  slot?.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const pencil = event.target.closest(`#${EDIT_MASK_ID}`);
    if (!(pencil instanceof HTMLButtonElement) || pencil.disabled) return;
    pencil.disabled = true;
    editFrom(pencil)
      .catch((error: unknown) => {
        console.warn('[mask-editor] the edit failed', error);
      })
      .finally(() => {
        pencil.disabled = false;
      });
  });
}
