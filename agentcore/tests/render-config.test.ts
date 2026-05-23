import { describe, expect, it } from 'vitest';

import { renderConfig } from '../src/lib/render-config.ts';
import type { ClaudeSdkAgentConfig } from '../src/lib/types.ts';

const fixture: ClaudeSdkAgentConfig = {
  agentName: 'triage',
  agentDefinition: {
    description: 'Triage incoming GitHub issues',
    prompt: 'You are a triage agent.',
    tools: ['github/create_issue'],
    model: 'claude-sonnet-4-6',
  },
  mcpServers: {
    'airlock-acme': {
      type: 'http',
      url: 'https://mcp.air-lock.ai/org/acme',
      headers: {
        Authorization: 'Bearer ${AIRLOCK_TOKEN}',
        'X-Airlock-Agent-Invocation-Id': '${AIRLOCK_AGENT_INVOCATION_ID}',
      },
    },
  },
  skills: ['skl_01HZ'],
  airlock: { schemaVersion: '1.0' },
};

describe('renderConfig', () => {
  it('substitutes both placeholders in mcpServers headers', () => {
    const rendered = renderConfig(fixture, {
      serviceToken: 'svct_secret',
      agentInvocationId: 'inv-uuid-123',
    });

    expect(rendered.mcpServers['airlock-acme']?.headers).toEqual({
      Authorization: 'Bearer svct_secret',
      'X-Airlock-Agent-Invocation-Id': 'inv-uuid-123',
    });
  });

  it('does not mutate the original config', () => {
    renderConfig(fixture, { serviceToken: 't', agentInvocationId: 'i' });

    expect(fixture.mcpServers['airlock-acme']?.headers['Authorization']).toBe(
      'Bearer ${AIRLOCK_TOKEN}',
    );
    expect(
      fixture.mcpServers['airlock-acme']?.headers['X-Airlock-Agent-Invocation-Id'],
    ).toBe('${AIRLOCK_AGENT_INVOCATION_ID}');
  });

  it('leaves the rest of the config untouched', () => {
    const rendered = renderConfig(fixture, {
      serviceToken: 't',
      agentInvocationId: 'i',
    });

    expect(rendered.agentDefinition).toEqual(fixture.agentDefinition);
    expect(rendered.skills).toEqual(fixture.skills);
    expect(rendered.agentName).toBe(fixture.agentName);
  });

  it('handles multiple mcp servers', () => {
    const multi: ClaudeSdkAgentConfig = {
      ...fixture,
      mcpServers: {
        'airlock-acme': fixture.mcpServers['airlock-acme']!,
        'airlock-other': {
          type: 'http',
          url: 'https://mcp.air-lock.ai/org/other',
          headers: { Authorization: 'Bearer ${AIRLOCK_TOKEN}' },
        },
      },
    };

    const rendered = renderConfig(multi, {
      serviceToken: 'tok',
      agentInvocationId: 'inv',
    });

    expect(rendered.mcpServers['airlock-other']?.headers['Authorization']).toBe('Bearer tok');
  });

  it('leaves unrelated ${...} expressions untouched', () => {
    const odd: ClaudeSdkAgentConfig = {
      ...fixture,
      mcpServers: {
        'airlock-acme': {
          type: 'http',
          url: 'https://mcp.air-lock.ai/org/acme',
          headers: {
            'X-Custom': '${SOMETHING_ELSE}',
            Authorization: 'Bearer ${AIRLOCK_TOKEN}',
          },
        },
      },
    };

    const rendered = renderConfig(odd, { serviceToken: 't', agentInvocationId: 'i' });
    expect(rendered.mcpServers['airlock-acme']?.headers['X-Custom']).toBe('${SOMETHING_ELSE}');
    expect(rendered.mcpServers['airlock-acme']?.headers['Authorization']).toBe('Bearer t');
  });
});
