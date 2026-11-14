import { DRAWN_ROLES } from '../../wardrobe/generator';
import {
  OUTFIT_RULE_KINDS,
  type OutfitRuleKind,
} from '../../wardrobe/outfit-rules';
import {
  categoryRole,
  GARMENT_COLORS,
  GARMENT_TYPES,
  GarmentCategory,
  PATTERNS,
} from '../../wardrobe/properties';
import { PostForm } from '../form';
import { ChipGroup, FieldMessages, FormField } from '../form-field';
import type { AvoidedPair } from '../gallery/queries';
import { IDEAS_ALLOW_PATH } from '../gallery/urls';
import { type StringKey, t } from '../i18n';
import { categoryLabel } from '../wardrobe/garment';
import { valueLabel } from '../wardrobe/labels';
import { garmentLabel, garmentNamesOf, ruleSentence } from './labels';
import {
  type ListedOutfitRule,
  type NamedGarment,
  readOutfitRule,
} from './queries';
import {
  OUTFIT_RULES_PATH,
  OUTFIT_RULES_SECTION_ID,
  outfitRuleDeleteUrl,
  styleSavedUrl,
} from './urls';
import { type OutfitRuleBody, ruleSideValue } from './validation';

export interface OutfitRulesModel {
  rules: ListedOutfitRule[];
  /** The garments a side may name: the owner's closet (ruleGarmentChoicesSql). */
  garments: NamedGarment[];
  /** The gallery's "Clashes" pairs, read-only here but for "Allow again". */
  avoided: AvoidedPair[];
  /** A refused add (400): the form as posted, and why. */
  refused?: { values: OutfitRuleBody; message: string };
}

const KIND_LABELS = {
  never: 'style.RULE_KIND_NEVER',
  always: 'style.RULE_KIND_ALWAYS',
} as const satisfies Record<OutfitRuleKind, StringKey>;

const BLANK_RULE: OutfitRuleBody = { kind: 'never', a: '', b: '' };

/**
 * The Style page's Outfit rules (#21b; docs/plans/2026-11-12-generator-
 * rules.md, section 4): the owner's rules as sentences, each with its
 * delete; the add form; and the gallery's avoided pairs, each with "Allow
 * again" (allowPair, back here). Every write is a native post (PostForm)
 * answered 303 back to this section, or the page re-rendered 400 with the
 * form's message. The owner's own: no grantee reaches the page.
 */
export function OutfitRulesSection({ model }: { model: OutfitRulesModel }) {
  return (
    <section
      id={OUTFIT_RULES_SECTION_ID}
      class="flex flex-col gap-3 mt-8 scroll-mt-20"
      aria-labelledby="outfit-rules-heading"
    >
      <h2 id="outfit-rules-heading" class="text-lg font-semibold">
        {t('style.RULES_HEADING')}
      </h2>
      <p class="text-sm text-muted">{t('style.RULES_HINT')}</p>
      <RuleList rules={model.rules} />
      <AddRuleForm
        garments={model.garments}
        values={model.refused?.values ?? BLANK_RULE}
        message={model.refused?.message}
      />
      <AvoidedPairs pairs={model.avoided} />
    </section>
  );
}

