import { createServer, type Server } from 'node:https';
import type { OutboundStandIn } from '../../src/web/security/outbound-fetch';
import { selfSignedCertificate } from './tls-certificate';

/**
 * An OAuth client on the "internet" for the e2e consent scenario
 * (test/oauth-consent.spec.ts, #1290): its Client ID Metadata Document over
 * TLS, listing one loopback redirect URI (any port, RFC 8252). The test
 * server (test-server.ts) starts it when MCP_PUBLIC_URL is set and hands
 * `fetch` to the app, so the consent's one outbound fetch reaches it; the
 * name resolves to the loopback alias 127.0.0.2 alone, with its throwaway
 * certificate trusted only through `fetch.tls`, as weather-stub.ts and
 * test/integration/link-sites.ts do. Every other name fails to resolve: an
 * e2e run reaches nothing else.
 *
 * Its port is derived from PORT (as E2E_SENTRY_DSN's is), so the spec's
 * process knows the client id the server's will fetch, and worktrees
 * running side by side never share one.
 */
const CLIENT_HOST = 'oauth-client.test';
const STUB_IP = '127.0.0.2';
const STUB_PORT = Number(process.env.PORT ?? '3000') + 20000;

export const OAUTH_CLIENT_ID = `https://${CLIENT_HOST}:${STUB_PORT}/client.json`;
/** Listed portless: a request may name any port on it. */
export const OAUTH_CLIENT_REDIRECT = 'http://127.0.0.1/callback';

export interface OAuthClientStub {
  fetch: OutboundStandIn;
  close(): Promise<void>;
}

export async function startOAuthClientStub(): Promise<OAuthClientStub> {
  const certificate = selfSignedCertificate([CLIENT_HOST]);
  const document = JSON.stringify({
    client_id: OAUTH_CLIENT_ID,
    client_name: 'Stub Agent',
    redirect_uris: [OAUTH_CLIENT_REDIRECT],
  });
  const server: Server = createServer(certificate, (req, res) => {
    if (req.url !== new URL(OAUTH_CLIENT_ID).pathname) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(document);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(STUB_PORT, STUB_IP, resolve);
  });
  return {
    fetch: {
      resolve: (hostname) =>
        hostname === CLIENT_HOST
          ? Promise.resolve([{ address: STUB_IP, family: 4 }])
          : Promise.reject(
              Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
                code: 'ENOTFOUND',
              }),
            ),
      destinations: {
        allowsAddress: (address) => address === STUB_IP,
        allowsPort: (port) => port === STUB_PORT,
      },
      tls: { ca: [certificate.cert] },
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
