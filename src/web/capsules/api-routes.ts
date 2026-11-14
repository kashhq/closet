import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { apiResponses } from '../api/contract';
import type { ApiOptions } from '../api/plugin';
import { refusedBody } from '../api/refused-body';
import { HttpError } from '../errors';
import { t } from '../i18n';
import {
  ListCursor,
  ListLimit,
  offsetCursor,
  readOffsetCursor,
} from '../api/resource';
import { GarmentParams } from '../schemas';
import { actorOf, authorizeWardrobe } from '../sharing/access';
import { API_PREFIX } from '../surface';
import { garmentAddress } from '../wardrobe/garment-access';
import { OwnerId } from '../wardrobe/garment-api-input';
import {
  capsuleAddress,
  createOwnCapsule,
  createOwnCapsuleOnce,
  deleteOwnCapsule,
  renameCapsule,
  requireCapsule,
  setCapsuleMembers,
  setGarmentCapsules,
} from './capsule-actions';
import {
  Capsule,
  CapsuleCreated,
  CapsuleInput,
  CapsuleList,
  CapsuleMembersChange,
  GarmentCapsulesChange,
  MembershipChanged,
  NewCapsule,
  POINTER_OF_CAPSULE_FIELD,
  toCapsuleListItem,
  toCapsuleResource,
} from './capsule-resource';
import { listCapsules } from './queries';
import { CapsuleParams, nameTaken, readCapsuleForm } from './validation';

/** A page of GET /capsules unless asked: more than a household keeps. */
const CAPSULE_PAGE_SIZE = 50;

const CapsuleQuery = Type.Object({ ownerId: OwnerId });

const CapsuleListQuery = Type.Object({
  ownerId: OwnerId,
  cursor: Type.Optional(ListCursor),
  limit: ListLimit(CAPSULE_PAGE_SIZE),
});

const CAPSULE_PATH = '/capsules/:id';

const deleted = { 204: Type.Null({ description: 'Deleted' }) };

function apiCapsuleUrl(id: number, viewOwner: number | undefined): string {
  return `${API_PREFIX}/capsules/${id}${viewOwner === undefined ? '' : `?ownerId=${viewOwner}`}`;
}

/**
 * Capsules on /api/v1 (#194b; plan section 6), registered by apiPlugin,
 * each calling what its page twin calls (operations.ts names the twin):
 * capsule-actions.ts, which authorizes and refuses itself. Capsules are part
 * of the shared wardrobe (src/web/capsules/AGENTS.md), so every route takes
 * `?ownerId=`: a VIEW share reads them, a MANAGE share changes their
 * membership, and creating, renaming and deleting are the owner's. A
 * capsule outside the addressed wardrobe is a 404, a refused change on a
 * visible one a 403. Membership is the writer's own shape, a set change
 * from either side (decisions 2026-11-13, #194b), so a retry is a no-op.
 */
