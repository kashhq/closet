import { legacySql } from '../legacy-sql';

export const Migration20260406193304 = legacySql([
  `create table "outfit_calendar" ("id" serial primary key, "date" timestamptz not null, "outfit_id" int not null, "owner_id" int null, "worn_at" timestamptz null, "notes" varchar(255) null);`,
  `alter table "outfit_calendar" add constraint "outfit_calendar_outfit_id_foreign" foreign key ("outfit_id") references "outfit" ("id") on update cascade on delete cascade;`,
  `alter table "outfit_calendar" add constraint "outfit_calendar_owner_id_foreign" foreign key ("owner_id") references "user" ("id") on update cascade on delete cascade;`,
]);
