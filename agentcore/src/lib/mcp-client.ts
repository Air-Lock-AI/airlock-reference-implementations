/**
 * Thin client for Airlock's MCP endpoint.
 *
 * Three call sites in this reference impl hit the same endpoint with the
 * same JSON-RPC envelope:
 *
 *   - `export_agent`   — cold-start; fetches the agent's rendered config.
 *   - `describe_tools` — cold-start; hydrates each Converse tool's
 *                        `inputSchema` from its real namespaced tool name.
 *   - `execute_tool`   — in-loop; dispatches every Converse `tool_use` back
 *                        through Airlock so policy/approval/audit/budget
 *                        run in their canonical place.
 *
 * All three are `tools/call` invocations on the same MCP server. This file
 * factors the JSON-RPC plumbing once; `airlock-client.ts` calls it for the
 * cold-start fetch, and `run-agent.ts` calls it inside the Converse loop.
 *
 * No retries by design — the agent loop expects every tool call to either
 * succeed or fail loud. Quiet retries here would mask policy denials and
 * budget cutoffs that Airlock surfaces as errors on purpose.
 */

let nextId = 1;

export interface McpCallToolArgs {
  endpoint: string;
  /** Pre-rendered headers (placeholders already substituted). */
  headers: Record<string, string>;
  /** The MCP meta-tool name: `export_agent`, `describe_tools`, `execute_tool`. */
  name: string;
  arguments: Record<string, unknown>;
}

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpToolsCallResult {
  isError?: boolean;
  content: McpTextContent[];
}

export class McpCallError extends Error {
  readonly status: number | undefined;
  readonly body: string | undefined;

  constructor(message: string, status: number | undefined, body: string | undefined) {
    super(message);
    this.name = 'McpCallError';
    this.status = status;
    this.body = body;
  }
}

interface McpJsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: McpToolsCallResult;
  error?: { code: number; message: string };
}

/**
 * Issue a single JSON-RPC `tools/call` against the MCP endpoint and return
 * the unparsed text payload of the first content block. Callers parse the
 * JSON themselves because the Airlock meta-tools return shapes that differ
 * tool-by-tool.
 */
export async function callMcpTool(args: McpCallToolArgs): Promise<string> {
  const id = nextId++;
  const response = await fetch(args.endpoint, {
    method: 'POST',
    headers: {
      ...args.headers,
      'Content-Type': 'application/json',
      // MCP servers may stream tool output as SSE; we accept either form.
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: args.name, arguments: args.arguments },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => undefined);
    throw new McpCallError(
      `Airlock MCP ${args.name} transport failed: ${response.status} ${response.statusText}`,
      response.status,
      body,
    );
  }

  const envelope = (await response.json()) as McpJsonRpcResponse;
  if (envelope.error) {
    throw new McpCallError(
      `Airlock MCP ${args.name} JSON-RPC error: ${envelope.error.message}`,
      undefined,
      JSON.stringify(envelope.error),
    );
  }
  const result = envelope.result;
  if (!result || result.isError) {
    throw new McpCallError(
      `Airlock MCP ${args.name} returned tool error`,
      undefined,
      JSON.stringify(result).slice(0, 500),
    );
  }
  const text = result.content?.[0]?.text;
  if (!text) {
    throw new McpCallError(
      `Airlock MCP ${args.name} returned no text content`,
      undefined,
      JSON.stringify(result).slice(0, 500),
    );
  }
  return text;
}

export interface DescribeToolsArgs {
  endpoint: string;
  headers: Record<string, string>;
  /** Real namespaced tool names, e.g. `posthog/query-run`. */
  tools: string[];
}

export interface DescribedTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/**
 * Cold-start hydration. Returns the JSON Schema for every named tool so the
 * caller can attach it to the matching `converse.toolConfig.tools[].toolSpec`
 * before issuing the first `ConverseStreamCommand`.
 */
export async function describeTools(args: DescribeToolsArgs): Promise<DescribedTool[]> {
  const text = await callMcpTool({
    endpoint: args.endpoint,
    headers: args.headers,
    name: 'describe_tools',
    arguments: { tools: args.tools },
  });
  const payload = JSON.parse(text) as { tools: DescribedTool[] };
  if (!Array.isArray(payload.tools)) {
    throw new McpCallError(
      `Airlock MCP describe_tools returned no tools array`,
      undefined,
      text.slice(0, 500),
    );
  }
  return payload.tools;
}

export interface ExecuteToolArgs {
  endpoint: string;
  headers: Record<string, string>;
  /** Real namespaced tool name (post-alias resolution). */
  tool: string;
  /** Tool arguments — the `toolUseId.input` block from Converse. */
  arguments: Record<string, unknown>;
}

/**
 * In-loop dispatch. Returns the raw text payload — Bedrock Converse accepts
 * any JSON-serializable shape inside a `toolResult` content block, so we
 * pass through verbatim.
 */
export async function executeTool(args: ExecuteToolArgs): Promise<string> {
  return callMcpTool({
    endpoint: args.endpoint,
    headers: args.headers,
    name: 'execute_tool',
    arguments: { tool: args.tool, arguments: args.arguments },
  });
}
