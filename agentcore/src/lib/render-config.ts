/**
 * Substitute the two env-var placeholders the `claude-sdk` adapter bakes into
 * the rendered config:
 *
 *   - `${AIRLOCK_TOKEN}`               (per-process; from Secrets Manager)
 *   - `${AIRLOCK_AGENT_INVOCATION_ID}` (per-invocation; a fresh UUID)
 *
 * Substitution is intentionally narrow: it only walks the `mcpServers[*].headers`
 * map. Any other appearance of `${...}` is left untouched. This matches the
 * substitution surface the Airlock adapter documents on its side.
 */

import type { ClaudeSdkAgentConfig } from './types.ts';
import {
  AUTH_TOKEN_PLACEHOLDER,
  AGENT_INVOCATION_PLACEHOLDER,
} from './types.ts';

export interface SubstitutionValues {
  serviceToken: string;
  agentInvocationId: string;
}

/**
 * Returns a shallow copy of `config` with `mcpServers[*].headers` placeholders
 * resolved. The original object is not mutated — important because the
 * runtime-fetch pattern caches one `ClaudeSdkAgentConfig` for the process
 * lifetime and renders a per-invocation copy on each request.
 */
export function renderConfig(
  config: ClaudeSdkAgentConfig,
  values: SubstitutionValues,
): ClaudeSdkAgentConfig {
  const mcpServers: ClaudeSdkAgentConfig['mcpServers'] = {};
  for (const [key, server] of Object.entries(config.mcpServers)) {
    const headers: Record<string, string> = {};
    for (const [headerName, headerValue] of Object.entries(server.headers)) {
      headers[headerName] = substitute(headerValue, values);
    }
    mcpServers[key] = { ...server, headers };
  }
  return { ...config, mcpServers };
}

function substitute(value: string, values: SubstitutionValues): string {
  return value
    .replaceAll(AUTH_TOKEN_PLACEHOLDER, values.serviceToken)
    .replaceAll(AGENT_INVOCATION_PLACEHOLDER, values.agentInvocationId);
}
