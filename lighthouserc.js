// Lighthouse CI over the root signed out, which lands on the login page
// (npm run lighthouse; the nightly, .github/workflows/nightly.yml). Every
// other page is the page audit's (npm run audit:pages), which runs axe.

/** One run against the test server: background removal stubbed, so no model download. */
const collect = {
  startServerCommand: 'npm run start:test',
  // Fastify logs this once listen() resolves (src/server.ts).
  startServerReadyPattern: 'Server listening at',
  url: ['http://localhost:3000/'],
  numberOfRuns: 1,
  // The nightly's container has no sandbox and a small /dev/shm.
  settings: { chromeFlags: '--no-sandbox --disable-dev-shm-usage' },
};

// Reported, never failing the run: insights about bundling and delivery
// that a server-rendered page with a handful of scripts cannot act on,
// and `redirects`, which has no score to hold a minimum to (it answers
// "not applicable"). Lighthouse 13 folded render-blocking-resources and
// third-party-facades into render-blocking-insight (here) and
// third-parties-insight (off in the preset), and dropped font-size.
const REPORTED = [
  'document-latency-insight',
  'forced-reflow-insight',
  'image-delivery-insight',
  'network-dependency-tree-insight',
  'render-blocking-insight',
  'unminified-javascript',
  'unused-css-rules',
  'unused-javascript',
  'redirects',
];

const assert = {
  preset: 'lighthouse:recommended',
  assertions: {
    ...Object.fromEntries(REPORTED.map((audit) => [audit, 'warn'])),
    // Failing since #722; the page audit's axe pass covers the other pages.
    'color-contrast': 'error',
    // robots.txt shuts every crawler out on purpose: a private app.
    'is-crawlable': 'off',
  },
};

// Kept on disk and uploaded by nightly.yml as an artifact: no public
// report URL, no request leaves the runner.
const upload = { target: 'filesystem', outputDir: 'scripts/results/lighthouse' };

module.exports = { ci: { collect, assert, upload } };
