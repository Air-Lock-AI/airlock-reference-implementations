/**
 * Shape of the `claude-sdk` adapter's `content` artifact (RFC-011 §5.5).
 *
 * `export_agent` returns this as a JSON object — not a string — so a
 * runtime-fetch consumer (this reference repo) parses it directly without
 * doing any string-eval of the adapter's output. The shape mirrors
 * `packages/agent-adapters/claude-sdk/index.ts` in the airlock repo; if the
 * adapter evolves, only this file changes.
 */

export interface ClaudeSdkAgentDefinition {
  description: string;
  /** systemPrompt rendered verbatim (+ optional skills hint appended by the adapter). */
  prompt: string;
  /** Airlock-namespaced tool allowlist (`project-slug/tool-name` plus meta-tools). */
  tools: string[];
  /** Resolved Anthropic model id. */
  model: string;
}

export interface ClaudeSdkMcpServer {
  type: 'http';
  url: string;
  /**
   * Headers carry two env-var placeholders that the host substitutes per-process
   * and per-invocation:
   *   - `Authorization: Bearer ${AIRLOCK_TOKEN}`
   *   - `X-Airlock-Agent-Invocation-Id: ${AIRLOCK_AGENT_INVOCATION_ID}`
   */
  headers: Record<string, string>;
}

export interface ClaudeSdkAgentConfig {
  /** Key the SDK registers `agentDefinition` under in `Options.agents`. */
  agentName: string;
  agentDefinition: ClaudeSdkAgentDefinition;
  /** `Options.mcpServers` — wires Airlock MCP into the SDK tool loop. */
  mcpServers: Record<string, ClaudeSdkMcpServer>;
  /** Skill ids loaded at runtime via `activate_skill`; never inlined. */
  skills: string[];
  /** Lossless round-trip stash; opaque to consumers. */
  airlock: Record<string, unknown>;
}

/**
 * Shape of `GET /v1/orgs/{slug}/agents/{name}/export?adapter=claude-sdk`.
 *
 * The REST endpoint mirrors `export_agent`'s MCP tool result. Both return an
 * artifact list per RFC §5.5; for `claude-sdk` the list is always length-1.
 */
export interface ExportAgentResponse {
  agentName: string;
  adapter: 'claude-sdk';
  version: number;
  artifacts: [
    {
      path: string;
      op: 'write';
      content: ClaudeSdkAgentConfig;
    },
  ];
}

/** Header names — kept in sync with `packages/agent-adapters/mcp.ts`. */
export const AGENT_INVOCATION_HEADER = 'X-Airlock-Agent-Invocation-Id';
export const AUTH_TOKEN_PLACEHOLDER = '${AIRLOCK_TOKEN}';
export const AGENT_INVOCATION_PLACEHOLDER = '${AIRLOCK_AGENT_INVOCATION_ID}';
