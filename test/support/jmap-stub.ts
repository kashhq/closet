import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppOptions } from '../../src/app';
import { isPublicAddress } from '../../src/web/security/public-address';
import type {
  DestinationPolicy,
  ResolvedAddress,
} from '../../src/web/security/outbound-fetch';

/**
 * A stand-in for Fastmail's JMAP API (#25), so no spec ever reaches the
 * real service: an HTTP server on the loopback alias 127.0.0.2 (Linux
 * routes all of 127/8 to lo; macOS needs `sudo ifconfig lo0 alias
 * 127.0.0.2`), reached as `jmap.test` through a scripted resolver and an
 * address policy that admits that one address, like the weather's stub.
 * Hand `options` to createTestApp (`orderMail`).
 *
 * It answers what the order mail asks (RFC 8620/8621, the parts closet
 * uses): the session, Mailbox/query for the inbox, Email/query (inMailbox,
 * an inclusive `after`, receivedAt ascending, a limit) and Email/get (the
 * requested properties, `header:Authentication-Results:asText:all`, and
 * the values of the htmlBody parts with fetchHTMLBodyValues). Every
 * request must carry the stub's token as a Bearer credential, else 401.
 * `calls` records each method called, in order, for the specs to count.
 */

const STUB_IP = '127.0.0.2';
const STUB_HOST = 'jmap.test';
const ACCOUNT_ID = 'u1a2b3c4';
const INBOX_ID = 'mb-inbox';
const AUTH_RESULTS = 'header:Authentication-Results:asText:all';

/** An email as the stub stores it: JMAP's Email properties, parsed. */
export interface StubEmail {
  id: string;
  receivedAt: string;
  from: { name?: string; email: string }[];
  subject?: string;
  /** Every Authentication-Results header, topmost first. */
  authenticationResults: string[];
  htmlBody: { partId: string; type: string }[];
  textBody?: { partId: string; type: string }[];
  bodyValues: Record<string, { value: string }>;
}

export interface JmapStub {
  options: NonNullable<AppOptions['orderMail']>;
  /** Puts an email in the inbox. */
  deliver(email: StubEmail): void;
  /** Every method called (`Email/get`, ...), in order; body gets as `Email/get body`. */
  calls: string[];
  /** Answers every request with this status until reset (undefined). */
  failWith(status: number | undefined): void;
  /**
   * Fails the body read of email `id` until reset (undefined): an HTTP
   * status, `shape` (an answer of the wrong shape) or `method` (a JMAP
   * method error, serverUnavailable) (#693).
   */
  failBodyOf(id: string, failure: BodyFailure | undefined): void;
  /** Takes an email out of the inbox (deleted or moved). */
  remove(id: string): void;
  close(): Promise<void>;
}

type BodyFailure = number | 'shape' | 'method';

const TEST_INTERNET: DestinationPolicy = {
  allowsAddress: (address) => address === STUB_IP || isPublicAddress(address),
  allowsPort: () => true,
};

function resolve(hostname: string): Promise<ResolvedAddress[]> {
  return hostname === STUB_HOST
    ? Promise.resolve([{ address: STUB_IP, family: 4 }])
    : Promise.reject(
        Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
          code: 'ENOTFOUND',
        }),
      );
}

type Invocation = [string, Record<string, unknown>, string];

