import { legacySql } from '../legacy-sql';

export const Migration20260925170251 = legacySql([
  `alter table "file" add column "version" int not null default 1;`,
]);
