import { legacySql } from '../legacy-sql';

export const Migration20260326211224 = legacySql([
  `alter table "outfit" add column "slots" jsonb;`,
]);
