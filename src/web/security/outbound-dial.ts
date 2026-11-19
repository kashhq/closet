import {
  type ClientHttp2Session,
  connect as connectHttp2,
  type SecureClientSessionOptions,
} from 'node:http2';
import { connect as connectTcp, isIP, type Socket } from 'node:net';
import { connect as connectTls, type TLSSocket } from 'node:tls';

/**
 * The one way the outbound fetcher (outbound-fetch.ts) opens a connection,
 * and the only module that may (scripts/ci/guards.conf: @outbound-tls,
 * @outbound-tcp, @outbound-http2). It connects to the address `pin()`
 * checked, an IP literal, so nothing between the check and the connect
 * resolves a name (DNS rebinding). Over TLS the certificate is verified
 * against the URL's name, which is also the SNI; a URL naming an IP literal
 * is verified against that IP and sends no SNI (Node refuses an IP as
 * servername). When ALPN picks h2, the HTTP/2 session is built here, on that
 * socket and no other (#496b): no session can reach an address `pin()` did
 * not check, and none is ever reused for another hop.
 */

/**
 * Certificates trusted instead of the system's: the specs' TLS fixture
 * only (test/support/tls-certificate.ts). Never from Config: production
 * verifies against Node's roots.
 */
export interface TrustedCertificates {
  ca: string[];
}

export interface DialTarget {
  /** The URL's host: a name, or an IP literal without brackets. */
  host: string;
  /** The checked address, an IP literal: the only thing connected to. */
  address: string;
  port: number;
  secure: boolean;
  /** The checked URL's origin: an h2 session's authority. */
  origin: string;
}

/** What the fetcher logs: ALPN's answer normalized, never the raw string. */
export type Protocol = 'h2' | 'http/1.1';

/** A connected socket (TLS handshake done), and the session over it for h2. */
export type Connection =
  | { protocol: 'http/1.1'; socket: Socket }
  | { protocol: 'h2'; socket: TLSSocket; session: ClientHttp2Session };

/**
 * h2 first: Shopify's storefronts 429 an HTTP/1.1 client and serve h2
 * (#347). Anything but `h2` (`http/1.1`, or no ALPN answer) is HTTP/1.1 on
 * the same socket: no second dial. Plain http is HTTP/1.1 (no h2c).
 */
const ALPN_PROTOCOLS = ['h2', 'http/1.1'];

/**
 * A hostile server's levers, held short (plan section 7): no server push, a
 * 16 KB header list in at most 100 pairs (past either Node resets the
 * stream, ENHANCE_YOUR_CALM), 1 MB of session memory, and few unanswered
 * pings or settings of ours. The flow-control window stays the default
 * 64 KB: raising it would let a server buffer more ahead of our reads.
 * Floods of frames past these are bounded by the fetch's timeout. Node
 * reads `maxOutstandingSettings` (lib/internal/http2/util.js), which
 * @types/node does not declare.
 */
const HTTP2_LIMITS: SecureClientSessionOptions & {
  maxOutstandingSettings: number;
} = {
  settings: { enablePush: false, maxHeaderListSize: 16 * 1024 },
  maxHeaderListPairs: 100,
  maxSessionMemory: 1,
  maxOutstandingPings: 2,
  maxOutstandingSettings: 2,
  maxReservedRemoteStreams: 0,
};

/** A connection to the target's checked address, its protocol chosen. */
export function dial(
  { host, address, port, secure, origin }: DialTarget,
  signal: AbortSignal,
  trusted: TrustedCertificates | undefined,
): Promise<Connection> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const tlsSocket = secure
      ? connectTls({
          host: address,
          port,
          ...(isIP(host) ? {} : { servername: host }),
          ALPNProtocols: ALPN_PROTOCOLS,
          rejectUnauthorized: true,
          ca: trusted?.ca,
        })
      : undefined;
    const socket = tlsSocket ?? connectTcp({ host: address, port });
    // tls.connect takes no signal: a stalled connect or handshake ends
    // here, at the fetch's timeout. Removed once connected; the request
    // then holds the signal.
    const onAbort = () => socket.destroy(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    // Attached before the socket can emit and never removed: after the
    // hand-off the request listens too, but an error the moment it detaches
    // (a reset as the response ends) must not reach the process unheard.
    socket.on('error', (error: Error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      signal.removeEventListener('abort', onAbort);
      if (tlsSocket?.alpnProtocol !== 'h2') {
        resolve({ protocol: 'http/1.1', socket });
        return;
      }
      const session = connectHttp2(origin, {
        ...HTTP2_LIMITS,
        createConnection: () => tlsSocket,
      });
      // As the socket's: from creation, never removed.
      session.on('error', reject);
      resolve({ protocol: 'h2', socket: tlsSocket, session });
    });
  });
}
