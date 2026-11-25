import { legacySql } from '../legacy-sql';

// Login is always required (AUTH_ENABLED was removed), so every garment,
// outfit, calendar entry and file has an owner and the columns become NOT
// NULL. Rows without one were only ever reachable in the anonymous mode and
// are unreachable now, so they are deleted first (production had none).
// A photo row keeps its garment's owner if it somehow lacks a creator, so no
// owned garment loses its photo. The bytes behind deleted file rows are left
// to StorageReconciliationService, which removes unreferenced photo sets
// older than a day. The generated `alter column ... type int` lines were
// dropped: int4 and int are the same type (snapshot format noise).
export const Migration20260926020918 = legacySql([
  `update "file" set "created_by_id" = "garment"."owner_id" from "garment" where "garment"."photo_id" = "file"."id" and "file"."created_by_id" is null and "garment"."owner_id" is not null;`,
  `delete from "outfit_calendar" where "owner_id" is null;`,
  `delete from "outfit" where "owner_id" is null;`,
  `delete from "garment" where "owner_id" is null;`,
  `delete from "file" where "created_by_id" is null;`,
  `alter table "outfit" alter column "owner_id" set not null;`,
  `alter table "outfit_calendar" alter column "owner_id" set not null;`,
  `alter table "file" alter column "created_by_id" set not null;`,
  `alter table "garment" alter column "owner_id" set not null;`,
]);
