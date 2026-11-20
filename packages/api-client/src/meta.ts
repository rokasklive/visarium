import type { ApiClient } from './client';
import { api } from './client';
import type { components } from './generated/schema';

/**
 * The first typed call, and the pipeline's tripwire.
 *
 * If the server's DTO changes and the client is not regenerated, this stops
 * compiling — which is the entire point of generating rather than hand-writing.
 */
export type ServerInfo = components['schemas']['ServerInfo'];

export async function fetchServerInfo(client: ApiClient = api): Promise<ServerInfo> {
  const { data, error } = await client.GET('/api/meta');
  if (error || !data) throw new Error('Failed to load server info');
  return data;
}

/** Codename per major version; every pre-1.0 release is Shirakawa. */
export function codenameFor(version: string | undefined) {
  if (!version) return undefined;
  return version.startsWith('0.') ? 'Shirakawa' : version.startsWith('1.') ? 'Tokyo' : undefined;
}
