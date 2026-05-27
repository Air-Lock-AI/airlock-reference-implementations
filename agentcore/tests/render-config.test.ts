import { describe, expect, it } from 'vitest';

import { renderConfig } from '../src/lib/render-config.ts';
import type { BedrockAgentConfig } from '../src/lib/types.ts';

function makeFixture(): BedrockAgentConfig {
  return {
    converse: {
      modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0',
      system: [{ text: 'You are a triage agent.' }],
      toolConfig: {
        tools: [{ toolSpec: { name: 'github_create_issue' } }],
      },
      inferenceConfig: { maxTokens: 4000 },
    },
    airlockMcp: {
      endpoint: 'https://mcp.air-lock.ai/org/acme',
      transport: 'streamable-http',
      headers: {
        Authorization: 'Bearer ${AIRLOCK_TOKEN}',
        'X-Airlock-Agent-Invocation-Id': '${AIRLOCK_AGENT_INVOCATION_ID}',
      },
      toolAliases: { github_create_issue: 'github/create_issue' },
    },
    skills: ['skl_01HZ'],
    airlock: { schemaVersion: '1.0' },
  };
}

describe('renderConfig', () => {
  it('substitutes both placeholders in airlockMcp.headers', () => {
    const rendered = renderConfig(makeFixture(), {
      serviceToken: 'svct_secret',
      agentInvocationId: 'inv-uuid-123',
    });

    expect(rendered.airlockMcp.headers).toEqual({
      Authorization: 'Bearer svct_secret',
      'X-Airlock-Agent-Invocation-Id': 'inv-uuid-123',
    });
  });

  it('does not mutate the original config', () => {
    const fixture = makeFixture();
    renderConfig(fixture, { serviceToken: 't', agentInvocationId: 'i' });

    expect(fixture.airlockMcp.headers['Authorization']).toBe('Bearer ${AIRLOCK_TOKEN}');
    expect(fixture.airlockMcp.headers['X-Airlock-Agent-Invocation-Id']).toBe(
      '${AIRLOCK_AGENT_INVOCATION_ID}',
    );
  });

  it('leaves the rest of the config untouched', () => {
    const fixture = makeFixture();
    const rendered = renderConfig(fixture, {
      serviceToken: 't',
      agentInvocationId: 'i',
    });

    expect(rendered.converse).toEqual(fixture.converse);
    expect(rendered.skills).toEqual(fixture.skills);
    expect(rendered.airlockMcp.endpoint).toBe(fixture.airlockMcp.endpoint);
    expect(rendered.airlockMcp.toolAliases).toEqual(fixture.airlockMcp.toolAliases);
  });

  it('leaves unrelated ${...} expressions untouched', () => {
    const fixture = makeFixture();
    fixture.airlockMcp.headers['X-Custom'] = '${SOMETHING_ELSE}';

    const rendered = renderConfig(fixture, { serviceToken: 't', agentInvocationId: 'i' });
    expect(rendered.airlockMcp.headers['X-Custom']).toBe('${SOMETHING_ELSE}');
    expect(rendered.airlockMcp.headers['Authorization']).toBe('Bearer t');
  });
});
