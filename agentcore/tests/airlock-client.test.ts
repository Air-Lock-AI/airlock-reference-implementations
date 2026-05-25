import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AirlockExportError, fetchAgentConfig } from '../src/lib/airlock-client.ts';
import type { ClaudeSdkAgentConfig } from '../src/lib/types.ts';

const baseArgs = {
  mcpUrl: 'https://mcp.air-lock.ai/org/acme',
  agentName: 'triage',
  serviceToken: 'svct_test',
};

const renderedContent: ClaudeSdkAgentConfig = {
  agentName: 'triage',
  agentDefinition: {
    description: 'd',
    prompt: 'p',
    tools: [],
    model: 'claude-sonnet-4-6',
  },
  mcpServers: {},
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

  it('issues tools/call against the MCP URL and returns artifact content', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mcpToolsCallReply({
        format: 'claude-sdk',
        artifacts: [
          { path: '.claude/agents/triage.json', op: 'write', content: renderedContent },
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
      params: { name: 'export_agent', arguments: { agent: 'triage', adapter: 'claude-sdk' } },
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
      name: 'AirlockExportError',
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
      mcpToolsCallReply({ format: 'claude-sdk', artifacts: [] }),
    );

    await expect(fetchAgentConfig(baseArgs)).rejects.toBeInstanceOf(AirlockExportError);
  });
});
