import { describe, expect, it } from 'vitest';
import english from './en/lang.json';

// #654: the export is a garment list; backups are the operator's database
// dump plus the photo share. A string promising the export as a backup
// would make a user keep a spreadsheet believing it is their closet.
function leaves(node: unknown, path = ''): [string, string][] {
  if (typeof node === 'string') return [[path, node]];
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, child]) =>
    leaves(child, path ? `${path}.${key}` : key),
  );
}

describe('the garment export is never called a backup', () => {
  const strings = leaves(english);

  it('walks every section of lang.json', () => {
    expect(strings.some(([key]) => key.startsWith('profile.'))).toBe(true);
    expect(strings.some(([key]) => key === 'DELETE_ACCOUNT_WARNING')).toBe(
      true,
    );
  });

  it('no string offers the export as a backup', () => {
    // "export ... for/as/a backup", or "backup ... export", minus the honest
    // "not a backup".
    const claim = /export\b[^.]*\b(?:for|as|is|a|your)\s+(?:a\s+)?back ?up/i;
    const claimed = (text: string) =>
      claim.test(text.replace(/not a back ?up/gi, ''));
    const offenders = strings
      .filter(([, text]) => claimed(text))
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });

  // The sentence that began this ("Download every garment ... for a backup")
  // never says "export", so the wording alone cannot see it: a string under an
  // export key is the export's, whatever it calls itself.
  it('no string under an export key mentions a backup except to deny it', () => {
    const offenders = strings
      .filter(([key]) => /export/i.test(key))
      .filter(([, text]) =>
        /\b(?:for|as|is|your|a)\s+back ?up\b/i.test(
          text.replace(/not a back ?up/gi, ''),
        ),
      )
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });

  it("Profile's hint says what the export holds and leaves out", () => {
    const hint = english.profile.EXPORT_HINT;
    expect(hint).toContain('garment list');
    expect(hint).toContain('Muse needs');
    expect(hint).toContain('no photo files');
    expect(hint).toContain('outfits');
    expect(hint).toContain('It is not a backup');
  });

  it('the delete-account page says the export keeps no photos, outfits or history', () => {
    expect(english.DELETE_ACCOUNT_WARNING).toContain(
      'keeps no photos, outfits or history',
    );
  });
});
