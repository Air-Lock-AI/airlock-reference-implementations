import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AirlockExportError, fetchAgentConfig } from '../src/lib/airlock-client.ts';
import type { ExportAgentResponse } from '../src/lib/types.ts';

const baseArgs = {
  apiBaseUrl: 'https://api.air-lock.ai',
  orgSlug: 'acme',
  agentName: 'triage',
  serviceToken: 'svct_test',
};

const validResponse: ExportAgentResponse = {
  agentName: 'triage',
  adapter: 'claude-sdk',
  version: 3,
  artifacts: [
    {
      path: '.claude/agents/triage.json',
      op: 'write',
      content: {
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
      },
    },
  ],
};

describe('fetchAgentConfig', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls export endpoint with bearer auth and returns artifact content', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => validResponse,
      text: async () => JSON.stringify(validResponse),
    } as Response);

    const result = await fetchAgentConfig(baseArgs);

    expect(result).toEqual(validResponse.artifacts[0]!.content);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe(
      'https://api.air-lock.ai/v1/orgs/acme/agents/triage/export?adapter=claude-sdk',
    );
    expect((call[1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer svct_test',
    });
  });

  it('url-encodes org slug and agent name', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => validResponse,
      text: async () => '',
    } as Response);

    await fetchAgentConfig({ ...baseArgs, orgSlug: 'acme inc', agentName: 'a/b' });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe(
      'https://api.air-lock.ai/v1/orgs/acme%20inc/agents/a%2Fb/export?adapter=claude-sdk',
    );
  });

  it('throws AirlockExportError on non-2xx', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => '{"error":"no access"}',
      json: async () => ({}),
    } as Response);

    await expect(fetchAgentConfig(baseArgs)).rejects.toMatchObject({
      name: 'AirlockExportError',
      status: 403,
    });
  });

  it('throws AirlockExportError when the artifact list is empty', async () => {
    const empty: ExportAgentResponse = { ...validResponse, artifacts: [] as never };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => empty,
      text: async () => JSON.stringify(empty),
    } as Response);

    await expect(fetchAgentConfig(baseArgs)).rejects.toBeInstanceOf(AirlockExportError);
  });
});
