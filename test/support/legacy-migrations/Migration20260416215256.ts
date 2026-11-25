import { legacySql } from '../legacy-sql';

export const Migration20260416215256 = legacySql([
  `alter table "outfit" alter column "name" type varchar(255) using ("name"::varchar(255)), alter column "name" drop not null;`,
  `alter table "garment" alter column "name" type varchar(255) using ("name"::varchar(255)), alter column "name" drop not null;`,
]);
