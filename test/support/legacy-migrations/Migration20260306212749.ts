import { legacySql } from '../legacy-sql';

export const Migration20260306212749 = legacySql([
  // One colour per garment replaced the list.
  `alter table "garment" drop column "colors", add column "color" varchar(255);`,
]);
