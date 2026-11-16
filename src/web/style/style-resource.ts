import { CloneType, type Static, Type } from '@sinclair/typebox';
import {
  OUTFIT_RULE_KINDS,
  type RuleMatcher,
  type StoredMatcher,
} from '../../wardrobe/outfit-rules';
import {
  GARMENT_COLORS,
  GARMENT_TYPES,
  GarmentCategory,
  PATTERNS,
} from '../../wardrobe/properties';
import { BUDGET_BANDS, STYLES } from '../../wardrobe/style';
import { literals, Nullable, withoutNulls } from '../api/resource';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { RowId } from '../schemas';
import { garmentNamesOf, matcherLabel, ruleSentence } from './labels';
import {
  type ListedOutfitRule,
  readOutfitRule,
  type SyncedRuleRow,
} from './queries';
import {
  NO_MATCHER,
  STYLE_NOTES_MAX,
  type StyleProfileFields,
} from './validation';

/**
 * The style profile and its outfit rules as /api/v1 reads and takes them
 * (#195c; style/api-routes.ts). The bodies are closed (`additionalProperties:
 * false`): a key the profile does not have is a 400 naming it, never
 * dropped, since a PUT replaces the profile whole.
 */

const Styles = Type.Array(literals(STYLES), {
  uniqueItems: true,
  description: 'The styles you dress in, each once',
});
const Palette = Type.Array(literals(GARMENT_COLORS), {
  uniqueItems: true,
  description: 'Your palette: garment colours, each once',
});
const Budget = literals(BUDGET_BANDS);
const Notes = Type.String({ maxLength: STYLE_NOTES_MAX });

/** The profile's own fields, as GET and PUT answer them (a field never saved is left out). */
const profileFields = {
  styles: Styles,
  palette: Palette,
  budget: Type.Optional(
    CloneType(Budget, {
      description:
        'Per piece: budget under $50, mid $50-150, premium $150-400, luxury above',
    }),
  ),
  notes: Type.Optional(Notes),
};

export const StyleProfileInput = Type.Object(
  {
    styles: Styles,
    palette: Palette,
    budget: Nullable(Budget, { description: 'Absent or null: none' }),
    notes: Nullable(Notes, {
      description: 'Trimmed; blank, absent or null: none',
    }),
  },
  { title: 'StyleProfileInput', additionalProperties: false },
);

export const StyleProfileValues = Type.Object(profileFields, {
  title: 'StyleProfileValues',
  description: 'The style profile as saved, its sets in their own order',
});

/** A rule's side as sent: exactly one matcher. */
const RuleSideInput = Type.Union(
  [
    Type.Object(
      { garmentId: CloneType(RowId, { description: 'One of your garments' }) },
      { additionalProperties: false },
    ),
    // One branch per category, so a type outside its category is a 400.
    ...Object.values(GarmentCategory).map((category) => {
      const types = GARMENT_TYPES[category].map(({ value }) => value);
      return Type.Object(
        {
          category: Type.Literal(category),
          ...(types.length > 0 && { type: Type.Optional(literals(types)) }),
        },
        { additionalProperties: false },
      );
    }),
    Type.Object(
      { color: literals(GARMENT_COLORS) },
      { additionalProperties: false },
    ),
    Type.Object(
      { pattern: literals(PATTERNS) },
      { additionalProperties: false },
    ),
  ],
  {
    title: 'OutfitRuleSideInput',
    description:
      'One of: a garment of yours (`garmentId`), a category and maybe its type, a colour, a pattern',
  },
);

export const OutfitRuleInput = Type.Object(
  {
    kind: CloneType(literals(OUTFIT_RULE_KINDS), {
      description:
        'never: no outfit holds a and b together (either way round); always: an outfit with a also has b, when one can join it',
    }),
    a: RuleSideInput,
    b: RuleSideInput,
  },
  { title: 'OutfitRuleInput', additionalProperties: false },
);

export const OutfitRuleAdded = Type.Object(
  {
    /** False: you have this rule already (a never-rule's mirror included). */
    added: Type.Boolean(),
    id: Type.Optional(Type.Integer({ description: 'The new rule (201 only)' })),
  },
  { title: 'OutfitRuleAdded' },
);

/** A stored side's one matcher, as sent. */
const sideMatcherFields = {
  garmentId: Type.Optional(Type.Integer()),
  category: Type.Optional(literals(Object.values(GarmentCategory))),
  type: Type.Optional(Type.String()),
  color: Type.Optional(literals(GARMENT_COLORS)),
  pattern: Type.Optional(literals(PATTERNS)),
};

const RuleSide = Type.Object(
  {
    ...sideMatcherFields,
    label: Type.String({
      description:
        "The side in the app's words: the garment's name, the type or category, the colour, the pattern",
    }),
  },
  {
    title: 'OutfitRuleSide',
    description: 'Exactly one matcher, as sent, and its words',
  },
);

