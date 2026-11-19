module.exports = {
  ci: {
    collect: {
      // The build with background removal stubbed: no model download.
      startServerCommand: 'npm run start:test',
      // Fastify's own line once listen() resolves (src/server.ts).
      startServerReadyPattern: 'Server listening at',
      url: ['http://localhost:3000'],
      numberOfRuns: 1,
      settings: {
        chromeFlags: '--no-sandbox --disable-dev-shm-usage',
      },
    },
    assert: {
      // https://googlechrome.github.io/lighthouse-ci/docs/configuration.html#preset
      preset: 'lighthouse:recommended',
      assertions: {
        // Relax or disable frontend-specific checks for backend APIs
        'network-dependency-tree-insight': 'warn',
        'unminified-javascript': 'warn',
        'unused-javascript': 'warn',
        'forced-reflow-insight': 'warn',
        'document-latency-insight': 'warn',
        // Assertions not be necessary
        'unused-css-rules': 'warn',
        'render-blocking-insight': 'warn',
        'image-delivery-insight': 'warn',
        // Lighthouse 13 dropped the font-size, render-blocking-resources and
        // third-party-facades audits (the last two became render-blocking-insight,
        // already warned above, and third-parties-insight, which the preset turns off).
        // An error since #722; the page audit's axe pass checks every other page.
        'color-contrast': 'error',
        // robots.txt disallows everything on purpose (private app, no landing page)
        'is-crawlable': 'off',
        // These audits return null (not applicable) and cannot use minScore
        redirects: 'warn',
      },
    },
    upload: {
      // Local files, uploaded by nightly.yml: no public URL, no external request.
      target: 'filesystem',
      outputDir: 'scripts/results/lighthouse',
    },
  },
};
