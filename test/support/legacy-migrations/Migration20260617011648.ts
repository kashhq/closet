import { legacySql } from '../legacy-sql';

export const Migration20260617011648 = legacySql([
  `alter table "garment" add column "washing_details" text null;`,
]);
