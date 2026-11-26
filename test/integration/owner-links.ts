import Fastify, { type InjectOptions, type RouteOptions } from 'fastify';
import { isStaticPath } from '../../src/static-prefixes';
import { unescapeHtml } from './harness';

/**
 * Every request a page can make that carries `?ownerId=` (#680): a link,
 * a form's submission, an htmx request (with the fields htmx sends with
 * it, which are the query string on a GET), each resolved by Fastify's own router to the route it reaches. A
 * grantee's share-aware page that sends `ownerId` to a route that is not
 * share-aware (no OwnerQuery: markShareAware's stamp) lands on a 404
 * (refuseForeignOwner). The authorization matrix runs it over every page a
 * grantee opens through `?ownerId=`, so it follows routes as they are
 * added. Read from the server's HTML with patterns, not a DOM: the views
 * render every attribute double-quoted.
 */

interface Tag {
  name: string;
  attrs: Map<string, string>;
  /** Where the tag starts in the page. */
  at: number;
}

interface Form {
  id: string | undefined;
  start: number;
  end: number;
  tag: Tag;
}

/** A request a page can make, and whether it sends an `ownerId` field. */
interface PageRequest {
  /** `script`: a URL a client module reads from a `data-*` attribute, its verb its own. */
  method: Verb | 'script';
  url: string;
  sendsOwnerField: boolean;
  /** The markup it comes from, for the report. */
  source: string;
}

