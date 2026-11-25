import { legacySql } from '../legacy-sql';

// Garment.color was an item-less @Enum, which MikroORM mapped to smallint on
// Postgres (Migration20260612010041) while the app writes comma-joined enum
// names ("red,blue"); every save with a colour failed. The column becomes
// text. Any ordinal that did make it into the column is mapped back to the
// enum name by position, so the migration is safe on a non-empty table.
// The GarmentColor enum as it stood, in its order: the ordinals are
// positions in it, so frozen history keeps its own copy.
const COLORS = [
  'red',
  'pink',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'black',
  'white',
  'grey',
  'beige',
  'brown',
  'gold',
  'silver',
  'pattern',
  'other',
];

const ordinalToName = COLORS.map(
  (name, ordinal) => `when ${ordinal} then '${name}'`,
).join(' ');

export const Migration20260925182919 = legacySql([
  `alter table "garment" alter column "color" type varchar(255) using (case "color" ${ordinalToName} else null end);`,
]);
