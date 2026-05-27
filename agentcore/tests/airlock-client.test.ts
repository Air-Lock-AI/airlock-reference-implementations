import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AirlockExportError, fetchAgentConfig } from '../src/lib/airlock-client.ts';
import type { BedrockAgentConfig } from '../src/lib/types.ts';

const baseArgs = {
  mcpUrl: 'https://mcp.air-lock.ai/org/acme',
  agentName: 'triage',
  serviceToken: 'svct_test',
};

const renderedContent: BedrockAgentConfig = {
  converse: {
    modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0',
    system: [{ text: 'system' }],
    toolConfig: { tools: [] },
    inferenceConfig: { maxTokens: 4000 },
  },
  airlockMcp: {
    endpoint: 'https://mcp.air-lock.ai/org/acme',
    transport: 'streamable-http',
    headers: { Authorization: 'Bearer ${AIRLOCK_TOKEN}' },
    toolAliases: {},
  },
  skills: [],
  airlock: {},
};

function mcpToolsCallReply(payload: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      jsonrpc: '2.0',
      id: 1,
      result: {
        isError: false,
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      },
    }),
    text: async () => '',
  } as Response;
}

describe('fetchAgentConfig (MCP)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('issues tools/call against the MCP URL with adapter=bedrock', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mcpToolsCallReply({
        format: 'bedrock',
        artifacts: [
          { path: '.bedrock/agents/triage.json', op: 'write', content: renderedContent },
        ],
      }),
    );

    const result = await fetchAgentConfig(baseArgs);

    expect(result).toEqual(renderedContent);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe('https://mcp.air-lock.ai/org/acme');
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer svct_test',
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'export_agent', arguments: { agent: 'triage', adapter: 'bedrock' } },
    });
  });

  it('throws AirlockExportError on transport non-2xx', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => '{"error":"bad token"}',
      json: async () => ({}),
    } as Response);

    await expect(fetchAgentConfig(baseArgs)).rejects.toMatchObject({
      name: 'McpCallError',
      status: 401,
    });
  });

  it('throws AirlockExportError on JSON-RPC error', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: 'Method not found' },
      }),
      text: async () => '',
    } as Response);

    await expect(fetchAgentConfig(baseArgs)).rejects.toBeInstanceOf(AirlockExportError);
  });

  it('throws AirlockExportError when the tool returns isError', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: {
          isError: true,
          content: [{ type: 'text', text: '{"error":"Agent not found"}' }],
        },
      }),
      text: async () => '',
    } as Response);

    await expect(fetchAgentConfig(baseArgs)).rejects.toBeInstanceOf(AirlockExportError);
  });

  it('throws AirlockExportError when artifacts is empty', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mcpToolsCallReply({ format: 'bedrock', artifacts: [] }),
    );

    await expect(fetchAgentConfig(baseArgs)).rejects.toBeInstanceOf(AirlockExportError);
  });
});
