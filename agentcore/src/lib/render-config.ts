/**
 * Substitute the two env-var placeholders the `bedrock` adapter bakes into
 * `airlockMcp.headers`:
 *
 *   - `${AIRLOCK_TOKEN}`               (per-process; from Secrets Manager)
 *   - `${AIRLOCK_AGENT_INVOCATION_ID}` (per-invocation; a fresh UUID)
 *
 * Substitution is intentionally narrow: it only walks `airlockMcp.headers`.
 * Any other appearance of `${...}` is left untouched. This matches the
 * substitution surface the adapter documents on its side.
 */

import {
  AUTH_TOKEN_PLACEHOLDER,
  AGENT_INVOCATION_PLACEHOLDER,
} from './types.ts';
import type { BedrockAgentConfig } from './types.ts';

export interface SubstitutionValues {
  serviceToken: string;
  agentInvocationId: string;
}

/**
 * Returns a shallow copy of `config` with `airlockMcp.headers` placeholders
 * resolved. The original object is not mutated — important because the
 * runtime-fetch pattern caches one `BedrockAgentConfig` for the process
 * lifetime and renders a per-invocation copy on each request.
 */
export function renderConfig(
  config: BedrockAgentConfig,
  values: SubstitutionValues,
): BedrockAgentConfig {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(config.airlockMcp.headers)) {
    headers[name] = substitute(value, values);
  }
  return {
    ...config,
    airlockMcp: { ...config.airlockMcp, headers },
  };
}

function substitute(value: string, values: SubstitutionValues): string {
  return value
    .replaceAll(AUTH_TOKEN_PLACEHOLDER, values.serviceToken)
    .replaceAll(AGENT_INVOCATION_PLACEHOLDER, values.agentInvocationId);
}
