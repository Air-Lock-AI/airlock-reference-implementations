/**
 * Thin client around Airlock's `export_agent` MCP tool.
 *
 * `fetchAgentConfig` issues a JSON-RPC `tools/call` against the org's MCP
 * endpoint (the same URL the agent's tool loop hits), extracts the single
 * `claude-sdk` artifact, and returns its `content` (a `ClaudeSdkAgentConfig`).
 * The runtime-fetch entrypoint calls this once on cold start; the build-time
 * export script calls it from CI.
 *
 * One channel, one credential surface: the runtime never needs a separate
 * management/REST scope — the same service token that calls tools also fetches
 * the rendered agent config.
 *
 * No retries here — at the cold-start boundary, a failed fetch should fail the
 * invocation loud and visible in CloudWatch, not be papered over with stale
 * data.
 */

import type { ClaudeSdkAgentConfig } from './types.ts';

export interface FetchAgentConfigArgs {
  /** Org MCP URL, e.g. `https://mcp.air-lock.ai/org/acme`. */
  mcpUrl: string;
  agentName: string;
  serviceToken: string;
}

export class AirlockExportError extends Error {
  readonly status: number | undefined;
  readonly body: string | undefined;

  constructor(message: string, status: number | undefined, body: string | undefined) {
    super(message);
    this.name = 'AirlockExportError';
    this.status = status;
    this.body = body;
  }
}

interface McpTextContent {
  type: 'text';
  text: string;
}

interface McpToolsCallResult {
  isError?: boolean;
  content: McpTextContent[];
}

interface McpJsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: McpToolsCallResult;
  error?: { code: number; message: string };
}

interface ExportAgentMcpPayload {
  format?: string;
  artifacts: Array<{ path: string; op: 'write'; content: ClaudeSdkAgentConfig }>;
}

/**
 * Fetches the `claude-sdk` rendering of an agent over MCP.
 *
 * Throws `AirlockExportError` on transport failure, JSON-RPC error, MCP tool
 * error, or schema mismatch. The caller is expected to let the error
 * propagate — the cold-start runtime has no useful fallback if Airlock is
 * unreachable.
 */
export async function fetchAgentConfig(args: FetchAgentConfigArgs): Promise<ClaudeSdkAgentConfig> {
  const response = await fetch(args.mcpUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.serviceToken}`,
      'Content-Type': 'application/json',
      // MCP servers may stream tool output as SSE; we accept either.
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'export_agent',
        arguments: { agent: args.agentName, adapter: 'claude-sdk' },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => undefined);
    throw new AirlockExportError(
      `Airlock MCP export_agent transport failed: ${response.status} ${response.statusText}`,
      response.status,
      body,
    );
  }

  const envelope = (await response.json()) as McpJsonRpcResponse;
  if (envelope.error) {
    throw new AirlockExportError(
      `Airlock MCP export_agent JSON-RPC error: ${envelope.error.message}`,
      undefined,
      JSON.stringify(envelope.error),
    );
  }
  const result = envelope.result;
  if (!result || result.isError) {
    throw new AirlockExportError(
      `Airlock MCP export_agent returned tool error`,
      undefined,
      JSON.stringify(result).slice(0, 500),
    );
  }
  const text = result.content?.[0]?.text;
  if (!text) {
    throw new AirlockExportError(
      `Airlock MCP export_agent returned no text content`,
      undefined,
      JSON.stringify(result).slice(0, 500),
    );
  }
  let payload: ExportAgentMcpPayload;
  try {
    payload = JSON.parse(text) as ExportAgentMcpPayload;
  } catch {
    throw new AirlockExportError(
      `Airlock MCP export_agent returned non-JSON text`,
      undefined,
      text.slice(0, 500),
    );
  }
  const artifact = payload.artifacts?.[0];
  if (!artifact || artifact.op !== 'write' || !artifact.content) {
    throw new AirlockExportError(
      `Airlock MCP export_agent returned no usable artifact for "${args.agentName}"`,
      undefined,
      JSON.stringify(payload).slice(0, 500),
    );
  }
  return artifact.content;
}
