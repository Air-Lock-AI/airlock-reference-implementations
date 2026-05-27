/**
 * Thin client around Airlock's `export_agent` MCP tool, adapter=`bedrock`.
 *
 * Issues a JSON-RPC `tools/call` against the org's MCP endpoint (the same
 * URL the agent's tool loop hits), extracts the single artifact, and
 * returns its `content` (a `BedrockAgentConfig`). The runtime-fetch
 * entrypoint calls this once on cold start; the build-time export script
 * calls it from CI.
 *
 * One channel, one credential surface: the runtime never needs a separate
 * management/REST scope — the same service token that calls tools also
 * fetches the rendered agent config.
 *
 * No retries here — at the cold-start boundary, a failed fetch should fail
 * the invocation loud and visible in CloudWatch, not be papered over with
 * stale data.
 */

import { callMcpTool, McpCallError } from './mcp-client.ts';
import type { BedrockAgentConfig } from './types.ts';

export interface FetchAgentConfigArgs {
  /** Org MCP URL, e.g. `https://mcp.air-lock.ai/org/acme`. */
  mcpUrl: string;
  agentName: string;
  serviceToken: string;
}

export { McpCallError as AirlockExportError };

interface ExportAgentMcpPayload {
  format?: string;
  artifacts: Array<{ path: string; op: 'write'; content: BedrockAgentConfig }>;
  installInstructions?: string;
}

/**
 * Fetches the `bedrock` rendering of an agent over MCP.
 *
 * Throws `McpCallError` on transport failure, JSON-RPC error, MCP tool
 * error, or schema mismatch. The caller is expected to let the error
 * propagate — the cold-start runtime has no useful fallback if Airlock is
 * unreachable.
 */
export async function fetchAgentConfig(args: FetchAgentConfigArgs): Promise<BedrockAgentConfig> {
  const text = await callMcpTool({
    endpoint: args.mcpUrl,
    headers: { Authorization: `Bearer ${args.serviceToken}` },
    name: 'export_agent',
    arguments: { agent: args.agentName, adapter: 'bedrock' },
  });

  let payload: ExportAgentMcpPayload;
  try {
    payload = JSON.parse(text) as ExportAgentMcpPayload;
  } catch {
    throw new McpCallError(
      `Airlock MCP export_agent returned non-JSON text`,
      undefined,
      text.slice(0, 500),
    );
  }
  const artifact = payload.artifacts?.[0];
  if (!artifact || artifact.op !== 'write' || !artifact.content) {
    throw new McpCallError(
      `Airlock MCP export_agent returned no usable artifact for "${args.agentName}"`,
      undefined,
      JSON.stringify(payload).slice(0, 500),
    );
  }
  return artifact.content;
}