export async function startJmapStub(token: string): Promise<JmapStub> {
  const inbox: StubEmail[] = [];
  const calls: string[] = [];
  let failure: number | undefined;
  const bodyFailures = new Map<string, BodyFailure>();
  let origin = '';

  const methods: Record<
    string,
    (args: Record<string, unknown>) => Record<string, unknown>
  > = {
    'Mailbox/query': () => ({ accountId: ACCOUNT_ID, ids: [INBOX_ID] }),
    'Email/query': (args) => {
      const filter = (args.filter ?? {}) as {
        inMailbox?: string;
        after?: string;
      };
      const after = filter.after ? Date.parse(filter.after) : -Infinity;
      const ids = inbox
        .filter(
          (email) =>
            filter.inMailbox === INBOX_ID &&
            Date.parse(email.receivedAt) >= after,
        )
        .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))
        .slice(0, Number(args.limit ?? 256))
        .map((email) => email.id);
      return { accountId: ACCOUNT_ID, ids };
    },
    'Email/get': (args) => {
      const ids = args.ids as string[];
      const properties = args.properties as string[];
      const found = ids
        .map((id) => inbox.find((email) => email.id === id))
        .filter((email): email is StubEmail => email !== undefined);
      return {
        accountId: ACCOUNT_ID,
        list: found.map((email) => emailProperties(email, properties, args)),
        notFound: ids.filter((id) => !found.some((email) => email.id === id)),
      };
    },
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const answer = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (failure !== undefined) return answer(failure, { type: 'failure' });
    if (req.headers.authorization !== `Bearer ${token}`) {
      return answer(401, { type: 'unauthorized' });
    }
    if (req.method === 'GET' && req.url === '/jmap/session') {
      return answer(200, {
        apiUrl: `${origin}/jmap/api/`,
        primaryAccounts: { 'urn:ietf:params:jmap:mail': ACCOUNT_ID },
        capabilities: {},
      });
    }
    if (req.method === 'POST' && req.url === '/jmap/api/') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        methodCalls: Invocation[];
      };
      const bodyFailure = request.methodCalls
        .filter(
          ([name, args]) => name === 'Email/get' && args.fetchHTMLBodyValues,
        )
        .flatMap(([, args]) => args.ids as string[])
        .map((id) => bodyFailures.get(id))
        .find((found) => found !== undefined);
      if (typeof bodyFailure === 'number') {
        calls.push('Email/get body');
        return answer(bodyFailure, { type: 'failure' });
      }
      const methodResponses = request.methodCalls.map(([name, args, tag]) => {
        const isBody = name === 'Email/get' && args.fetchHTMLBodyValues;
        calls.push(isBody ? 'Email/get body' : name);
        if (isBody && bodyFailure === 'shape') {
          return [name, { accountId: ACCOUNT_ID, list: [{ id: 1 }] }, tag];
        }
        if (isBody && bodyFailure === 'method') {
          return ['error', { type: 'serverUnavailable' }, tag];
        }
        const method = methods[name];
        return method
          ? [name, method(args), tag]
          : ['error', { type: 'unknownMethod' }, tag];
      });
      return answer(200, { methodResponses, sessionState: 'stub' });
    }
    return answer(404, { type: 'notFound' });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, STUB_IP, done);
  });
  const { port } = server.address() as AddressInfo;
  origin = `http://${STUB_HOST}:${port}`;
  return {
    options: {
      sessionUrl: `${origin}/jmap/session`,
      fetch: { resolve, destinations: TEST_INTERNET },
    },
    deliver: (email) => inbox.push(email),
    calls,
    failWith: (status) => {
      failure = status;
    },
    failBodyOf: (id, bodyFailure) => {
      if (bodyFailure === undefined) bodyFailures.delete(id);
      else bodyFailures.set(id, bodyFailure);
    },
    remove: (id) => {
      const index = inbox.findIndex((email) => email.id === id);
      if (index >= 0) inbox.splice(index, 1);
    },
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

/** The requested properties of `email`, as Email/get answers them. */
function emailProperties(
  email: StubEmail,
  properties: readonly string[],
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const property of properties) {
    if (property === AUTH_RESULTS) {
      out[property] = email.authenticationResults;
    } else if (property === 'bodyValues') {
      out.bodyValues = args.fetchHTMLBodyValues
        ? Object.fromEntries(
            email.htmlBody.map(({ partId }) => [
              partId,
              {
                ...email.bodyValues[partId],
                isEncodingProblem: false,
                isTruncated: false,
              },
            ]),
          )
        : {};
    } else if (property === 'htmlBody') {
      out.htmlBody = email.htmlBody;
    } else {
      out[property] = email[property as keyof StubEmail] ?? null;
    }
  }
  return out;
}
