/**
 * Thin client around Airlock's REST export endpoint.
 *
 * `fetchAgentConfig` hits `GET /v1/orgs/{slug}/agents/{name}/export?adapter=claude-sdk`,
 * extracts the single `claude-sdk` artifact, and returns its `content`
 * (a `ClaudeSdkAgentConfig`). The runtime-fetch entrypoint calls this once
 * on cold start; the build-time-export script calls it from CI.
 *
 * Auth is the same bearer-token shape as every other Airlock REST call
 * (service token issued in the Control Room under Settings → Service Accounts).
 *
 * No retries here — at the runtime-fetch boundary, a failed cold-start fetch
 * should fail the invocation loud and visible in CloudWatch, not be papered
 * over with stale data.
 */

import type { ClaudeSdkAgentConfig, ExportAgentResponse } from './types.ts';

export interface FetchAgentConfigArgs {
  apiBaseUrl: string;
  orgSlug: string;
  agentName: string;
  serviceToken: string;
}

export class AirlockExportError extends Error {
  constructor(
    message: string,
    public readonly status: number | undefined,
    public readonly body: string | undefined,
  ) {
    super(message);
    this.name = 'AirlockExportError';
  }
}

/**
 * Fetches the `claude-sdk` rendering of an agent.
 *
 * Throws `AirlockExportError` on non-2xx, schema mismatch, or empty artifacts.
 * The caller is expected to let the error propagate — the cold-start runtime
 * has no useful fallback if Airlock is unreachable.
 */
export async function fetchAgentConfig(args: FetchAgentConfigArgs): Promise<ClaudeSdkAgentConfig> {
  const url = `${args.apiBaseUrl}/v1/orgs/${encodeURIComponent(args.orgSlug)}/agents/${encodeURIComponent(args.agentName)}/export?adapter=claude-sdk`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${args.serviceToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => undefined);
    throw new AirlockExportError(
      `Airlock export_agent failed: ${response.status} ${response.statusText}`,
      response.status,
      body,
    );
  }

  const json = (await response.json()) as ExportAgentResponse;
  const first = json.artifacts?.[0];
  if (!first || first.op !== 'write' || !first.content) {
    throw new AirlockExportError(
      `Airlock export_agent returned no usable artifact for "${args.agentName}"`,
      response.status,
      JSON.stringify(json).slice(0, 500),
    );
  }
  return first.content;
}
