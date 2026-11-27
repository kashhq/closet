import * as z from 'zod';
import { selectScalars } from '../../../db/select-scalars';
import { templateDays, weeklyRhythm } from '../../../wardrobe/week';
import { avoidedPairsByNameSql } from '../../gallery/queries';
import { garmentNamesOf, matcherLabel, ruleSentence } from '../../style/labels';
import { readOutfitRule, styleProfileParts } from '../../style/queries';
import { inTemplateOrder, weekTemplateSql } from '../../week-plan/template';
import { defineTool } from '../tool';

/**
 * The owner's style profile, week and outfit rules (#34, #16, #21): the
 * caller's own. The rules in the Style page's words (labels.ts), so the agent
 * reads them as the owner wrote them.
 */
export const styleTools = [
  defineTool({
    name: 'get_style_profile',
    title: 'Get my style profile',
    description:
      "Your style profile: the styles you dress in, your budget band per piece (budget under $50, mid $50-150, premium $150-400, luxury above) and your palette (garment colours); null when you never saved one. And your week: the week template (Sunday first, weekday 0 to 6: the occasion of the day's outfit, all-day, work or daytime, or none, and the occasions around it, workout, evening, night-out) that plan_week fills, and the rhythm derived from it (how many days a week each occasion comes round). Your home city is the weather's (get_weather), not part of it. And your outfit rules, in the app's words, that suggest_outfits, Today and plan_week keep to: never (no outfit has a and b together) or always (an outfit with a also has b, when one can join it), each side a garment by name, a category or type, a colour or a pattern; and avoidedPairs, the pairs of your garments you said clash, which are never worn together either. Keep to both in any outfit you propose.",
    input: z.object({}),
    writes: false,
    async run(_args, ctx) {
      // One statement (#172; it was two).
      const read = await selectScalars(ctx.db, {
        ...styleProfileParts(ctx.userId),
        template: weekTemplateSql(ctx.userId),
        avoided: avoidedPairsByNameSql(ctx.userId),
      });
      const template = inTemplateOrder(read.template);
      return {
        profile: read.profile,
        week: {
          template: templateDays(template),
          rhythm: weeklyRhythm(template),
        },
        outfitRules: read.rules.map((listed) => {
          const rule = readOutfitRule(listed.rule);
          const garmentName = garmentNamesOf(listed.garments);
          return {
            kind: rule.kind,
            a: matcherLabel(rule.a, garmentName),
            b: matcherLabel(rule.b, garmentName),
            sentence: ruleSentence(rule, garmentName),
          };
        }),
        avoidedPairs: read.avoided,
      };
    },
  }),
];
