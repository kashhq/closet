import type { OutfitRule, RuleMatcher } from '../../wardrobe/outfit-rules';
import type { BudgetBand, Style } from '../../wardrobe/style';
import { t, tKey, type Translated } from '../i18n';
import { categoryLabel } from '../wardrobe/garment';
import { valueLabel } from '../wardrobe/labels';
import type { NamedGarment } from './queries';

/**
 * The style profile's words (src/i18n/en/lang.json's `style` group;
 * labels.spec.ts checks every value has one).
 */

export function styleLabel(style: Style): string {
  return tKey(`style.style.${style}`);
}

export function budgetLabel(band: BudgetBand): string {
  return tKey(`style.budget.${band}`);
}

/** A garment by name, or its category's when it has none (the app's one spelling). */
export function garmentLabel(garment: NamedGarment): string {
  return garment.name ?? categoryLabel(garment.category);
}

/**
 * matcherLabel's garment lookup over the garments a caller read with its
 * rules. A rule naming one it did not read is a bug in that read, so it
 * throws (as tKey does) rather than print something else.
 */
export function garmentNamesOf(
  garments: readonly NamedGarment[],
): (id: number) => string {
  const names = new Map(garments.map((g) => [g.id, garmentLabel(g)]));
  return (id) => {
    const name = names.get(id);
    if (name === undefined) throw new Error(`Garment ${id} was not read`);
    return name;
  };
}

/**
 * A rule's side in words: the garment's name (`garmentName`, the caller's
 * lookup), the type or else the category, the colour (as stored: colours
 * have no labels, as in the palette and the filters), the pattern.
 */
export function matcherLabel(
  matcher: RuleMatcher,
  garmentName: (id: number) => string,
): string {
  switch (matcher.by) {
    case 'garment':
      return garmentName(matcher.garmentId);
    case 'category':
      return matcher.type === null
        ? categoryLabel(matcher.category)
        : valueLabel('type', matcher.type);
    case 'color':
      return matcher.color;
    case 'pattern':
      return valueLabel('pattern', matcher.pattern);
  }
}

/**
 * A rule as a sentence: "Never Stripes with Check", and an always-rule B
 * first, "Always Loafers with Chinos" (an outfit with chinos has loafers).
 * The Style page's list (#21b), get_style_profile, and the broken-rule
 * chips' text (brokenRuleLabels, #21c).
 */
export function ruleSentence(
  rule: OutfitRule,
  garmentName: (id: number) => string,
): Translated {
  const a = matcherLabel(rule.a, garmentName);
  const b = matcherLabel(rule.b, garmentName);
  return rule.kind === 'never'
    ? t('style.RULE_NEVER', { a, b })
    : t('style.RULE_ALWAYS', { a, b });
}

/**
 * A flagged idea's chips, one per rule it breaks: "Breaks: Never Black
 * with Stripes" (the Ideas cards' Reasons, Styling's Shuffle, and
 * suggest_outfits' brokenRules). A broken rule is a never-rule between two
 * locked garments, so a side naming a garment names one of the idea's.
 */
export function brokenRuleLabels(idea: {
  brokenRules: readonly OutfitRule[];
  garments: readonly NamedGarment[];
}): string[] {
  const garmentName = garmentNamesOf(idea.garments);
  return idea.brokenRules.map((rule) =>
    t('style.RULE_BROKEN', { rule: ruleSentence(rule, garmentName) }),
  );
}
