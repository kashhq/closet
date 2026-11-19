import type { InjectOptions, RouteOptions } from 'fastify';
import { expect, it } from 'vitest';
import {
  type OperationId,
  PAGE_WRITES,
  type Parity,
  twinOperations,
} from '../../src/web/api/operations';
import { recordQueries, type TestApp } from './harness';

/**
 * An API route pinned to its page twin's statement count (#721): the
 * parity manifest (PAGE_WRITES, src/web/api/operations.ts) names the twin's
 * operation, the app's own registration its method, URL and success status,
 * so a case says only what the two requests send. Used by
 * api-statements.spec.ts.
 */

/** The statements `work`'s request sent, its status and their SQL. */
export async function statementsOf(
  work: () => Promise<{ statusCode: number }>,
) {
  let status = 0;
  const record = await recordQueries(async () => {
    status = (await work()).statusCode;
  });
  return { status, statements: record.statements, sql: record.sql };
}

/** `request`'s statements on the API as a second call of the minute: no last-use write. */
export async function apiStatementsOf(
  app: TestApp,
  token: string,
  request: InjectOptions,
) {
  await app.api(token, { method: 'GET', url: '/api/v1/me' });
  return statementsOf(() => app.api(token, request));
}

type Body<S> = object | ((s: S) => object);

/** A page route's `METHOD /template`: a PAGE_WRITES key, or a read's. */
type PageRoute = keyof typeof PAGE_WRITES | `GET /${string}`;

export interface TwinCase<S, G> {
  page: PageRoute;
  /** The twin, where the manifest names several, or none (a read). */
  op?: OperationId;
  /** A second case on one route says how it differs. */
  label?: string;
  /** The page's status: 200 for a GET or a DELETE, 303 otherwise. */
  status?: number;
  /** The rows this case needs, which its group's setup reads. */
  given?: G;
  /** Both templates' params: the setup's own fields by default. */
  ids?: (s: S) => object;
  /** The page's payload. */
  form?: Body<S>;
  /** The API's payload. */
  json?: Body<S>;
  /** One payload both send. */
  body?: Body<S>;
  /** One query both send. */
  query?: Body<S>;
  /** Multipart parts both send, the page's field name and the API's. */
  files?: [page: string, api: string];
  /** Statements the API pays beyond its page twin (negative: fewer), with why beside it. */
  extra?: number;
}

export interface TwinGroup<S, G> {
  /** The app both twins run on. */
  app: () => TestApp;
  token: () => string;
  /** One side's rows, made before each case, a set for each side. */
  setup: (given?: G) => Promise<S>;
  /** The page's session, where it is not the app owner's. */
  cookie?: () => string;
  /** A multipart body with `field`, for a case's `files`. */
  upload?: (field: string) => Promise<{ payload: Buffer; headers: object }>;
  /** Each API request's own count, where the group pins it as well. */
  statements?: number;
}

interface ApiRoute {
  method: string;
  url: string;
  /** The highest 2xx the route declares: 201 over a create's retry 200. */
  status: number;
}

/** The case's operation: its page write's twin in the manifest, or a read's named one. */
function twinOf({ page, op }: { page: PageRoute; op?: OperationId }) {
  const parity = (PAGE_WRITES as Readonly<Record<string, Parity>>)[page];
  if (parity === undefined) {
    if (!page.startsWith('GET ') || !op) {
      throw new Error(
        `${page}: a read names its op; a write is in PAGE_WRITES`,
      );
    }
    return op;
  }
  if (!('api' in parity)) throw new Error(`${page} has no API twin`);
  const twins = twinOperations(parity.api);
  const chosen = op ?? (twins.length === 1 ? twins[0] : undefined);
  if (!chosen || !twins.includes(chosen)) {
    throw new Error(`${page}: name one of ${twins.join(', ')}`);
  }
  return chosen;
}

/** A route template with its `:params` filled from `params`'s fields. */
function fill(template: string, params: object): string {
  const values = new Map(Object.entries(params));
  return template.replace(/:(\w+)/g, (_, name: string) => {
    if (!values.has(name)) throw new Error(`${template}: no ${name}`);
    return String(values.get(name));
  });
}