function tagsOf(html: string): Tag[] {
  return [...html.matchAll(/<([a-zA-Z][\w-]*)\b((?:[^>"]|"[^"]*")*)>/g)].map(
    (match) => ({
      name: match[1].toLowerCase(),
      at: match.index,
      attrs: new Map(
        [...match[2].matchAll(/([\w:.-]+)(?:="([^"]*)")?/g)].map(
          ([, name, value]) => [name, unescapeHtml(value ?? '')],
        ),
      ),
    }),
  );
}

function formsOf(html: string, tags: Tag[]): Form[] {
  return tags
    .filter((tag) => tag.name === 'form')
    .map((tag) => ({
      id: tag.attrs.get('id'),
      start: tag.at,
      end: html.indexOf('</form>', tag.at),
      tag,
    }));
}

/** The fields named `ownerId`, by the form they submit with. */
function ownerFieldForms(tags: Tag[], forms: Form[]): Set<Form> {
  const holding = new Set<Form>();
  for (const tag of tags) {
    if (tag.attrs.get('name') !== 'ownerId') continue;
    const owner = tag.attrs.get('form');
    const form = owner
      ? forms.find(({ id }) => id === owner)
      : enclosingForm(forms, tag);
    if (form) holding.add(form);
  }
  return holding;
}

function enclosingForm(forms: Form[], tag: Tag): Form | undefined {
  return forms.find(({ start, end }) => tag.at > start && tag.at < end);
}

/**
 * Whether htmx sends an `ownerId` field with `tag`'s request: a form's own
 * fields, the enclosing form's on a non-GET (htmx 2 includes it), and
 * whatever `hx-include` names (`closest form`, `#id`, a list).
 */
function sendsOwnerField(
  tag: Tag,
  method: string,
  tags: Tag[],
  forms: Form[],
  holding: Set<Form>,
): boolean {
  if (tag.attrs.get('name') === 'ownerId') return true;
  const enclosing =
    tag.name === 'form' ? formOf(tag, forms) : enclosingForm(forms, tag);
  if (
    enclosing &&
    (tag.name === 'form' || method !== 'GET') &&
    holding.has(enclosing)
  ) {
    return true;
  }
  const include = tag.attrs.get('hx-include');
  if (!include) return false;
  return include.split(',').some((selector) => {
    const trimmed = selector.trim();
    if (trimmed === 'closest form' || trimmed === 'this') {
      return enclosing !== undefined && holding.has(enclosing);
    }
    if (!trimmed.startsWith('#')) return false;
    const target = tags.find(
      (other) => other.attrs.get('id') === trimmed.slice(1),
    );
    if (!target) return false;
    if (target.attrs.get('name') === 'ownerId') return true;
    const form = target.name === 'form' ? formOf(target, forms) : undefined;
    return form !== undefined && holding.has(form);
  });
}

function formOf(tag: Tag, forms: Form[]): Form | undefined {
  return forms.find((form) => form.tag === tag);
}

/** The methods the app routes (HEAD runs its GET's hooks). */
const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type Verb = (typeof VERBS)[number];

function isVerb(method: string): method is Verb {
  return (VERBS as readonly string[]).includes(method);
}

/** A form's method as a verb; `dialog` and the like send nothing. */
function verbOf(method: string | undefined): Verb | undefined {
  const upper = (method ?? 'GET').toUpperCase();
  return isVerb(upper) ? upper : undefined;
}

type FoundRequest = { method: PageRequest['method'] | undefined; url: string };

/** A link's, a form's action's and a submit button's formaction. */
function nativeRequestsOf(tag: Tag, forms: Form[]): FoundRequest[] {
  const { attrs } = tag;
  const found: FoundRequest[] = [];
  const href = attrs.get('href');
  if (href && tag.name === 'a') found.push({ method: 'GET', url: href });
  const action = attrs.get('action');
  if (action !== undefined && tag.name === 'form') {
    found.push({ method: verbOf(attrs.get('method')), url: action });
  }
  const formaction = attrs.get('formaction');
  if (formaction !== undefined) {
    const formMethod = enclosingForm(forms, tag)?.tag.attrs.get('method');
    found.push({
      method: verbOf(attrs.get('formmethod') ?? formMethod),
      url: formaction,
    });
  }
  return found;
}

/**
 * The requests one tag makes: native ones, htmx's, and a same-origin path
 * in a `data-*` attribute (a client module's).
 */
function requestsOf(tag: Tag, forms: Form[]): FoundRequest[] {
  const htmx = VERBS.flatMap((verb) => {
    const url = tag.attrs.get(`hx-${verb.toLowerCase()}`);
    return url === undefined ? [] : [{ method: verb, url }];
  });
  const scripted = [...tag.attrs].flatMap(([name, value]) =>
    name.startsWith('data-') && /^\/(?!\/)/.test(value)
      ? [{ method: 'script' as const, url: value }]
      : [],
  );
  return [...nativeRequestsOf(tag, forms), ...htmx, ...scripted];
}

/** Every request in `html`: links, forms and their buttons' formaction, htmx. */
export function pageRequests(html: string): PageRequest[] {
  const tags = tagsOf(html);
  const forms = formsOf(html, tags);
  const holding = ownerFieldForms(tags, forms);
  return tags.flatMap((tag) =>
    requestsOf(tag, forms).flatMap(({ method, url }) =>
      method === undefined
        ? []
        : [
            {
              method,
              url,
              sendsOwnerField: sendsOwnerField(
                tag,
                method,
                tags,
                forms,
                holding,
              ),
              source: `<${tag.name} ${[...tag.attrs].map(([k, v]) => `${k}="${v}"`).join(' ')}>`,
            },
          ],
    ),
  );
}

/**
 * The same-origin, non-static URL `request` reaches when it carries a
 * `?ownerId=` to the server: in its URL, or a field on a GET, whose fields
 * are the query (refuseForeignOwner reads the query string alone, never a
 * POST's body). Undefined for anything else.
 */
function ownerIdTarget(request: PageRequest, page: string): URL | undefined {
  const target = new URL(request.url, `http://localhost${page}`);
  if (target.origin !== 'http://localhost') return undefined;
  if (isStaticPath(target.pathname)) return undefined;
  const named = target.searchParams.get('ownerId');
  const queried = request.sendsOwnerField && request.method === 'GET';
  return named || queried ? target : undefined;
}

/**
 * A checker over the app's routes: the requests of a page that send
 * `ownerId` (in the query or a field) to a route that is not share-aware.
 * Each route of a mirror router answers whether it is.
 */
export async function ownerLinkChecker(registered: RouteOptions[]) {
  const mirror = Fastify({ exposeHeadRoutes: false });
  for (const route of registered) {
    for (const method of [route.method].flat().filter(isVerb)) {
      mirror.route({
        method,
        url: route.url,
        handler: (_request, reply) =>
          reply.send({ shareAware: route.config?.shareAware === true }),
      });
    }
  }
  await mirror.ready();
  /** Whether each route `path` reaches under `verbs` is share-aware; none: no route. */
  const routesAt = async (verbs: readonly Verb[], path: string) => {
    const found: boolean[] = [];
    for (const method of verbs) {
      const res = await mirror.inject({ method, url: path });
      if (res.statusCode === 200) {
        found.push(res.json<{ shareAware: boolean }>().shareAware);
      }
    }
    return found;
  };
  return {
    /** `page` is the URL the page was requested at, which resolves its relative links. */
    async offenders(
      html: string,
      page: InjectOptions['url'],
    ): Promise<string[]> {
      if (typeof page !== 'string') throw new Error('A page URL is a string');
      const offending: string[] = [];
      for (const request of pageRequests(html)) {
        const target = ownerIdTarget(request, page);
        if (!target) continue;
        const routes = await routesAt(
          request.method === 'script' ? VERBS : [request.method],
          target.pathname,
        );
        if (routes.length > 0 && !routes.some(Boolean)) {
          offending.push(
            `${request.method} ${target.pathname}${target.search}: ${request.source}`,
          );
        }
      }
      return offending;
    },
    close: () => mirror.close(),
  };
}
