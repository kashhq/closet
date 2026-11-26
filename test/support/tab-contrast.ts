import { type Page } from '@playwright/test';
import { expect } from './fixtures';

/** WCAG AA for normal text; section tabs are small text. */
const AA = 4.5;

/**
 * Every inactive section tab on the page against what it sits on, in the
 * theme the page is in (#726). Colours are resolved through a canvas, so
 * `color-mix()` (the muted token) and oklch values reach one rgba form; the
 * tab's own alpha is composited over the first opaque ancestor background.
 */
export async function expectReadableTabs(page: Page): Promise<void> {
  const ratios = await page.evaluate(() => {
    const context = document.createElement('canvas').getContext('2d')!;
    const rgba = (css: string): number[] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = '#000';
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const luminance = ([r, g, b]: number[]) => {
      const [lr, lg, lb] = [r, g, b].map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    };
    const backdrop = (element: Element): number[] => {
      for (
        let node: Element | null = element;
        node;
        node = node.parentElement
      ) {
        const colour = rgba(getComputedStyle(node).backgroundColor);
        if (colour[3] === 255) return colour;
      }
      return [255, 255, 255, 255];
    };
    return [...document.querySelectorAll('nav.tabs a.tab')]
      .filter((tab) => tab.getAttribute('aria-current') !== 'page')
      .map((tab) => {
        const back = backdrop(tab);
        const [r, g, b, a] = rgba(getComputedStyle(tab).color);
        const front = [r, g, b].map(
          (v, i) => (v * a) / 255 + back[i] * (1 - a / 255),
        );
        const [light, dark] = [luminance(front), luminance(back)].sort(
          (x, y) => y - x,
        );
        return {
          label: tab.textContent,
          ratio: (light + 0.05) / (dark + 0.05),
        };
      });
  });
  expect(ratios.length).toBeGreaterThan(0);
  for (const { label, ratio } of ratios) {
    expect(ratio, `inactive tab "${label}"`).toBeGreaterThanOrEqual(AA);
  }
}
