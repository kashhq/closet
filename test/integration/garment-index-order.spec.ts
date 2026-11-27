import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gridPage } from '../../src/web/wardrobe/queries';
import { recordStatements } from '../support/query-recorder';
import { createTestApp, type TestApp, userIdOf, asFixture } from './harness';

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

/**
 * The garment keyset indexes must be in the order the queries ask for (#175).
 * They were `id DESC NULLS LAST` (Drizzle's index `.desc()` alone) while
 * every `orderBy(desc(garment.id))` is plain DESC (NULLS FIRST), so the
 * planner could never read them in order: the grid scanned garment_pkey
 * backward past every other wardrobe's garments, or sorted. This plans the
 * grid's first page for an owner of a small share of many garments, where
 * reading the index in order is the only good plan.
 */
describe('garment keyset index order', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  it('serves the grid page from garment_owner_id_status_id_index in index order', async () => {
    await t.register('neighbour@example.com');
    const neighbour = await userIdOf(t, 'neighbour@example.com');
    const owner = t.owner.id;
    // 3,000 garments, one in twenty the owner's, their ids spread among the
    // neighbour's: enough that a seq scan or a backward garment_pkey scan
    // costs visibly more than the index.
    await asFixture(t.db, (tx) =>
      tx.execute(sql`
        insert into garment (owner_id, shareable_id, category)
        select case when n % 20 = 0 then ${owner}::int else ${neighbour}::int end,
               'index-order-' || n, 'tops'
        from generate_series(1, 3000) n`),
    );
    await t.db.execute(sql`analyze garment`);

    const { statements } = await recordStatements(() =>
      // A VIEW reader's grid: the tiles alone, no wash count per tile.
      gridPage(
        t.db,
        { ownerId: owner, role: 'VIEW' },
        { scope: 'closet', needsWash: false, attention: false },
      ),
    );
    expect(statements).toHaveLength(1);
    const [{ sql: text, values }] = statements;
    const { rows } = await t.db.$client.query<{
      'QUERY PLAN': [{ Plan: PlanNode }];
    }>(`explain (format json) ${text}`, [...values]);
    const nodes = nodesOf(rows[0]['QUERY PLAN'][0].Plan);

    const garmentScans = nodes.filter(
      (node) => node['Relation Name'] === 'garment',
    );
    expect(garmentScans).toEqual([
      expect.objectContaining({
        'Node Type': 'Index Scan',
        'Index Name': 'garment_owner_id_status_id_index',
      }),
    ]);
    expect(nodes.map((node) => node['Node Type'])).not.toContain('Sort');
  });
});
