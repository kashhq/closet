import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  request as upstreamRequest,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { APP_ORIGIN } from './e2e-session';

/**
 * The app on an origin of its own, where a spec can deploy a new build of
 * the service worker (test/sw-update.spec.ts). A reverse proxy in front of
 * Playwright's server: everything passes through untouched (the Host
 * header included, so the same-origin check and redirects name the proxy)
 * until `deploy()`, after which `/sw.js` answers the server's worker with a
 * few lines appended. The browser's own update check then finds new bytes
 * at the same URL, as it does after a real deploy.
 *
 * Why a proxy: neither `context.route` nor CDP's Fetch domain sees the
 * browser fetching a registered worker's script to check for an update, so
 * no route can change what that check finds. And being its own origin
 * (another port of localhost) gives the spec a worker registration no other
 * spec shares, while the session cookie (localhost, any port) carries over.
 */
export interface NextBuild {
  /** `http://localhost:<port>`: open the app here. */
  origin: string;
  /**
   * From now on `/sw.js` is a new build, whose worker answers `TEST_BUILD`
   * with the returned id (`controllingBuild`).
   */
  deploy(): string;
  /**
   * The server's status for each warm request (`X-Closet-Warm`) through the
   * proxy, in order, keyed by the request's URL and whether it asked for a
   * fragment: what the worker's refetch was answered, a 304 included, which
   * its own route sees only as the request.
   */
  warmAnswers: WarmAnswer[];
  close(): Promise<void>;
}

export interface WarmAnswer {
  url: string;
  fragment: boolean;
  status: number;
}

export async function startNextBuild(): Promise<NextBuild> {
  const upstream = new URL(APP_ORIGIN);
  let build: string | undefined;
  const warmAnswers: WarmAnswer[] = [];

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://proxy').pathname;
    const forward = (headers: IncomingMessage['headers']) =>
      upstreamRequest({
        host: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers,
      });
    const failed = (error: Error) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(String(error));
    };

    const deployed = build;
    if (deployed !== undefined && path === '/sw.js') {
      // Uncompressed, to append to it.
      const headers = { ...req.headers };
      delete headers['accept-encoding'];
      const proxied = forward(headers);
      proxied.on('response', (answer) => {
        void readBody(answer).then((body) =>
          sendNewBuild(res, answer.statusCode ?? 502, body, deployed),
        );
      });
      proxied.on('error', failed);
      proxied.end();
      return;
    }

    const proxied = forward(req.headers);
    proxied.on('response', (answer) => {
      if (req.headers['x-closet-warm'] !== undefined) {
        warmAnswers.push({
          url: req.url ?? '/',
          fragment: req.headers['hx-request'] === 'true',
          status: answer.statusCode ?? 0,
        });
      }
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    proxied.on('error', failed);
    req.pipe(proxied);
  });

  await new Promise<void>((resolve) =>
    server.listen(0, 'localhost', () => resolve()),
  );
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://localhost:${port}`,
    deploy() {
      build = `build-${randomUUID()}`;
      return build;
    },
    warmAnswers,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function readBody(answer: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of answer) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function sendNewBuild(
  res: ServerResponse,
  status: number,
  worker: string,
  build: string,
) {
  if (status !== 200) {
    res.writeHead(status);
    res.end(worker);
    return;
  }
  // Appended after the minified bundle: one more message the worker
  // answers, so a spec can tell which build controls a page.
  const body = `${worker}
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'TEST_BUILD' && event.ports[0]) {
    event.ports[0].postMessage(${JSON.stringify(build)});
  }
});
`;
  res.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': 'no-cache',
  });
  res.end(body);
}
