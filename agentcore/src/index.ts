/**
 * AgentCore Runtime entrypoint — runtime-fetch pattern (default).
 *
 * On cold start we:
 *   1. Read `AIRLOCK_SERVICE_TOKEN` from Secrets Manager (cached per process).
 *   2. Call Airlock's `export_agent` MCP tool for the configured agent
 *      (cached per process).
 *
 * On every invocation we:
 *   1. Generate a fresh `agentInvocationId` UUID.
 *   2. Substitute `${AIRLOCK_TOKEN}` and `${AIRLOCK_AGENT_INVOCATION_ID}` into
 *      the cached config.
 *   3. Drive `query()` from `@anthropic-ai/claude-agent-sdk`; yield SSE events.
 *
 * Cold-start fetch and tool calls share one channel and one credential — the
 * service token authorizes both the `export_agent` MCP call here and the
 * tool calls the loop issues afterwards through the same MCP URL.
 *
 * Trade-off vs. `build-time-export.ts`: cold start depends on Airlock being
 * reachable, but agent spec changes propagate to the deployed runtime within
 * one cold-start cycle — no redeploy required. See README → "Two patterns".
 */

import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { fetchAgentConfig } from './lib/airlock-client.ts';
import { renderConfig } from './lib/render-config.ts';
import { runAgent } from './lib/run-agent.ts';
import { getServiceToken } from './lib/service-token.ts';
import type { ClaudeSdkAgentConfig } from './lib/types.ts';

const mcpUrl = requireEnv('AIRLOCK_MCP_URL');
const agentName = requireEnv('AIRLOCK_AGENT_NAME');

let cachedConfig: Promise<ClaudeSdkAgentConfig> | undefined;

function getAgentConfig(): Promise<ClaudeSdkAgentConfig> {
  cachedConfig ??= (async () => {
    const serviceToken = await getServiceToken();
    return fetchAgentConfig({ mcpUrl, agentName, serviceToken });
  })();
  return cachedConfig;
}

const requestSchema = z.object({
  prompt: z.string().min(1, 'prompt is required'),
});

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema,
    process: async function* (request) {
      const [config, serviceToken] = await Promise.all([getAgentConfig(), getServiceToken()]);
      const agentInvocationId = randomUUID();
      const rendered = renderConfig(config, { serviceToken, agentInvocationId });

      yield {
        event: 'invocation_started',
        data: { agentInvocationId, agentName: rendered.agentName, model: rendered.agentDefinition.model },
      };

      yield* runAgent(request.prompt, rendered);
    },
  },
});

const port = process.env['PORT'] ? Number(process.env['PORT']) : undefined;
app.run(port ? { port } : undefined);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