export const capsuleApiRoutes: FastifyPluginCallbackTypebox<ApiOptions> = (
  app,
  { db, logger },
  done,
) => {
  app.get(
    '/capsules',
    {
      schema: {
        operationId: 'listCapsules',
        tags: ['capsules'],
        summary: "A wardrobe's capsules, by name",
        description:
          'Each with how many of its garments are in the closet and the newest few. The closet itself is no capsule: GET /garments.',
        querystring: CapsuleListQuery,
        response: apiResponses({ 200: CapsuleList }),
      },
    },
    async (request) => {
      const { ownerId, cursor, limit = CAPSULE_PAGE_SIZE } = request.query;
      const { access } = await authorizeWardrobe(
        db,
        actorOf(request),
        ownerId,
        'view',
        'capsule',
      );
      // The list page's one statement reads every card (a household holds
      // a few), so a page is a slice of it.
      const offset = cursor === undefined ? 0 : readOffsetCursor(cursor);
      const cards = await listCapsules(db, access.ownerId);
      const more = cards.length > offset + limit;
      return {
        data: cards.slice(offset, offset + limit).map(toCapsuleListItem),
        pagination: {
          ...(more && { nextCursor: offsetCursor(offset + limit) }),
          limit,
        },
      };
    },
  );

  app.get(
    CAPSULE_PATH,
    {
      schema: {
        operationId: 'getCapsule',
        tags: ['capsules'],
        summary: 'One capsule',
        description:
          'Its name and notes. Its garments: GET /garments?capsuleId={id}. A capsule outside the wardrobe is a 404 like an unknown id.',
        params: CapsuleParams,
        querystring: CapsuleQuery,
        response: apiResponses({ 200: Capsule }),
      },
    },
    async (request) => {
      const { capsule } = await requireCapsule(
        db,
        actorOf(request),
        capsuleAddress(request),
        'view',
      );
      return toCapsuleResource(capsule);
    },
  );

  app.post(
    '/capsules',
    {
      schema: {
        operationId: 'createCapsule',
        tags: ['capsules'],
        summary: 'Creates a capsule',
        description:
          'In your own wardrobe only (a share is a 403). Judged as the capsule form is: a blank name, or one another of your capsules has in any case, is a 400 naming `body/name`. 201 with its `Location`. With a `clientId`, a retry answers the first capsule of that id (200, its `Location`) and creates nothing; the id of one deleted since is a 410 `gone`.',
        querystring: CapsuleQuery,
        body: NewCapsule,
        response: apiResponses({ 200: CapsuleCreated, 201: CapsuleCreated }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { ownerId } = request.query;
      const { clientId, ...body } = request.body;
      const form = readCapsuleForm(body);
      if (!form.ok) {
        // As the page: the wardrobe before the form, so a refused form is
        // the owner's to hear of.
        await authorizeWardrobe(db, actor, ownerId, 'own', 'capsule');
        throw refusedBody(form.errors, POINTER_OF_CAPSULE_FIELD);
      }
      const client = clientId ? `, client id ${clientId.slice(0, 8)}` : '';
      const made = clientId
        ? await createOwnCapsuleOnce(db, actor, ownerId, form.fields, clientId)
        : await createOwnCapsule(db, actor, ownerId, form.fields);
      if (made === 'name-taken') {
        throw refusedBody(nameTaken(body).errors, POINTER_OF_CAPSULE_FIELD);
      }
      if (made === 'gone') throw new HttpError(410, t('CAPSULE_DELETED'));
      const created = { created: true, ...made };
      logger.info(
        `Capsule ${created.id} ${created.created ? 'created' : 'already created, retry answered'} by user ${created.access.ownerId} (API)${client}`,
      );
      return reply
        .status(created.created ? 201 : 200)
        .header('Location', apiCapsuleUrl(created.id, created.viewOwner))
        .send({ id: created.id });
    },
  );

  app.put(
    CAPSULE_PATH,
    {
      schema: {
        operationId: 'updateCapsule',
        tags: ['capsules'],
        summary: "Replaces a capsule's name and notes",
        description:
          "The capsule form's save, the owner's alone: both fields replaced, judged as on create. Its garments stay as they are.",
        params: CapsuleParams,
        querystring: CapsuleQuery,
        body: CapsuleInput,
        response: apiResponses({ 200: Capsule }),
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const address = capsuleAddress(request);
      const form = readCapsuleForm(request.body);
      if (!form.ok) {
        // As the page: another's capsule is its 404 whatever was sent.
        await requireCapsule(db, actor, address, 'own');
        throw refusedBody(form.errors, POINTER_OF_CAPSULE_FIELD);
      }
      const saved = await renameCapsule(db, actor, address, form.fields);
      if (saved === 'name-taken') {
        throw refusedBody(
          nameTaken(request.body).errors,
          POINTER_OF_CAPSULE_FIELD,
        );
      }
      logger.info(
        `Capsule ${address.id} updated by user ${saved.access.ownerId} (API)`,
      );
      return toCapsuleResource({ id: address.id, ...form.fields });
    },
  );

  app.delete(
    CAPSULE_PATH,
    {
      schema: {
        operationId: 'deleteCapsule',
        tags: ['capsules'],
        summary: 'Deletes a capsule',
        description:
          "The owner's alone. Its garments stay in the closet. A capsule already gone is a 404, which a retry may read as done.",
        params: CapsuleParams,
        querystring: CapsuleQuery,
        response: apiResponses(deleted),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { access } = await deleteOwnCapsule(
        db,
        actorOf(request),
        capsuleAddress(request),
      );
      logger.info(`Capsule ${id} deleted by user ${access.ownerId} (API)`);
      return reply.status(204).send(null);
    },
  );

  app.patch(
    `${CAPSULE_PATH}/members`,
    {
      schema: {
        operationId: 'changeCapsuleMembers',
        tags: ['capsules'],
        summary: 'Adds garments to a capsule and takes others out',
        description:
          "The picker's save and set_capsule_membership's: your own wardrobe or a MANAGE share. Removals first, then additions. A capsule outside the wardrobe is a 404, after a write that changed nothing.",
        params: CapsuleParams,
        querystring: CapsuleQuery,
        body: CapsuleMembersChange,
        response: apiResponses({ 200: MembershipChanged }),
      },
    },
    async (request) => {
      const { id } = request.params;
      const { add = [], remove = [] } = request.body;
      const { access, added, removed } = await setCapsuleMembers(
        db,
        actorOf(request),
        capsuleAddress(request),
        { add, remove },
      );
      logger.info(
        `Capsule ${id} garments changed by user ${actorOf(request).userId} in wardrobe ${access.ownerId} (API): ${added} added, ${removed} removed`,
      );
      return { added, removed };
    },
  );

  app.patch(
    '/garments/:id/capsules',
    {
      schema: {
        operationId: 'changeGarmentCapsules',
        tags: ['capsules'],
        summary: 'Puts a garment in capsules and takes it out of others',
        description:
          "The garment page's capsule toggles: your own wardrobe or a MANAGE share. A garment outside the wardrobe is a 404, after a write that changed nothing.",
        params: GarmentParams,
        querystring: CapsuleQuery,
        body: GarmentCapsulesChange,
        response: apiResponses({ 200: MembershipChanged }),
      },
    },
    async (request) => {
      const { id } = request.params;
      const { add = [], remove = [] } = request.body;
      const { access, added, removed } = await setGarmentCapsules(
        db,
        actorOf(request),
        garmentAddress(request),
        { add, remove },
      );
      logger.info(
        `Garment ${id} capsules changed by user ${actorOf(request).userId} in wardrobe ${access.ownerId} (API): ${added} added, ${removed} removed`,
      );
      return { added, removed };
    },
  );

  done();
};