const OutfitRuleResource = Type.Object(
  {
    id: Type.Integer(),
    kind: literals(OUTFIT_RULE_KINDS),
    a: RuleSide,
    b: RuleSide,
    sentence: Type.String({
      description:
        'The rule as the Style page lists it: "Never Stripes with Check"',
    }),
  },
  {
    title: 'OutfitRule',
    description:
      "A never-rule's sides are stored in one order, so they may read swapped from how they were sent",
  },
);

export const StyleProfile = Type.Object(
  { ...profileFields, rules: Type.Array(OutfitRuleResource) },
  {
    title: 'StyleProfile',
    description:
      'What Muse reads of your taste: the profile (empty sets when never saved) and your outfit rules, oldest first. Your week is GET /week-template.',
  },
);

const SyncedRuleSide = Type.Object(sideMatcherFields, {
  title: 'SyncedOutfitRuleSide',
  description:
    "Exactly one matcher, as sent; its words are yours to spell (a garment's name is the garment's)",
});

const SyncedOutfitRule = Type.Object(
  {
    id: Type.Integer(),
    kind: literals(OUTFIT_RULE_KINDS),
    a: SyncedRuleSide,
    b: SyncedRuleSide,
  },
  {
    title: 'SyncedOutfitRule',
    description:
      "An outfit rule in the changes feed: the API's without the words (`label`, `sentence`), which name garments whose rename never re-sends the profile",
  },
);

/**
 * The style profile in the changes feed (#716): its fields and its rules,
 * since a rule's write stamps the profile (SYNC_CHILDREN's outfit_rule).
 */
export const SyncedStyleProfile = Type.Object(
  { ...profileFields, rules: Type.Array(SyncedOutfitRule) },
  {
    title: 'SyncedStyleProfile',
    description:
      'The style profile as saved (empty sets when never saved) and your outfit rules, oldest first: a rule added or removed re-sends it whole',
  },
);

/** A stored profile as the API answers it: empty sets, never null ones. */
export function toStyleProfileValues(
  profile: StyleProfileFields | null,
): Static<typeof StyleProfileValues> {
  return withoutNulls({
    styles: profile?.styles ?? [],
    palette: profile?.palette ?? [],
    budget: profile?.budget ?? null,
    notes: profile?.notes ?? null,
  });
}

/** A side's one matcher, as sent. */
function toSyncedRuleSide(matcher: RuleMatcher): Static<typeof SyncedRuleSide> {
  switch (matcher.by) {
    case 'garment':
      return { garmentId: matcher.garmentId };
    case 'category':
      return withoutNulls({ category: matcher.category, type: matcher.type });
    case 'color':
      return { color: matcher.color };
    case 'pattern':
      return { pattern: matcher.pattern };
  }
}

/** A side as the API reads it: its one matcher, as sent, and its words. */
function toRuleSide(
  matcher: RuleMatcher,
  garmentName: (id: number) => string,
): Static<typeof RuleSide> {
  return {
    ...toSyncedRuleSide(matcher),
    label: matcherLabel(matcher, garmentName),
  };
}

/** A profile and its rules (styleProfilesByUserIds) as the feed carries them. */
export function toSyncedStyleProfile(
  profile: StyleProfileFields,
  rules: readonly SyncedRuleRow[],
): Static<typeof SyncedStyleProfile> {
  return {
    ...toStyleProfileValues(profile),
    rules: rules.map(({ id, rule }) => {
      const { kind, a, b } = readOutfitRule(rule);
      return { id, kind, a: toSyncedRuleSide(a), b: toSyncedRuleSide(b) };
    }),
  };
}

export function toOutfitRule(
  listed: ListedOutfitRule,
): Static<typeof OutfitRuleResource> {
  const rule = readOutfitRule(listed.rule);
  const garmentName = garmentNamesOf(listed.garments);
  return {
    id: listed.id,
    kind: rule.kind,
    a: toRuleSide(rule.a, garmentName),
    b: toRuleSide(rule.b, garmentName),
    sentence: ruleSentence(rule, garmentName),
  };
}

/** A side as sent, as stored: the schema let exactly one matcher through. */
function readRuleSideInput(side: Static<typeof RuleSideInput>): StoredMatcher {
  if ('garmentId' in side) return { ...NO_MATCHER, garmentId: side.garmentId };
  if ('category' in side) {
    const type = 'type' in side ? (side.type ?? null) : null;
    return { ...NO_MATCHER, category: side.category, type };
  }
  if ('color' in side) return { ...NO_MATCHER, color: side.color };
  return { ...NO_MATCHER, pattern: side.pattern };
}

/**
 * The two sides, refused when they are the same matcher (the page's
 * "Choose two different things.", there from comparing its options).
 */
export function readRuleSides(
  input: Static<typeof OutfitRuleInput>,
): [StoredMatcher, StoredMatcher] {
  const a = readRuleSideInput(input.a);
  const b = readRuleSideInput(input.b);
  const same = (Object.keys(NO_MATCHER) as (keyof StoredMatcher)[]).every(
    (key) => a[key] === b[key],
  );
  if (same) {
    const message = t('style.RULE_SAME');
    throw new HttpError(400, message, {
      validation: [{ path: 'body/b', message }],
    });
  }
  return [a, b];
}