function RuleList({ rules }: { rules: ListedOutfitRule[] }) {
  if (rules.length === 0) {
    return <p class="text-sm">{t('style.RULES_NONE')}</p>;
  }
  return (
    <ul class="flex flex-col gap-1" id="outfit-rule-list">
      {rules.map(({ id, rule, garments }) => {
        const sentence = ruleSentence(
          readOutfitRule(rule),
          garmentNamesOf(garments),
        );
        return (
          <li class="flex items-center justify-between gap-2" data-rule={id}>
            <span>{sentence}</span>
            <PostForm action={outfitRuleDeleteUrl(id)}>
              <button
                type="submit"
                class="btn btn-ghost btn-xs"
                aria-label={t('style.RULE_REMOVE_LABEL', { rule: sentence })}
              >
                {t('style.RULE_REMOVE')}
              </button>
            </PostForm>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The kind, then each side's one select (SideSelect). The hint under B
 * shows, by CSS alone, when an always-rule's B is a garment the generator
 * never draws (an accessory, a bag or other): it can only be honoured
 * when that garment is locked in Styling (src/wardrobe/AGENTS.md, outfit
 * rules).
 */
function AddRuleForm(props: {
  garments: NamedGarment[];
  values: OutfitRuleBody;
  message?: string;
}) {
  const { values } = props;
  return (
    <PostForm action={OUTFIT_RULES_PATH} class="group/rule flex flex-col gap-3">
      <h3 class="font-medium">{t('style.RULE_ADD_HEADING')}</h3>
      <ChipGroup label={t('style.RULE_KIND')} hint={t('style.RULE_KIND_HINT')}>
        {OUTFIT_RULE_KINDS.map((kind) => (
          <input
            type="radio"
            name="kind"
            value={kind}
            class="btn btn-sm rounded-full"
            aria-label={t(KIND_LABELS[kind])}
            checked={values.kind === kind}
          />
        ))}
      </ChipGroup>
      <FormField id="rule-a" label={t('style.RULE_A')}>
        <SideSelect
          id="rule-a"
          name="a"
          selected={values.a}
          garments={props.garments}
        />
      </FormField>
      <FormField id="rule-b" label={t('style.RULE_B')}>
        <SideSelect
          id="rule-b"
          name="b"
          selected={values.b}
          garments={props.garments}
        />
      </FormField>
      <p
        id="rule-undrawn-hint"
        class="text-xs text-muted hidden group-has-[[name=kind][value=always]:checked]/rule:group-has-[#rule-b_[data-undrawn]:checked]/rule:block"
      >
        {t('style.RULE_UNDRAWN_HINT')}
      </p>
      <FieldMessages
        id="rule-form"
        messages={props.message ? [props.message] : undefined}
      />
      <button type="submit" class="btn btn-primary btn-sm self-end">
        {t('style.RULE_ADD')}
      </button>
    </PostForm>
  );
}

/** Whether the generator ever draws a garment of `category` (DRAWN_ROLES); others only ride along locked. */
function undrawn(category: string): boolean {
  return !DRAWN_ROLES.includes(categoryRole(category));
}

/**
 * One side of a rule: a category or one of its types, a colour, a pattern,
 * or one of the closet's garments, one option each (ruleSideValue), so a
 * phone's native picker is the whole control and no script is needed.
 * `data-undrawn` marks what the generator never draws, for the hint.
 */
function SideSelect(props: {
  id: string;
  name: 'a' | 'b';
  selected: string;
  garments: NamedGarment[];
}) {
  const option = (value: string, label: string, never = false) => (
    <option
      value={value}
      selected={value === props.selected}
      data-undrawn={never ? '' : undefined}
    >
      {label}
    </option>
  );
  return (
    <select
      id={props.id}
      name={props.name}
      class="select select-bordered w-full"
      required
    >
      {option('', t('style.RULE_CHOOSE'))}
      {Object.values(GarmentCategory).map((category) => {
        const label = categoryLabel(category);
        const never = undrawn(category);
        return (
          <optgroup label={label}>
            {option(
              ruleSideValue.category(category),
              t('style.RULE_ANY_TYPE', { category: label }),
              never,
            )}
            {GARMENT_TYPES[category].map(({ value }) =>
              option(
                ruleSideValue.category(category, value),
                valueLabel('type', value),
                never,
              ),
            )}
          </optgroup>
        );
      })}
      <optgroup label={t('COLOR')}>
        {GARMENT_COLORS.map((color) =>
          option(ruleSideValue.color(color), color),
        )}
      </optgroup>
      <optgroup label={t('PROPERTY_PATTERN')}>
        {PATTERNS.map((pattern) =>
          option(
            ruleSideValue.pattern(pattern),
            valueLabel('pattern', pattern),
          ),
        )}
      </optgroup>
      {props.garments.length > 0 && (
        <optgroup label={t('style.RULE_GARMENTS')}>
          {props.garments.map((garment) =>
            option(
              ruleSideValue.garment(garment.id),
              garmentLabel(garment),
              undrawn(garment.category),
            ),
          )}
        </optgroup>
      )}
    </select>
  );
}

/**
 * The pairs the gallery's "Clashes" set (generator_avoid), which the
 * generator keeps apart like never-rules: listed, not edited here, each
 * with its undo. Nothing when there are none.
 */
function AvoidedPairs({ pairs }: { pairs: AvoidedPair[] }) {
  if (pairs.length === 0) return null;
  return (
    <div id="style-avoided" class="flex flex-col gap-1">
      <h3 class="font-medium">{t('style.AVOIDED_HEADING')}</h3>
      <p class="text-sm text-muted">{t('style.AVOIDED_HINT')}</p>
      <ul class="flex flex-col gap-1">
        {pairs.map(({ a, b }) => {
          const pair = t('style.AVOIDED_PAIR', {
            a: garmentLabel(a),
            b: garmentLabel(b),
          });
          return (
            <li class="flex items-center justify-between gap-2">
              <span>{pair}</span>
              <PostForm action={IDEAS_ALLOW_PATH}>
                <input type="hidden" name="garmentId" value={String(a.id)} />
                <input type="hidden" name="garmentId" value={String(b.id)} />
                <input
                  type="hidden"
                  name="returnTo"
                  value={styleSavedUrl('pair-allowed')}
                />
                <button
                  type="submit"
                  class="btn btn-ghost btn-xs"
                  aria-label={t('style.ALLOW_PAIR_LABEL', { pair })}
                >
                  {t('gallery.ALLOW_AGAIN')}
                </button>
              </PostForm>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
