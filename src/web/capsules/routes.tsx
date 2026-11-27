import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply } from 'fastify';
import { selectScalars } from '../../db/select-scalars';
import { sessionUserId } from '../auth/require-session';
import { AutosaveSaved } from '../autosave';
import { unchecked } from '../checklist';
import type { WebOptions } from '../plugin';
import { navigateTo, renderFragment, renderPage } from '../render';
import {
  actorOf,
  sharedWardrobesSql,
  toSharedWardrobe,
  wardrobeGuard,
} from '../sharing/access';
import { viewContext } from '../view-context';
import { CLOSET_FILTERS, gridCount, gridPage } from '../wardrobe/queries';
import { capsuleUrl } from '../wardrobe/urls';
import { GarmentParams, OwnerQuery } from '../schemas';
import { CapsulePage } from './capsule-page';
import { CapsuleFormPage, type CapsuleFormModel } from './form-page';
import { CapsulesPage } from './list-page';
import {
  capsuleAddress,
  capsuleIn,
  createOwnCapsule,
  deleteOwnCapsule,
  renameCapsule,
  requireCapsule,
  setCapsuleMembers,
  setGarmentCapsules,
} from './capsule-actions';
import { capsuleListSql, readCapsuleList } from './queries';
import {
  CapsuleBody,
  CapsulePageQuery,
  type CapsuleForm,
  CapsuleParams,
  GarmentCapsulesBody,
  MembersBody,
  nameTaken,
  readCapsuleForm,
} from './validation';
import { garmentAddress } from '../wardrobe/garment-access';

/** One capsule's route: its page, its rename and its delete. */
const CAPSULE_ROUTE = '/capsules/:id';

/**
 * /capsules (plan section 2; owner decision on #8): capsules are part of
 * the wardrobe, so every route takes `?ownerId=` and resolves it through
 * wardrobeGuard like the garment routes. A VIEW grantee lists and opens
 * the grantor's capsules (and filters the grid by one), a MANAGE grantee
 * also changes their membership (the picker, the garment page's toggles),
 * and only the owner creates, renames and deletes them. A capsule outside
 * the addressed wardrobe is a 404 like an unknown id; one the requester
 * can see but not change is a 403. Each refusal is the capsule access
 * path's (capsule-actions.ts, #188); a route asks its guard first only
 * where a refused form must be drawn for the right audience.
 */
