import { legacySql } from '../legacy-sql';

// Password reset by email was removed (the in-app change-password page
// replaces it). Dropping user.password_reset_id also removes the ON DELETE
// CASCADE that let deleting a password_reset row delete its user.
export const Migration20260926021506 = legacySql([
  `alter table "user" drop constraint "user_password_reset_id_foreign";`,
  `drop table if exists "password_reset" cascade;`,
  `alter table "user" drop constraint "user_password_reset_id_unique";`,
  `alter table "user" drop column "password_reset_id";`,
]);
