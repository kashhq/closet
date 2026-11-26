import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EDIT_MASK_ID, MASK_EDITOR_IDS } from '../../../src/web/page-contract';
import {
  bundlePageModule,
  closePage,
  mountPage,
  type MountedPage,
} from '../../../test/support/page-module-browser';

/**
 * The mask editor in a real Chromium page (run by `npm run test:audit-browser`,
 * make ci-e2e): every way out of the dialog (Skip, the backdrop, Escape) must
 * enable the pencil again, an Accept whose canvas cannot encode is a failure,
 * never a silent close, and the brush paints the pixels it should (#1228) from
 * one finger at a time (#1227). The module is bundled from source as the page
 * build does; the markup is the shape of garment-page.tsx's MaskEditorDialog
 * and garment-photo.tsx's pencil; the stored photos and the save are routed.
 */

const ORIGIN = 'https://closet.test';
const SAVE_URL = `${ORIGIN}/wardrobe/1/nobg`;
const ORIGINAL_URL = `${ORIGIN}/file/original`;
const CUTOUT_URL = `${ORIGIN}/file/nobg`;

/** A stored photo the fake server draws: solid `fill`, or transparent without one. */
interface FakePhoto {
  width: number;
  height: number;
  fill?: string;
}

/**
 * Runs in the page: the stored photos are drawn as `photos` says (one black
 * pixel for any other URL) and the save answers the new URLs, so no server is
 * needed (a function, so the browser gets it serialised; it closes over nothing).
 */
function fakeServer(fake: {
  saveUrl: string;
  saved: unknown;
  photos: Record<string, FakePhoto>;
}) {
  window.fetch = async (input, init) => {
    const url = String(input);
    if (url === fake.saveUrl && init?.method === 'POST') {
      return Response.json(fake.saved);
    }
    const photo = fake.photos[url] ?? { width: 1, height: 1, fill: 'black' };
    const canvas = new OffscreenCanvas(photo.width, photo.height);
    // A canvas with no context cannot be encoded, even when left transparent.
    const context = canvas.getContext('2d')!;
    if (photo.fill) {
      context.fillStyle = photo.fill;
      context.fillRect(0, 0, photo.width, photo.height);
    }
    return new Response(await canvas.convertToBlob({ type: 'image/png' }));
  };
}

const ids = MASK_EDITOR_IDS;
// The canvas is shown at half its pixels (40 px for an 80 px cutout), so a
// screen offset is half a canvas one; touch-action none is the page's touch-none.
const CANVAS_STYLE = 'display:block;width:40px;height:40px;touch-action:none';
const MARKUP = `
  <div id="garment-photo-slot"><figure>
    <img alt="">
    <button id="${EDIT_MASK_ID}" type="button"
      data-original-url="${ORIGINAL_URL}" data-nobg-url="${CUTOUT_URL}"
      data-save-url="${SAVE_URL}">Edit</button>
  </figure></div>
  <dialog id="${ids.dialog}" data-sheet="dialog" aria-label="Edit cutout">
    <div class="modal-box">
      <button id="${ids.erase}" type="button" aria-pressed="true">Erase</button>
      <button id="${ids.restore}" type="button" aria-pressed="false">Restore</button>
      <input id="${ids.size}" type="range" min="4" max="80" value="10">
      <canvas id="${ids.canvas}" style="${CANVAS_STYLE}"></canvas>
      <button id="${ids.skip}" type="button">Skip</button>
      <button id="${ids.accept}" type="button">Accept</button>
    </div>
    <form method="dialog" class="modal-backdrop"><button id="backdrop">Close</button></form>
  </dialog>`;

let browser: Browser;
let bundle: string;