export const capsuleRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  options,
  done,
) => {
  const { db, logger } = options;
  const deps = { db, logger };

  const authorize = wardrobeGuard(db, 'capsule');

  function renderForm(
    reply: FastifyReply,
    model: CapsuleFormModel,
    status = 200,
  ): Promise<FastifyReply> {
    return renderPage(
      reply,
      <CapsuleFormPage ctx={viewContext(reply)} model={model} />,
      { status },
    );
  }

  /**
   * The form again with what is wrong (a blank name, one the owner already
   * uses): a 400 re-render, which is why the form is a native post.
   */
  function refuseForm(
    reply: FastifyReply,
    refused: CapsuleForm & { ok: false },
    capsuleId?: number,
  ): Promise<FastifyReply> {
    logger.warn(
      `Capsule form refused (${capsuleId === undefined ? 'new' : `capsule ${capsuleId}`}): ${refused.errors.name?.join(' ')}`,
    );
    return renderForm(
      reply,
      {
        capsuleId,
        values: {
          name: refused.values.name,
          notes: refused.values.notes ?? '',
        },
        errors: refused.errors,
      },
      400,
    );
  }

  app.get(
    '/capsules',
    { schema: { querystring: OwnerQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await authorize(request, 'view');
      // The cards and the switcher: one statement (#170; it was four).
      const row = await selectScalars(db, {
        ...capsuleListSql(access.ownerId),
        sharedWardrobes: sharedWardrobesSql(sessionUserId(request)),
      });
      return renderPage(
        reply,
        <CapsulesPage
          ctx={viewContext(reply)}
          model={{
            ...readCapsuleList(row),
            viewOwner,
            sharedWardrobes: row.sharedWardrobes.map(toSharedWardrobe),
            canEdit: access.canManage,
            isOwner: access.isOwner,
          }}
        />,
      );
    },
  );

  app.get(
    '/capsules/new',
    { schema: { querystring: OwnerQuery } },
    async (request, reply) => {
      await authorize(request, 'own');
      return renderForm(reply, { values: { name: '', notes: '' } });
    },
  );

  app.post(
    '/capsules',
    { schema: { querystring: OwnerQuery, body: CapsuleBody } },
    async (request, reply) => {
      // The guard before the form: a refused form is the owner's to see.
      await authorize(request, 'own');
      const form = readCapsuleForm(request.body);
      if (!form.ok) return refuseForm(reply, form);
      const created = await createOwnCapsule(
        deps,
        actorOf(request),
        request.query.ownerId,
        form.fields,
      );
      if (created === 'name-taken') {
        return refuseForm(reply, nameTaken(request.body));
      }
      return reply.redirect(
        capsuleUrl(created.id, undefined, '', { created: 1 }),
        303,
      );
    },
  );

  app.get(
    CAPSULE_ROUTE,
    { schema: { params: CapsuleParams, querystring: CapsulePageQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await authorize(request, 'view');
      // All three at once (one round trip, not two): the members' reads
      // need no lookup first, since inCapsule matches nothing outside the
      // capsule's own wardrobe, and a capsule not found is a 404 whatever
      // they read.
      const filters = { ...CLOSET_FILTERS, capsule: request.params.id };
      const [capsule, page, count] = await Promise.all([
        capsuleIn(db, access, request.params.id),
        gridPage(db, access, filters, { ownerView: access.isOwner }),
        gridCount(db, access, filters),
      ]);
      const { created, added, removed } = request.query;
      return renderPage(
        reply,
        <CapsulePage
          ctx={viewContext(reply)}
          model={{
            capsule,
            page,
            count,
            viewOwner,
            canEdit: access.canManage,
            isOwner: access.isOwner,
            created: created === '1',
            saved:
              added === undefined && removed === undefined
                ? undefined
                : { added: added ?? 0, removed: removed ?? 0 },
          }}
        />,
      );
    },
  );

  app.get(
    '/capsules/:id/edit',
    { schema: { params: CapsuleParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { capsule } = await requireCapsule(
        db,
        actorOf(request),
        capsuleAddress(request),
        'own',
      );
      return renderForm(reply, {
        capsuleId: capsule.id,
        values: { name: capsule.name, notes: capsule.notes ?? '' },
      });
    },
  );

  // Rename (and notes). A refused form writes nothing and re-renders (400).
  app.post(
    CAPSULE_ROUTE,
    {
      schema: {
        params: CapsuleParams,
        querystring: OwnerQuery,
        body: CapsuleBody,
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const address = capsuleAddress(request);
      const { id } = address;
      // The capsule before the form: a blank name on another's capsule is
      // its 404, and a refused form is the owner's to see.
      await requireCapsule(db, actor, address, 'own');
      const form = readCapsuleForm(request.body);
      if (!form.ok) return refuseForm(reply, form, id);
      const saved = await renameCapsule(deps, actor, address, form.fields);
      if (saved === 'name-taken') {
        return refuseForm(reply, nameTaken(request.body), id);
      }
      return reply.redirect(capsuleUrl(id, undefined), 303);
    },
  );

  // htmx (hx-delete, hx-confirm): owner only. The garments stay.
  app.delete(
    CAPSULE_ROUTE,
    { schema: { params: CapsuleParams, querystring: OwnerQuery } },
    async (request, reply) => {
      await deleteOwnCapsule(deps, actorOf(request), capsuleAddress(request));
      return navigateTo(reply, '/capsules');
    },
  );

  // The picker's Save (a native post from the grid in `?pick=` mode): the
  // tiles it showed become members exactly when checked; members it never
  // showed are left alone. Ids outside the wardrobe are dropped. Back to
  // the capsule with a toast saying what changed. No capsule lookup first
  // (#251): the writer drops a capsule outside the wardrobe, writing
  // nothing, and says so, which is the 404.
  app.post(
    '/capsules/:id/garments',
    {
      schema: {
        params: CapsuleParams,
        querystring: OwnerQuery,
        body: MembersBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { ids, shown } = request.body ?? {};
      const { viewOwner, added, removed } = await setCapsuleMembers(
        deps,
        actorOf(request),
        capsuleAddress(request),
        { add: ids ?? [], remove: unchecked(shown, ids) },
      );
      // The toast's counts, as query parameters.
      return reply.redirect(
        capsuleUrl(id, viewOwner, '', { added, removed }),
        303,
      );
    },
  );

  // The garment page's capsules row toggles (an AutosaveForm, on every
  // change): the capsules the section listed hold the garment exactly when
  // checked. The answer is the form's status line, never the toggles (see
  // src/web/autosave.tsx). No garment lookup first (#251): a garment
  // outside the wardrobe takes no part in the write, and the writer says
  // so (a wishlist item is found, and changes nothing).
  app.post(
    '/wardrobe/:id/capsules',
    {
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: GarmentCapsulesBody,
      },
    },
    async (request, reply) => {
      const { capsuleIds, shown } = request.body ?? {};
      await setGarmentCapsules(
        deps,
        actorOf(request),
        garmentAddress(request),
        { add: capsuleIds ?? [], remove: unchecked(shown, capsuleIds) },
      );
      return renderFragment(reply, <AutosaveSaved />);
    },
  );

  done();
};