const valueOf = <S>(body: Body<S> | undefined, s: S) =>
  typeof body === 'function' ? body(s) : body;

type Side = 'page' | 'api';

/** One side's payload and query. */
function sentBy<S, G>(side: Side, twin: TwinCase<S, G>, s: S) {
  const own = side === 'page' ? twin.form : twin.json;
  const payload = valueOf(twin.body ?? own, s);
  const query = valueOf(twin.query, s) as InjectOptions['query'];
  return { ...(payload && { payload }), ...(query && { query }) };
}

/** One side's multipart body, when the case sends files. */
function partsOf<S, G>(
  side: Side,
  twin: TwinCase<S, G>,
  group: TwinGroup<S, G>,
) {
  const field = twin.files?.[side === 'page' ? 0 : 1];
  if (field === undefined) return undefined;
  if (!group.upload) {
    throw new Error(`${twin.page}: sends files, but its group has no upload`);
  }
  return group.upload(field);
}

/** One side's request: its route filled, then what the case sends. */
async function requestOf<S extends object, G>(
  side: Side,
  [method, template]: [string, string],
  twin: TwinCase<S, G>,
  group: TwinGroup<S, G>,
  s: S,
): Promise<InjectOptions> {
  return {
    method: method as InjectOptions['method'],
    url: fill(template, twin.ids?.(s) ?? s),
    ...sentBy(side, twin, s),
    ...(await partsOf(side, twin, group)),
  };
}

/** The pinned API routes of one spec file: its apps register them through `onRoute`. */
export function twinCounter() {
  const routes = new Map<string, ApiRoute>();

  function onRoute(route: RouteOptions) {
    const id = route.schema?.operationId;
    const method = [route.method].flat().find((m) => m !== 'HEAD');
    if (!id || !method || !route.url.startsWith('/api/v1/')) return;
    const statuses = Object.keys(route.schema?.response ?? {})
      .map(Number)
      .filter((code) => code >= 200 && code < 300);
    routes.set(id, { method, url: route.url, status: Math.max(...statuses) });
  }

  /**
   * Each case on a setup of each side's own: the page twin, then (after a
   * call that spends the minute's last-use write) the API's, which must
   * answer its success status and pay the page's statements plus `extra`.
   */
  function itCounts<S extends object, G = never>(
    group: TwinGroup<S, G>,
    cases: readonly TwinCase<S, G>[],
  ) {
    const named = cases.map((twin) => {
      const op = twinOf(twin);
      const label = twin.label ? `, ${twin.label}` : '';
      return { twin, op, name: `${op} (${twin.page}${label})` };
    });
    it.each(named)('$name', async ({ twin, op }) => {
      const [app, token, route] = [group.app(), group.token(), routes.get(op)];
      if (!route) throw new Error(`${op}: no API route registered`);
      const [onPage, onApi] = [
        await group.setup(twin.given),
        await group.setup(twin.given),
      ];
      const [pageMethod, pageUrl] = twin.page.split(' ');
      const page = await requestOf(
        'page',
        [pageMethod, pageUrl],
        twin,
        group,
        onPage,
      );
      const cookie = group.cookie?.();
      if (cookie) page.headers = { ...page.headers, cookie };
      const pageRun = await statementsOf(() => app.inject(page));
      const api = await requestOf(
        'api',
        [route.method, route.url],
        twin,
        group,
        onApi,
      );
      const apiRun = await apiStatementsOf(app, token, api);
      const pageOk = ['GET', 'DELETE'].includes(pageMethod) ? 200 : 303;
      expect([pageRun.status, apiRun.status]).toEqual([
        twin.status ?? pageOk,
        route.status,
      ]);
      expect(apiRun.statements).toBe(pageRun.statements + (twin.extra ?? 0));
      if (group.statements !== undefined) {
        expect(apiRun.statements).toBe(group.statements);
      }
    });
  }

  return { onRoute, itCounts };
}
