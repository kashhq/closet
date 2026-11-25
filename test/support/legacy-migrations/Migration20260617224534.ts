import { legacySql } from '../legacy-sql';

export const Migration20260617224534 = legacySql([
  `alter table "garment" add column "archived" boolean not null default false;`,
]);
