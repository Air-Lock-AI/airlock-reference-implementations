/**
 * Drive AWS Bedrock Converse from a rendered `BedrockAgentConfig`, bridge
 * every `tool_use` back through Airlock's MCP `execute_tool`, and yield
 * AgentCore-shaped SSE events back to the runtime.
 *
 * Converse does NOT speak MCP. The host is responsible for the bridge —
 * that bridge is what keeps Airlock's policy engine, approval workflow,
 * audit log, and budget enforcement in the loop. Tools called any other
 * way are ungoverned. See `mcp-client.ts` for the MCP plumbing.
 */

import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type ContentBlock,
  type ConverseStreamCommandInput,
  type Message,
  type Tool,
  type ToolConfiguration,
  type ToolResultBlock,
  type ToolUseBlock,
} from '@aws-sdk/client-bedrock-runtime';

import { executeTool, McpCallError } from './mcp-client.ts';
import type { BedrockAgentConfig } from './types.ts';

export interface AgentCoreEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface RunAgentOptions {
  /** AWS region for the Bedrock client. Defaults to `process.env.AWS_REGION`. */
  region?: string;
  /**
   * Override the cross-region inference-profile prefix. If unset, derived
   * from `region` (`us-*` → `us.`, `eu-*` → `eu.`, `ap-*` → `apac.`,
   * everything else → `global.`).
   */
  inferenceProfilePrefix?: string;
}

const DEFAULT_MAX_TOOL_CALLS = 10;
const DEFAULT_MAX_WALL_SECONDS = 120;

/**
 * Run one invocation. Yields:
 *   - `message`   for each assistant text block
 *   - `tool_use`  for each tool call the model issues
 *   - `tool_result` for each MCP response fed back to Converse
 *   - `result`    on `stopReason: end_turn`
 *   - `error`     on Converse error, MCP error, or in-host budget cutoff
 */
export async function* runAgent(
  prompt: string,
  config: BedrockAgentConfig,
  options: RunAgentOptions = {},
): AsyncGenerator<AgentCoreEvent, void, undefined> {
  const region = options.region ?? process.env['AWS_REGION'];
  if (!region) {
    yield { event: 'error', data: { message: 'AWS_REGION is not set; cannot init Bedrock client' } };
    return;
  }
  const modelId = applyInferenceProfilePrefix(
    config.converse.modelId,
    options.inferenceProfilePrefix ?? deriveInferenceProfilePrefix(region),
  );

  const client = new BedrockRuntimeClient({ region });
  const messages: Message[] = [
    { role: 'user', content: [{ text: prompt }] },
  ];
  const toolConfig: ToolConfiguration = config.converse.toolConfig as ToolConfiguration;

  const budget = config.airlock.budget ?? {};
  const maxToolCalls = budget.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const maxWallSeconds = budget.maxWallSeconds ?? DEFAULT_MAX_WALL_SECONDS;
  const deadline = Date.now() + maxWallSeconds * 1000;

  let toolCallCount = 0;
  let lastUsage: Record<string, unknown> | undefined;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (Date.now() > deadline) {
        yield {
          event: 'error',
          data: { message: `In-host budget exceeded: wall time > ${maxWallSeconds}s` },
        };
        return;
      }

      const input: ConverseStreamCommandInput = {
        modelId,
        system: config.converse.system,
        messages,
        toolConfig,
        inferenceConfig: config.converse.inferenceConfig,
      };
      const response = await client.send(new ConverseStreamCommand(input));

      const turn = await consumeStream(response.stream, function* (event) {
        yield event;
      });

      // Re-yield events emitted during the stream — done after consumption
      // so the async generator surface stays simple.
      for (const ev of turn.events) yield ev;
      if (turn.usage) lastUsage = turn.usage;

      // Append the assistant turn we just built so the next Converse call
      // sees the full history.
      messages.push({ role: 'assistant', content: turn.assistantContent });

      if (turn.stopReason !== 'tool_use') {
        yield {
          event: 'result',
          data: {
            stopReason: turn.stopReason,
            text: extractText(turn.assistantContent),
            usage: lastUsage,
          },
        };
        return;
      }

      // tool_use → resolve each via aliases, call MCP, build toolResult message.
      const toolResults: ContentBlock[] = [];
      for (const toolUse of turn.toolUses) {
        toolCallCount += 1;
        if (toolCallCount > maxToolCalls) {
          yield {
            event: 'error',
            data: { message: `In-host budget exceeded: tool calls > ${maxToolCalls}` },
          };
          return;
        }
        const realName = config.airlockMcp.toolAliases[toolUse.name];
        if (!realName) {
          toolResults.push(toolResultError(toolUse.toolUseId, `Unknown tool alias: ${toolUse.name}`));
          continue;
        }
        yield {
          event: 'tool_use',
          data: { toolUseId: toolUse.toolUseId, name: realName, input: toolUse.input },
        };
        try {
          const resultText = await executeTool({
            endpoint: config.airlockMcp.endpoint,
            headers: config.airlockMcp.headers,
            tool: realName,
            arguments: toolUse.input as Record<string, unknown>,
          });
          yield {
            event: 'tool_result',
            data: { toolUseId: toolUse.toolUseId, name: realName, output: resultText },
          };
          toolResults.push({
            toolResult: {
              toolUseId: toolUse.toolUseId,
              content: [{ text: resultText }],
            },
          } satisfies ContentBlock);
        } catch (err) {
          // Surface the MCP error body to the model so it can self-correct
          // on the next turn — without it the model sees only a generic
          // "tool error" and tends to retry the same broken input.
          const detail = err instanceof McpCallError && err.body ? err.body : '';
          const message = err instanceof Error ? err.message : String(err);
          const combined = detail ? `${message}: ${detail}` : message;
          yield { event: 'tool_result', data: { toolUseId: toolUse.toolUseId, name: realName, error: combined } };
          toolResults.push(toolResultError(toolUse.toolUseId, combined));
        }
      }
      messages.push({ role: 'user', content: toolResults });
    }
  } catch (err) {
    yield {
      event: 'error',
      data: { message: err instanceof Error ? err.message : String(err) },
    };
  }
}

