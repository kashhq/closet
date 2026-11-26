import { test as base } from './fixtures';
import { CUTOUT_STUB_ORIGIN } from './cutout-stub';

/**
 * Holding a cutout pending, for a spec that shows "Cutting out the background…"
 * (the stub's control, cutout-stub.ts). Only the test server has it: a
 * reused start:dev or start:prod server runs the real model and refuses the
 * connection, which fails the spec rather than letting it race the model.
 */
export interface CutoutHolds {
  /**
   * Keeps every cutout of `email`'s photos pending until release(). Call it
   * before the upload; the queue waits behind a held job, so release as
   * soon as the pending page is seen.
   */
  hold(email: string): Promise<void>;
  release(email: string): Promise<void>;
}

/** Playwright's `test` with `cutouts`, which releases whatever the test left held. */
export const test = base.extend<{ cutouts: CutoutHolds }>({
  cutouts: async ({ request }, use) => {
    const held = new Set<string>();
    const control = async (method: 'PUT' | 'DELETE', email: string) => {
      const response = await request.fetch(
        `${CUTOUT_STUB_ORIGIN}/holds/${encodeURIComponent(email)}`,
        { method },
      );
      if (response.status() !== 204) {
        throw new Error(
          `The cutout stub answered ${method} ${email} with ${response.status()}`,
        );
      }
    };
    await use({
      async hold(email) {
        await control('PUT', email);
        held.add(email);
      },
      async release(email) {
        held.delete(email);
        await control('DELETE', email);
      },
    });
    for (const email of held) await control('DELETE', email);
  },
});
