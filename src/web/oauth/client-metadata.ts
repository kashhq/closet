import type { Logger } from '../../logger';
import {
  OutboundFetchError,
  type OutboundFetcher,
} from '../security/outbound-fetch';
import { type ClientMetadata, readClientMetadata } from './authorize-request';

/**
 * An OAuth client's Client ID Metadata Document (#1290; plan 4.3), read
 * on every `GET /oauth/authorize` and never cached (a connect is rare):
 * fetched as `untrustedJson` (outbound-fetch.ts: https, no redirect, 8 KB,
 * 5 s, public addresses), then held to readClientMetadata. Undefined for
 * any failure, which the page says one way ("could not be read"); the log
 * line names the host and why, never the path or the client's name.
 */
export async function fetchClientMetadata(
  fetcher: OutboundFetcher,
  clientId: URL,
  logger: Logger,
): Promise<ClientMetadata | undefined> {
  const host = clientId.hostname;
  let body: Buffer;
  try {
    ({ body } = await fetcher.fetch(clientId.href, {
      accept: ['json'],
      untrustedJson: true,
    }));
  } catch (error) {
    if (!(error instanceof OutboundFetchError)) throw error;
    logger.warn(
      `Client metadata from ${host} refused: the fetch (${error.reason})`,
    );
    return undefined;
  }
  let document: unknown;
  try {
    document = JSON.parse(body.toString('utf8'));
  } catch {
    logger.warn(`Client metadata from ${host} refused: not JSON`);
    return undefined;
  }
  const metadata = readClientMetadata(document, clientId);
  if ('refused' in metadata) {
    logger.warn(`Client metadata from ${host} refused: ${metadata.refused}`);
    return undefined;
  }
  return metadata;
}
