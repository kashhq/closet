import { legacySql } from '../legacy-sql';

export const Migration20260305215234 = legacySql([
  `create table "password_reset" ("id" serial primary key, "pin" varchar(255) not null);`,
  `create table "user" ("id" serial primary key, "shareable_id" varchar(255) not null, "flagged" boolean null, "banned" boolean null, "first_name" varchar(255) null, "last_name" varchar(255) null, "email" varchar(255) null, "password" varchar(255) not null, "password_reset_id" int null);`,
  `alter table "user" add constraint "user_email_unique" unique ("email");`,
  `alter table "user" add constraint "user_password_reset_id_unique" unique ("password_reset_id");`,
  `create table "outfit" ("id" serial primary key, "shareable_id" varchar(255) not null, "flagged" boolean null, "banned" boolean null, "name" varchar(255) not null, "notes" varchar(255) null, "owner_id" int null);`,
  `create table "file" ("id" serial primary key, "shareable_id" varchar(255) not null, "flagged" boolean null, "banned" boolean null, "file_name" varchar(255) not null, "mimetype" varchar(255) null, "created_on" varchar(255) not null, "created_by_id" int null);`,
  `alter table "file" add constraint "file_file_name_unique" unique ("file_name");`,
  `create table "garment" ("id" serial primary key, "shareable_id" varchar(255) not null, "flagged" boolean null, "banned" boolean null, "name" varchar(255) not null, "category" varchar(255) not null, "brand" varchar(255) null, "colors" jsonb null, "size" varchar(255) null, "notes" varchar(255) null, "photo_id" int null, "owner_id" int null);`,
  `alter table "garment" add constraint "garment_photo_id_unique" unique ("photo_id");`,
  `create table "outfit_garments" ("outfit_id" int not null, "garment_id" int not null, constraint "outfit_garments_pkey" primary key ("outfit_id", "garment_id"));`,
  `create table "user_device" ("id" serial primary key, "user_agent" varchar(255) not null, "push_endpoint" varchar(255) not null, "web_push_subscription" jsonb null, "user_id" int not null);`,
  `alter table "user_device" add constraint "user_device_push_endpoint_unique" unique ("push_endpoint");`,
  `alter table "user" add constraint "user_password_reset_id_foreign" foreign key ("password_reset_id") references "password_reset" ("id") on update cascade on delete cascade;`,
  `alter table "outfit" add constraint "outfit_owner_id_foreign" foreign key ("owner_id") references "user" ("id") on update cascade on delete cascade;`,
  `alter table "file" add constraint "file_created_by_id_foreign" foreign key ("created_by_id") references "user" ("id") on update cascade on delete cascade;`,
  `alter table "garment" add constraint "garment_photo_id_foreign" foreign key ("photo_id") references "file" ("id") on update cascade on delete set null;`,
  `alter table "garment" add constraint "garment_owner_id_foreign" foreign key ("owner_id") references "user" ("id") on update cascade on delete cascade;`,
  `alter table "outfit_garments" add constraint "outfit_garments_outfit_id_foreign" foreign key ("outfit_id") references "outfit" ("id") on update cascade on delete cascade;`,
  `alter table "outfit_garments" add constraint "outfit_garments_garment_id_foreign" foreign key ("garment_id") references "garment" ("id") on update cascade on delete cascade;`,
  `alter table "user_device" add constraint "user_device_user_id_foreign" foreign key ("user_id") references "user" ("id") on update cascade on delete cascade;`,
]);
