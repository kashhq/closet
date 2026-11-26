import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply } from 'fastify';
import { selectScalars } from '../../db/select-scalars';
import { weeklyRhythm } from '../../wardrobe/week';
import { sessionUserId } from '../auth/require-session';
import { HttpError } from '../errors';
import { avoidedPairsByNameSql } from '../gallery/queries';
import { t } from '../i18n';
import type { WebOptions } from '../plugin';
import { renderPage } from '../render';
import { RowId } from '../schemas';
import { actorOf } from '../sharing/access';
import { viewContext } from '../view-context';
import { homeNameSql } from '../weather/queries';
import { inTemplateOrder, weekTemplateSql } from '../week-plan/template';
import type { OutfitRulesModel } from './outfit-rules';
import { ruleGarmentChoicesSql, styleProfileParts } from './queries';
import { addRule, removeRule, saveProfile } from './style-actions';
import { StyleProfilePage } from './style-page';
import {
  OUTFIT_RULES_PATH,
  STYLE_PROFILE_PATH,
  STYLE_SAVED,
  STYLE_SAVED_FLAG,
  type StyleSaved,
  styleSavedUrl,
} from './urls';
import {
  EMPTY_STYLE_PROFILE,
  OutfitRuleBody,
  readRuleSide,
  readStyleProfileForm,
  StyleProfileBody,
  styleProfilePost,
  StyleProfileQuery,
} from './validation';

const OutfitRuleParams = Type.Object({ id: RowId });

/**
 * The style profile (#34): the signed-in user's own, never another's
 * (shares never reach it), read by get_style_profile and edited here, with
 * its outfit rules (#21b). Every write is a native post (PostForm), back to
 * the page with a toast, or the page again (400) with the rule form's
 * message. Validation: a rule's kind and sides are their sets' (else 400,
 * data a write stores); a side's garment or a rule not the owner's is the
 * writer's NotFound, like an unknown id.
 */
export const styleRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  options,
  done,
) => {
  const { db, logger } = options;

  /** The page for `userId`, with a toast or a refused rule form. */
  async function renderStylePage(
    reply: FastifyReply,
    userId: number,
    change: { saved?: StyleSaved; refused?: OutfitRulesModel['refused'] },
    status = 200,
  ) {
    // One statement (#251; it was one per part), each part its module's:
    // the profile, the week template its rhythm comes from, the home city,
    // read-only, the weather's (#14, user_weather, never a second copy),
    // not read with WEATHER_ENABLED off, and the outfit rules with what
    // their form offers and the gallery's avoided pairs (#21b).
    const read = await selectScalars(db, {
      ...styleProfileParts(userId),
      template: weekTemplateSql(userId),
      home: options.weather ? homeNameSql(userId) : undefined,
      garments: ruleGarmentChoicesSql(userId),
      avoided: avoidedPairsByNameSql(userId),
    });
    return renderPage(
      reply,
      <StyleProfilePage
        ctx={viewContext(reply)}
        model={{
          values: styleProfilePost(read.profile ?? EMPTY_STYLE_PROFILE),
          rhythm: weeklyRhythm(inTemplateOrder(read.template)),
          home: options.weather ? { name: read.home ?? null } : undefined,
          saved: change.saved,
          rules: {
            rules: read.rules,
            garments: read.garments,
            avoided: read.avoided,
            refused: change.refused,
          },
        }}
      />,
      { status },
    );
  }

  app.get(
    STYLE_PROFILE_PATH,
    { schema: { querystring: StyleProfileQuery } },
    async (request, reply) => {
      const saved = request.query[STYLE_SAVED_FLAG];
      return renderStylePage(reply, sessionUserId(request), {
        saved: STYLE_SAVED.find((flag) => flag === saved),
      });
    },
  );

  app.post(
    STYLE_PROFILE_PATH,
    { schema: { body: StyleProfileBody } },
    async (request, reply) => {
      const fields = readStyleProfileForm(request.body);
      await saveProfile({ db, logger }, actorOf(request), fields);
      return reply.redirect(styleSavedUrl('profile'), 303);
    },
  );

  app.post(
    OUTFIT_RULES_PATH,
    { schema: { body: OutfitRuleBody } },
    async (request, reply) => {
      const actor = actorOf(request);
      const { userId } = actor;
      const { body } = request;
      const a = readRuleSide(body.a);
      const b = readRuleSide(body.b);
      if (!a || !b) throw new HttpError(400, t('refusal.form.notAGarmentId'));
      const refuse = (message: string) => {
        logger.warn(
          `Outfit rule refused for user ${userId} (${body.kind} ${body.a} with ${body.b}): ${message}`,
        );
        return renderStylePage(
          reply,
          userId,
          { refused: { values: body, message } },
          400,
        );
      };
      // Each side is one option, spelled one way, so equal is the same.
      if (body.a === body.b) return refuse(t('style.RULE_SAME'));
      const added = await addRule({ db, logger }, actor, {
        kind: body.kind,
        a,
        b,
      });
      if (added === 'duplicate') return refuse(t('style.RULE_DUPLICATE'));
      return reply.redirect(styleSavedUrl('rule-added'), 303);
    },
  );

  app.post(
    `${OUTFIT_RULES_PATH}/:id/delete`,
    { schema: { params: OutfitRuleParams } },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = request.params;
      await removeRule({ db, logger }, actor, id);
      return reply.redirect(styleSavedUrl('rule-removed'), 303);
    },
  );

  done();
};
