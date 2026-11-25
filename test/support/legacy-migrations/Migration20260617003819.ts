import { legacySql } from '../legacy-sql';

export const Migration20260617003819 = legacySql([
  `alter table "garment" add column "date_aquired" timestamptz null;`,
]);