interface ToolUseAccumulator {
  toolUseId: string;
  name: string;
  /** Concatenated JSON text from `delta.toolUse.input` chunks. */
  inputText: string;
  input?: unknown;
}

interface ConsumedTurn {
  stopReason: string | undefined;
  assistantContent: ContentBlock[];
  toolUses: Array<{ toolUseId: string; name: string; input: unknown }>;
  usage: Record<string, unknown> | undefined;
  events: AgentCoreEvent[];
}

async function consumeStream(
  stream: AsyncIterable<unknown> | undefined,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _yieldEvent: (event: AgentCoreEvent) => Generator<AgentCoreEvent>,
): Promise<ConsumedTurn> {
  const events: AgentCoreEvent[] = [];
  const assistantContent: ContentBlock[] = [];
  const toolUses: ConsumedTurn['toolUses'] = [];
  let stopReason: string | undefined;
  let usage: Record<string, unknown> | undefined;

  /**
   * Bedrock streams content as a sequence of `contentBlockStart`,
   * one-or-more `contentBlockDelta`, `contentBlockStop` triples, indexed
   * by `contentBlockIndex`. Track per-index accumulators so we can stitch
   * text deltas and toolUse input-JSON chunks back together.
   */
  const textBlocks = new Map<number, string>();
  const toolBlocks = new Map<number, ToolUseAccumulator>();

  if (!stream) {
    return { stopReason: 'end_turn', assistantContent, toolUses, usage, events };
  }

  for await (const event of stream) {
    const e = event as Record<string, any>;
    if (e.contentBlockStart) {
      const idx = e.contentBlockStart.contentBlockIndex as number;
      const start = e.contentBlockStart.start;
      if (start?.toolUse) {
        toolBlocks.set(idx, {
          toolUseId: start.toolUse.toolUseId,
          name: start.toolUse.name,
          inputText: '',
        });
      }
    } else if (e.contentBlockDelta) {
      const idx = e.contentBlockDelta.contentBlockIndex as number;
      const delta = e.contentBlockDelta.delta;
      if (typeof delta?.text === 'string') {
        textBlocks.set(idx, (textBlocks.get(idx) ?? '') + delta.text);
        events.push({ event: 'message', data: { text: delta.text } });
      } else if (delta?.toolUse?.input) {
        const acc = toolBlocks.get(idx);
        if (acc) acc.inputText += delta.toolUse.input;
      }
    } else if (e.contentBlockStop) {
      const idx = e.contentBlockStop.contentBlockIndex as number;
      const toolAcc = toolBlocks.get(idx);
      if (toolAcc) {
        try {
          toolAcc.input = toolAcc.inputText.length > 0 ? JSON.parse(toolAcc.inputText) : {};
        } catch {
          toolAcc.input = {};
        }
      }
    } else if (e.messageStop) {
      stopReason = e.messageStop.stopReason as string;
    } else if (e.metadata) {
      usage = e.metadata.usage;
    }
  }

  // Reassemble assistantContent in index order so the next Converse call
  // sees the message as Bedrock produced it.
  const maxIdx = Math.max(
    -1,
    ...Array.from(textBlocks.keys()),
    ...Array.from(toolBlocks.keys()),
  );
  for (let i = 0; i <= maxIdx; i += 1) {
    const text = textBlocks.get(i);
    if (text !== undefined) {
      assistantContent.push({ text } satisfies ContentBlock);
      continue;
    }
    const tool = toolBlocks.get(i);
    if (tool) {
      const toolUse: ToolUseBlock = {
        toolUseId: tool.toolUseId,
        name: tool.name,
        input: tool.input as ToolUseBlock['input'],
      };
      assistantContent.push({ toolUse } satisfies ContentBlock);
      toolUses.push({ toolUseId: tool.toolUseId, name: tool.name, input: tool.input });
    }
  }

  return { stopReason, assistantContent, toolUses, usage, events };
}

function extractText(content: ContentBlock[]): string {
  return content
    .map((b) => ('text' in b ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

function toolResultError(toolUseId: string, message: string): ContentBlock {
  const toolResult: ToolResultBlock = {
    toolUseId,
    content: [{ text: `Error: ${message}` }],
    status: 'error',
  };
  return { toolResult } satisfies ContentBlock;
}

/**
 * Map AWS region → cross-region inference-profile prefix per the
 * `bedrock` adapter's install instructions. Conservative defaults: `us-*`
 * and `eu-*` use their regional profiles, `ap-*` uses `apac.`, anything
 * else falls back to the `global.` profile that AWS publishes for newer
 * Claude families.
 */
export function deriveInferenceProfilePrefix(region: string): string {
  if (region.startsWith('us-')) return 'us.';
  if (region.startsWith('eu-')) return 'eu.';
  if (region.startsWith('ap-')) return 'apac.';
  return 'global.';
}

/**
 * Prepend the inference-profile prefix to a foundation-model ID, unless
 * the caller has already done so (e.g. by passing `us.anthropic.…` from a
 * config override).
 */
export function applyInferenceProfilePrefix(modelId: string, prefix: string): string {
  if (/^(us|eu|apac|global)\./.test(modelId)) return modelId;
  return `${prefix}${modelId}`;
}

// Re-export so dependent files can hint against a Tool/ToolConfiguration without
// pulling the AWS SDK directly.
export type { Tool, ToolConfiguration };
