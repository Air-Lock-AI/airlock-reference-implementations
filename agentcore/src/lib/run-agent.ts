/**
 * Drive the Claude Agent SDK from a rendered `ClaudeSdkAgentConfig` and yield
 * AgentCore-shaped SSE events back to the runtime.
 *
 * The Airlock MCP endpoint named under `mcpServers` is the **only** tool surface
 * — we do not register any other server here, and we do not redefine tools
 * locally. Policy, approval, audit, and budgets all enforce server-side; this
 * file is just a loop driver.
 */

import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeSdkAgentConfig } from './types.ts';

export interface AgentCoreEvent {
  event: string;
  data: Record<string, unknown>;
}

/**
 * Run one invocation. Yields:
 *   - `{ event: 'message', data: { text } }` for each assistant text delta
 *   - `{ event: 'tool_use', data: { name, input } }` for each tool call
 *   - `{ event: 'result',  data: { text, cost_usd, usage } }` on completion
 *   - `{ event: 'error',   data: { message } }` on SDK error
 *
 * The AgentCore SDK frames these as `data: <json>\n\n` SSE lines on the wire.
 */
export async function* runAgent(
  prompt: string,
  config: ClaudeSdkAgentConfig,
): AsyncGenerator<AgentCoreEvent, void, undefined> {
  const options: Options = {
    model: config.agentDefinition.model,
    systemPrompt: config.agentDefinition.prompt,
    mcpServers: config.mcpServers,
    allowedTools: config.agentDefinition.tools,
    // Airlock is the policy boundary — every tool call goes through the MCP URL
    // where policy/approval/audit run. The SDK's local permission gate would
    // otherwise block all tool calls in this non-interactive server context.
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    // Disable all built-in tools (Read, Bash, Edit, ToolSearch, Task, ...).
    // Tool execution belongs at the Airlock MCP boundary, not in the host.
    tools: [],
    // SDK isolation: don't load `~/.claude/settings.json`, project settings, or
    // local settings. The deployed AgentCore Runtime has a clean container
    // with no claude.ai login, so MCP servers can only come from `mcpServers`
    // above; this option closes the equivalent leak on local smoke tests.
    // (One residual local-only path remains: claude.ai remote-managed config
    // — set `env: { CLAUDE_CONFIG_DIR: '/tmp/empty' }` if you need to suppress
    // that too. Doesn't apply to the deployed runtime.)
    settingSources: [],
  };

  try {
    for await (const message of query({ prompt, options })) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') {
            yield { event: 'message', data: { text: block.text } };
          } else if (block.type === 'tool_use') {
            yield {
              event: 'tool_use',
              data: { name: block.name, input: block.input },
            };
          }
        }
      } else if (message.type === 'result') {
        if (message.subtype === 'success') {
          yield {
            event: 'result',
            data: {
              text: message.result,
              cost_usd: message.total_cost_usd,
              usage: message.usage,
            },
          };
        } else {
          yield {
            event: 'error',
            data: {
              subtype: message.subtype,
              errors: message.errors,
              cost_usd: message.total_cost_usd,
            },
          };
        }
      }
    }
  } catch (err) {
    yield {
      event: 'error',
      data: { message: err instanceof Error ? err.message : String(err) },
    };
  }
}
