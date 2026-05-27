/**
 * Shape of the `bedrock` adapter's `content` artifact.
 *
 * `export_agent` returns this as a JSON object — not a string — so a
 * runtime-fetch consumer (this reference repo) parses it directly without
 * doing any string-eval of the adapter's output. If the adapter contract
 * evolves on Airlock's side, only this file changes.
 *
 * The adapter splits the world into two halves:
 *   - `converse` — exactly what the AWS Bedrock Converse API accepts as
 *     input (`modelId`, `system`, `toolConfig`, `inferenceConfig`).
 *   - `airlockMcp` — what the host needs to bridge tool calls back to
 *     Airlock (endpoint, header placeholders, the `name → namespaced/tool`
 *     alias map). The Converse API doesn't speak MCP, so the host is
 *     responsible for that translation; the alias map keeps the
 *     translation table out of the host code.
 */

export interface BedrockConverseToolSpec {
  /** Sanitized tool name (Bedrock forbids `/`). Resolve via `toolAliases`. */
  name: string;
  description?: string;
  /**
   * Set by the host at cold start by calling `describe_tools` for the
   * aliased real tool name. Bedrock requires every `toolSpec` to carry
   * an `inputSchema` before the first Converse call.
   */
  inputSchema?: { json: unknown };
}

export interface BedrockConverseConfig {
  /** Foundation-model ID — prefix with `us.` / `eu.` / `apac.` / `global.` at call time. */
  modelId: string;
  system: Array<{ text: string }>;
  toolConfig: { tools: Array<{ toolSpec: BedrockConverseToolSpec }> };
  inferenceConfig: { maxTokens: number };
}

export interface BedrockAirlockMcp {
  /** Org MCP URL the host POSTs `execute_tool` calls to. */
  endpoint: string;
  transport: 'streamable-http';
  /**
   * Two placeholders the host substitutes per-process and per-invocation:
   *   - `Authorization: Bearer ${AIRLOCK_TOKEN}`
   *   - `X-Airlock-Agent-Invocation-Id: ${AIRLOCK_AGENT_INVOCATION_ID}`
   */
  headers: Record<string, string>;
  /** Sanitized Converse name → real Airlock `project/tool` name. */
  toolAliases: Record<string, string>;
}

export interface BedrockAirlockMeta {
  /** Defensive in-host caps. Airlock enforces these server-side too. */
  budget?: {
    maxTokens?: number;
    maxToolCalls?: number;
    maxWallSeconds?: number;
  };
  [key: string]: unknown;
}

export interface BedrockAgentConfig {
  converse: BedrockConverseConfig;
  airlockMcp: BedrockAirlockMcp;
  /** Skill ids loaded at runtime via `activate_skill`; never inlined. */
  skills: string[];
  /** Lossless round-trip stash; opaque to most consumers except `budget`. */
  airlock: BedrockAirlockMeta;
}

/** Header names — kept in sync with what the Airlock `bedrock` adapter emits. */
export const AGENT_INVOCATION_HEADER = 'X-Airlock-Agent-Invocation-Id';
export const AUTH_TOKEN_PLACEHOLDER = '${AIRLOCK_TOKEN}';
export const AGENT_INVOCATION_PLACEHOLDER = '${AIRLOCK_AGENT_INVOCATION_ID}';
