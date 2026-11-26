# Cutouts in the Playwright specs

The test server (`npm run start:test`, `test/support/test-server.ts`) runs
the real cutout queue with a stand-in for the model,
`test/support/cutout-stub.ts`. An upload goes pending as in production; the
stub cuts out an ellipse of the photo.

## Why the stub answers at once

The queue runs one photo at a time for the whole server
(`src/cutout/AGENTS.md`), and every Playwright worker shares that server. The
stub used to take 3 s a photo, so a spec's cutout waited 3 s for every photo
the other workers had queued before it: with four workers uploading, or a
database left with pending rows, a cutout took longer than the spec's 15 s
wait (#230: `pwa.spec.ts`'s "never requests a model or WASM" failed 6 runs in
10; `mask-editor.spec.ts` (retired 2026-10-13) timed out whenever other specs uploaded). Answering
at once makes a spec's cutout depend only on the queue's own work, a few ms a
photo.

## Holding a cutout pending

A spec that asserts the pending state ("Cutting out the background…", the photo at
version 1 and unkeyed, no pencil) holds it instead of racing the queue:

```ts
import { test } from './support/cutout-hold';

test('…', async ({ page, cutouts }) => {
  const email = await signIn(page, 'prefix');
  await cutouts.hold(email); // before the upload
  // … upload, assert the pending page …
  await cutouts.release(email); // then the page's poll swaps the cutout in
});
```

- The hold is per owner: every cutout of that account's photos stays inside
  the stub's `mask()` until released. The stub finds the owner through the
  row the queue has leased under this process's worker id.
- The control is a small HTTP server on `127.0.0.1`, `PORT + 20000`
  (`CUTOUT_STUB_PORT`): `PUT /holds/<email>` and `DELETE /holds/<email>`.
  A reused `start:dev` or `start:prod` server (the real model) has none, and
  a spec that holds fails on the refused connection.
- **The queue waits behind a held job**, so release as soon as the spec has
  seen what it needs. The `cutouts` fixture releases whatever a test left
  held, failed or not, and the stub drops a hold after 20 s (a worker that
  died) with a warning.
- The stub logs every hold, held job and release under the `CutoutStub`
  context.

Holding: `cutout.spec.ts` (retired 2026-10-13), `add-from-photo.spec.ts`, `image-variants.spec.ts` (retired 2026-10-13)
(version 1 in the grid) and `screenshots.spec.ts` (the pending shot).

## Waiting for a cutout

A spec that needs the cutout waits for the page to show it (the photo's src
at `?v=2`, which the page's 2 s poll swaps in), never a sleep. A spec that
compares photos across a change compares the stored photo's name, not the
src: the cutout can swap the src at any moment.

A write that checks the photo's version refuses to race a cutout landing: a
rotate that arrives while a job saves its result is a 409, "The photo
changed meanwhile" (`rotateGarmentPhoto`). So `photo-rotate.spec.ts` waits
for each photo's cutout before it taps ↻ again; with the stub answering at
once, tapping straight away hit that 409 in 2 runs of 225.
