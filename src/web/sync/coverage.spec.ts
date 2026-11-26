import { describe, expect, it } from 'vitest';
import committedSpec from '../api/openapi.json';
import { coverageTable, FEED_OPERATION, READ_COVERAGE } from './coverage';
import { FEED } from './feed';

/**
 * The feed's declared coverage (#716) against the committed spec, which
 * the drift test (scripts/api-spec.spec.ts, test/integration/api.spec.ts)
 * holds to the app: a new GET under /api/v1 fails here until it is
 * declared feed-backed or online only.
 */
describe("the changes feed's coverage", () => {
  const reads = Object.values(
    committedSpec.paths as Record<
      string,
      Record<string, { operationId: string }>
    >,
  ).flatMap((operations) =>
    Object.entries(operations)
      .filter(([method]) => method === 'get')
      .map(([, operation]) => operation.operationId),
  );

  it('declares every GET of the API once, the feed itself aside', () => {
    const declared = READ_COVERAGE.flatMap((row) => row.reads);
    expect(new Set(declared).size).toBe(declared.length);
    expect(declared.sort()).toEqual(
      reads.filter((id) => id !== FEED_OPERATION).sort(),
    );
  });

  it('names every feed resource, and only those', () => {
    const names = Object.values(FEED).map((entry) => entry.name);
    const named = READ_COVERAGE.flatMap((row) =>
      'feed' in row ? row.feed : [],
    );
    expect([...new Set(named)].sort()).toEqual(names.sort());
  });

  it('is the table listChanges describes', () => {
    const description = (
      committedSpec.paths['/api/v1/changes'] as {
        get: { description: string };
      }
    ).get.description;
    expect(description).toContain(coverageTable(READ_COVERAGE));
  });
});
