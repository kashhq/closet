import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { selectScalars } from '../../db/select-scalars';
import { apiResponses } from '../api/contract';
import type { ApiOptions } from '../api/plugin';
import { RowId } from '../schemas';
import { actorOf } from '../sharing/access';
import { API_PREFIX } from '../surface';
import { styleProfileParts } from './queries';
import { addRule, removeRule, saveProfile } from './style-actions';
import {
  OutfitRuleAdded,
  OutfitRuleInput,
  readRuleSides,
  StyleProfile,
  StyleProfileInput,
  StyleProfileValues,
  toOutfitRule,
  toStyleProfileValues,
} from './style-resource';
import { storedStyleProfile } from './validation';

const OutfitRuleParams = Type.Object({ id: RowId });

/**
 * The style profile and its outfit rules on /api/v1 (#195c; plan section
 * 6), registered by apiPlugin, each calling what its page twin calls
 * (operations.ts names the twin): saveStyleProfile, addOutfitRule and
 * deleteOutfitRule, and the page's read (styleProfileParts). The token's
 * user's own, as on the page (AGENTS.md): no share reaches it, there is no
 * `?ownerId=`, and another's rule, or a side naming a garment that is not
 * yours, is the 404 of an unknown id.
 */
export const styleApiRoutes: FastifyPluginCallbackTypebox<ApiOptions> = (
  app,
  { db, logger },
  done,
) => {
  app.get(
    '/style-profile',
    {
      schema: {
        operationId: 'getStyleProfile',
        tags: ['style'],
        summary: 'Your style profile and outfit rules',
        response: apiResponses({ 200: StyleProfile }),
      },
    },
    async (request) => {
      const read = await selectScalars(
        db,
        styleProfileParts(actorOf(request).userId),
      );
      return {
        ...toStyleProfileValues(read.profile),
        rules: read.rules.map(toOutfitRule),
      };
    },
  );

  app.put(
    '/style-profile',
    {
      schema: {
        operationId: 'saveStyleProfile',
        tags: ['style'],
        summary: 'Saves your style profile, whole',
        description:
          'Every field replaced at once (last write wins); a field left out or null is cleared. Answers the profile as saved. The outfit rules are their own (POST /outfit-rules).',
        body: StyleProfileInput,
        response: apiResponses({ 200: StyleProfileValues }),
      },
    },
    async (request) => {
      const { styles, palette, budget, notes } = request.body;
      const fields = storedStyleProfile({
        styles,
        palette,
        budget: budget ?? null,
        notes: notes ?? null,
      });
      await saveProfile({ db, logger }, actorOf(request), fields);
      return toStyleProfileValues(fields);
    },
  );

  app.post(
    '/outfit-rules',
    {
      schema: {
        operationId: 'addOutfitRule',
        tags: ['style'],
        summary: 'Adds an outfit rule',
        description:
          'Two different sides (else a 400 at `body/b`); a garment side must be yours, else a 404 and nothing is written. 201 with its `Location`; 200 `added: false` when you have the rule already (a retry, or a never-rule sent the other way round). Ideas, Today and Plan my week keep to it from the next read.',
        body: OutfitRuleInput,
        response: apiResponses({ 200: OutfitRuleAdded, 201: OutfitRuleAdded }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { kind } = request.body;
      const [a, b] = readRuleSides(request.body);
      const added = await addRule({ db, logger }, actor, { kind, a, b });
      if (added === 'duplicate') {
        return reply.status(200).send({ added: false });
      }
      return reply
        .status(201)
        .header('Location', `${API_PREFIX}/outfit-rules/${added}`)
        .send({ added: true, id: added });
    },
  );

  app.delete(
    '/outfit-rules/:id',
    {
      schema: {
        operationId: 'deleteOutfitRule',
        tags: ['style'],
        summary: 'Removes an outfit rule',
        description:
          'One already gone is a 404, which a retry may read as done.',
        params: OutfitRuleParams,
        response: apiResponses({ 204: Type.Null({ description: 'Deleted' }) }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = request.params;
      await removeRule({ db, logger }, actor, id);
      return reply.status(204).send(null);
    },
  );

  done();
};