beforeAll(async () => {
  bundle = await bundlePageModule(
    "import { bindMaskEditor } from './views/assets/page/mask-editor.ts'; bindMaskEditor(document.getElementById('garment-photo-slot'));",
  );
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

function mounted(
  photos: Record<string, FakePhoto> = {},
  hasTouch = false,
): Promise<MountedPage> {
  return mountPage(browser, {
    markup: MARKUP,
    bundle,
    hasTouch,
    prepare: (page) =>
      page.evaluate(fakeServer, {
        saveUrl: SAVE_URL,
        saved: {
          originalUrl: `${ORIGIN}/file/original2`,
          nobgUrl: `${ORIGIN}/file/nobg2`,
        },
        photos,
      }),
  });
}

async function openEditor(page: Page) {
  await page.click(`#${EDIT_MASK_ID}`);
  await page.waitForSelector(`#${ids.dialog}[open]`);
  expect(await page.isDisabled(`#${EDIT_MASK_ID}`)).toBe(true);
}

async function pencilEnabled(page: Page) {
  await expect
    .poll(() => page.isEnabled(`#${EDIT_MASK_ID}`), { timeout: 5000 })
    .toBe(true);
}

/** The editor open over `photos`, and where its canvas sits on screen. */
async function openOver(photos: Record<string, FakePhoto>, hasTouch = false) {
  const mount = await mounted(photos, hasTouch);
  await openEditor(mount.page);
  const box = await mount.page.locator(`#${ids.canvas}`).boundingBox();
  if (!box) throw new Error('the canvas has no box');
  expect(box.width).toBe(40);
  return { ...mount, box };
}

/** The RGBA of each canvas pixel. */
function pixelsAt(page: Page, points: [number, number][]) {
  return page.evaluate(
    ({ id, points }) => {
      const canvas = document.getElementById(id) as HTMLCanvasElement;
      const context = canvas.getContext('2d')!;
      return points.map(
        ([x, y]) => [...context.getImageData(x, y, 1, 1).data] as number[],
      );
    },
    { id: ids.canvas, points },
  );
}

const alphas = (pixels: number[][]) => pixels.map((pixel) => pixel[3]);

const GREEN_CUTOUT = {
  [CUTOUT_URL]: { width: 80, height: 80, fill: 'rgb(0, 128, 0)' },
};

describe('the mask editor', () => {
  const ways: [string, (page: Page) => Promise<void>][] = [
    ['Skip', (page) => page.click(`#${ids.skip}`)],
    ['the backdrop', (page) => page.click('#backdrop')],
    ['Escape', (page) => page.keyboard.press('Escape')],
  ];

  it.each(ways)(
    'enables the pencil again when closed by %s',
    async (_, close) => {
      const { page, warnings } = await mounted();
      try {
        await openEditor(page);
        await close(page);
        await pencilEnabled(page);
        expect(
          await page.evaluate(
            (id) => document.getElementById(id)?.hasAttribute('open'),
            ids.dialog,
          ),
        ).toBe(false);
        expect(warnings).toEqual([]);
      } finally {
        await closePage(page);
      }
    },
  );

  it('saves on Accept and enables the pencil with the new URLs', async () => {
    const { page } = await mounted();
    try {
      await openEditor(page);
      await page.click(`#${ids.accept}`);
      await pencilEnabled(page);
      expect(await page.getAttribute(`#${EDIT_MASK_ID}`, 'data-nobg-url')).toBe(
        `${ORIGIN}/file/nobg2`,
      );
    } finally {
      await closePage(page);
    }
  });

  it('takes the failure path, not a silent close, when Accept cannot encode', async () => {
    const { page, warnings } = await mounted();
    try {
      await page.evaluate(() => {
        HTMLCanvasElement.prototype.toBlob = (callback) => callback(null);
      });
      await openEditor(page);
      await page.click(`#${ids.accept}`);
      await pencilEnabled(page);
      expect(warnings.some((w) => w.includes('the edit failed'))).toBe(true);
      expect(await page.getAttribute(`#${EDIT_MASK_ID}`, 'data-nobg-url')).toBe(
        `${ORIGIN}/file/nobg`,
      );
    } finally {
      await closePage(page);
    }
  });
});

// Size 10 screen px on a canvas drawn at half its pixels: a 20 canvas px radius.
describe('the brush', () => {
  it('erases a disc of the screen radius, scaled to the canvas, and no more', async () => {
    const { page, box } = await openOver(GREEN_CUTOUT);
    try {
      await page.mouse.move(box.x + 20, box.y + 20);
      await page.mouse.down();
      await page.mouse.up();
      expect(
        alphas(
          await pixelsAt(page, [
            [40, 40], // the centre
            [40, 55], // 15 canvas px out, inside the radius
            [40, 65], // 25 out
            [10, 10],
          ]),
        ),
      ).toEqual([0, 0, 255, 255]);
    } finally {
      await closePage(page);
    }
  });

  it('leaves no gap along a fast stroke', async () => {
    const { page, box } = await openOver(GREEN_CUTOUT);
    try {
      await page.mouse.move(box.x + 5, box.y + 20);
      await page.mouse.down();
      await page.mouse.move(box.x + 35, box.y + 20); // one event, 60 canvas px
      await page.mouse.up();
      const along = [10, 20, 30, 40, 50, 60, 70].map((x): [number, number] => [
        x,
        40,
      ]);
      expect(alphas(await pixelsAt(page, along))).toEqual(along.map(() => 0));
      expect(alphas(await pixelsAt(page, [[40, 70]]))).toEqual([255]);
    } finally {
      await closePage(page);
    }
  });

  it('restores the original where it lies on the centred square, and only there', async () => {
    // A 40 x 20 original on an 80 px cutout: it fills the band y 20..60.
    const { page, box } = await openOver({
      [CUTOUT_URL]: { width: 80, height: 80 },
      [ORIGINAL_URL]: { width: 40, height: 20, fill: 'rgb(255, 0, 0)' },
    });
    try {
      await page.click(`#${ids.restore}`);
      await page.mouse.move(box.x + 20, box.y + 12); // canvas (40, 24)
      await page.mouse.down();
      await page.mouse.up();
      const pixels = await pixelsAt(page, [
        [40, 24], // centre, in the band
        [40, 30], // in the band, inside the radius
        [40, 10], // inside the radius, above the band
        [65, 24], // in the band, 25 out
      ]);
      expect(pixels[0]).toEqual([255, 0, 0, 255]);
      expect(pixels[1]).toEqual([255, 0, 0, 255]);
      expect(alphas(pixels).slice(2)).toEqual([0, 0]);
    } finally {
      await closePage(page);
    }
  });

  describe('with two fingers', () => {
    // One CDP session: the browser's touch state belongs to it.
    const touchOn = async (page: Page) => {
      const session = await page.context().newCDPSession(page);
      return (
        type: 'touchStart' | 'touchMove' | 'touchEnd',
        touchPoints: { id: number; x: number; y: number }[],
      ) => session.send('Input.dispatchTouchEvent', { type, touchPoints });
    };

    it('paints under the first finger only, never a streak between the two', async () => {
      const { page, box } = await openOver(GREEN_CUTOUT, true);
      try {
        const a = { id: 1, x: box.x + 5, y: box.y + 20 };
        const b = { id: 2, x: box.x + 35, y: box.y + 20 };
        const touch = await touchOn(page);
        await touch('touchStart', [a]);
        await touch('touchStart', [a, b]);
        // Each finger drifts in turn, as in an attempted pinch.
        const a2 = { ...a, x: a.x + 1 };
        await touch('touchMove', [a2, b]);
        await touch('touchMove', [a2, { ...b, x: b.x - 1 }]);
        await touch('touchEnd', []);
        expect(
          alphas(
            await pixelsAt(page, [
              [12, 40], // under finger A
              [40, 40], // midway between the fingers
              [68, 40], // under finger B
            ]),
          ),
        ).toEqual([0, 255, 255]);
      } finally {
        await closePage(page);
      }
    });
  });
});
