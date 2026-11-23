import { expect, type Page } from '@playwright/test';
import { tapMisses } from './tap-area';

/**
 * The phone's sizing rules (#636; views/assets/main.css, Touch sizing and
 * Touch hit areas) as the browser computes them on the page on screen. A
 * scenario at 390 px with `hasTouch` (Chromium then matches
 * `pointer: coarse`) calls these on the pages it visits, so a new page
 * there inherits them.
 */

/** The inputs a tap types into: iOS zooms the page into one under 16 px. */
const TEXT_FIELDS =
  'input:not([type="checkbox"], [type="radio"], [type="range"], [type="file"], [type="color"], [type="button"], [type="submit"], [type="reset"], [type="image"], [type="hidden"]), select, textarea';

/** What a tap can activate. */
const CONTROLS =
  'a[href], button, summary, input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"]';

/** Apple's minimum and WCAG 2.5.5's: 44 CSS px each way. */
export const MIN_TARGET_PX = 44;

/** Every visible text field's computed font size is at least 16 px. */
export async function expectNoZoomingFields(page: Page): Promise<void> {
  const small = await page.locator(TEXT_FIELDS).evaluateAll((fields) =>
    fields
      .filter((field) => field.checkVisibility({ visibilityProperty: true }))
      .map((field) => ({
        field: `${field.tagName.toLowerCase()}[name=${field.getAttribute('name')}]`,
        size: parseFloat(getComputedStyle(field).fontSize),
      }))
      .filter(({ size }) => size < 16),
  );
  expect(small, `fields under 16 px on ${page.url()}`).toEqual([]);
}

/**
 * Every visible control takes a fingertip MIN_TARGET_PX across: tapMisses
 * (tap-area.ts, the page audit's measure too) hit tests a disc on each, so
 * the theme's hit areas and labels count, and an ancestor's clipping or a
 * neighbour's area over it counts against.
 */
export async function expectTouchTargets(page: Page): Promise<void> {
  await page.evaluate(`window.closetTapMisses = ${String(tapMisses)}`);
  const small = await page.locator(CONTROLS).evaluateAll((controls, min) => {
    const shown = controls.filter((el) =>
      el.checkVisibility({ visibilityProperty: true }),
    );
    const misses = (
      window as unknown as { closetTapMisses: typeof tapMisses }
    ).closetTapMisses(shown, min);
    const name = (el: Element) =>
      (
        el.getAttribute('aria-label') ??
        el.textContent?.trim().replace(/\s+/g, ' ') ??
        ''
      ).slice(0, 40);
    return shown.flatMap((el, i) => {
      const miss = misses[i];
      if (!miss) return [];
      const hit = miss.hit ? miss.hit.tagName.toLowerCase() : 'nothing';
      return [
        {
          control: `${el.tagName.toLowerCase()} "${name(el)}"`,
          size: `${miss.width} × ${miss.height}`,
          missed: `(${miss.dx}, ${miss.dy}) lands on ${hit}`,
        },
      ];
    });
  }, MIN_TARGET_PX);
  expect(small, `controls under ${MIN_TARGET_PX} px on ${page.url()}`).toEqual(
    [],
  );
}
