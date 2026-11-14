import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOCK_TABS, SECTION_HOME } from '../../src/web/layout/sections';
import { createTestApp, type TestApp } from './harness';

/**
 * The desktop left rail (#309) is the dock's own markup, restyled by CSS at
 * lg (views/assets/main.css). The server cannot know the viewport and the
 * tab roots are served stale-while-revalidate, so a tab root must be the
 * same bytes whatever asks for it, with one dock and no second navigation.
 */
describe('the left rail', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  const get = (url: string, headers: Record<string, string> = {}) =>
    t.inject({ method: 'GET', url, headers });

  const PHONE = {
    'user-agent':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    'sec-ch-ua-mobile': '?1',
    'viewport-width': '390',
  };
  const DESKTOP = {
    'user-agent':
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
    'sec-ch-ua-mobile': '?0',
    'viewport-width': '1440',
  };

  const tabRoots = DOCK_TABS.map((section) => SECTION_HOME[section]);

  it.each(tabRoots)(
    '%s: one dock, the rail and the dock are it',
    async (url) => {
      const { body, statusCode } = await get(url);
      expect(statusCode).toBe(200);
      expect(body.match(/class="dock"/g)).toHaveLength(1);
      expect(body).toMatch(/<nav class="dock" aria-label="Main">/);
      const dock = body.slice(body.indexOf('class="dock"'));
      const hrefs = [...dock.matchAll(/<a [^>]*href="([^"]+)"/g)]
        .slice(0, DOCK_TABS.length)
        .map((match) => match[1]);
      expect(hrefs).toEqual(tabRoots);
      // Exactly one dock tab is the current page (the page's own section
      // tabs carry theirs, #726), and no second navigation exists for the rail.
      expect(dock.match(/aria-current="page"/g)).toHaveLength(1);
      expect(body).not.toMatch(/class="([^"]* )?rail[ "]/);
      // The page's own column comes from the layout's width tokens.
      expect(body).toMatch(
        /<main [^>]*class="[^"]*\bmax-w-page-(narrow|wide)\b/,
      );
      expect(body).not.toMatch(/<main [^>]*\bmax-w-lg\b/);
    },
  );

  it.each(tabRoots)(
    '%s: the same bytes for a phone and a desktop',
    async (url) => {
      const phone = await get(url, PHONE);
      const desktop = await get(url, DESKTOP);
      const again = await get(url, PHONE);
      expect(desktop.body).toBe(phone.body);
      expect(again.body).toBe(phone.body);
    },
  );
});
