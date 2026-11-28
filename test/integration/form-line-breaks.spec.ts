import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garmentRepair, styleProfile } from '../../src/db/schema';
import { STYLE_NOTES_MAX } from '../../src/web/style/validation';
import { CARE_NOTE_MAX } from '../../src/web/wardrobe/garment-input';
import { createGarment } from './garments';
import { createTestApp, OWNER_EMAIL, type TestApp, userIdOf } from './harness';

/**
 * A textarea's `maxlength` counts a line break once, the browser posts it as
 * CRLF (#1318): every page form's text reaches its schema as LF
 * (src/web/form-body.ts), so a note at its limit is accepted and stored with
 * LF. Two unrelated forms stand for all; the requests ask is
 * agent-requests.spec.ts's.
 */
describe('a multi-line value at its limit', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  /** `length` characters of lines of 9, CRLF as a browser posts them. */
  const crlfText = (length: number) => {
    const lf = Array.from({ length }, (_, i) =>
      i + 1 < length && (i + 1) % 10 === 0 ? '\n' : 'a',
    )
      .join('')
      .slice(0, length);
    return { lf, sent: lf.replaceAll('\n', '\r\n') };
  };

  const form = (url: string, fields: Record<string, string>) =>
    t.inject({
      method: 'POST',
      url,
      payload: new URLSearchParams(fields).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

  it("accepts a repair's note", async () => {
    const id = await createGarment(t, { name: 'Linen shirt' });
    const { lf, sent } = crlfText(CARE_NOTE_MAX);
    expect(sent.length).toBeGreaterThan(CARE_NOTE_MAX);
    const res = await form(`/wardrobe/${id}/repairs`, {
      day: t.today(),
      kind: 'repair',
      note: sent,
    });
    expect(res.statusCode, res.body).toBe(303);
    const [entry] = await t.db
      .select()
      .from(garmentRepair)
      .where(eq(garmentRepair.garmentId, id));
    expect(entry.note).toBe(lf);
  });

  it("accepts a style profile's notes", async () => {
    const ownerId = await userIdOf(t, OWNER_EMAIL);
    const { lf, sent } = crlfText(STYLE_NOTES_MAX);
    expect(sent.length).toBeGreaterThan(STYLE_NOTES_MAX);
    const res = await form('/auth/profile/style', { notes: sent });
    expect(res.statusCode, res.body).toBe(303);
    const [row] = await t.db
      .select()
      .from(styleProfile)
      .where(eq(styleProfile.userId, ownerId));
    expect(row.notes).toBe(lf);
  });
});
