/**
 * AgentCore Runtime entrypoint — runtime-fetch pattern (default).
 *
 * On cold start we:
 *   1. Read `AIRLOCK_SERVICE_TOKEN` from Secrets Manager (cached per process).
 *   2. Call Airlock's `export_agent` MCP tool with `adapter: 'bedrock'`.
 *   3. Hydrate each Converse `toolSpec.inputSchema` by calling
 *      `describe_tools` for the aliased real tool names — Bedrock requires
 *      every `toolSpec` to carry an inputSchema before the first call.
 *   4. Cache the hydrated config for the process lifetime.
 *
 * On every invocation we:
 *   1. Generate a fresh `agentInvocationId` UUID.
 *   2. Substitute `${AIRLOCK_TOKEN}` and `${AIRLOCK_AGENT_INVOCATION_ID}`
 *      into `airlockMcp.headers`.
 *   3. Drive the Bedrock Converse loop in `runAgent`; bridge every
 *      `tool_use` back through Airlock's MCP `execute_tool` so policy,
 *      approval, audit, and budget run in their canonical place.
 *
 * One MCP endpoint, one service token: every call (cold-start fetch,
 * cold-start hydration, in-loop tool execution) hits the same URL with
 * the same credential.
 */

import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { fetchAgentConfig } from './lib/airlock-client.ts';
import { describeTools } from './lib/mcp-client.ts';
import { renderConfig } from './lib/render-config.ts';
import { runAgent } from './lib/run-agent.ts';
import { getServiceToken } from './lib/service-token.ts';
import type { BedrockAgentConfig } from './lib/types.ts';

const mcpUrl = requireEnv('AIRLOCK_MCP_URL');
const agentName = requireEnv('AIRLOCK_AGENT_NAME');

let cachedConfig: Promise<BedrockAgentConfig> | undefined;

function getAgentConfig(): Promise<BedrockAgentConfig> {
  cachedConfig ??= (async () => {
    const serviceToken = await getServiceToken();
    const raw = await fetchAgentConfig({ mcpUrl, agentName, serviceToken });
    return hydrateToolSchemas(raw, serviceToken);
  })();
  return cachedConfig;
}

/**
 * Populate each `converse.toolConfig.tools[].toolSpec.inputSchema` from
 * Airlock's `describe_tools` meta-tool. The aliased tool names that
 * appear in the Converse config are the sanitized form; the
 * `airlockMcp.toolAliases` map gives us the real names that
 * `describe_tools` understands.
 */
async function hydrateToolSchemas(
  raw: BedrockAgentConfig,
  serviceToken: string,
): Promise<BedrockAgentConfig> {
  const tools = raw.converse.toolConfig.tools;
  if (tools.length === 0) return raw;

  // Cold-start hydration is not part of any single invocation loop, so we
  // do not stamp an agent-invocation-id on these calls. The auth header
  // alone is the contract here.
  const aliasedNames = tools
    .map((t) => raw.airlockMcp.toolAliases[t.toolSpec.name])
    .filter((n): n is string => Boolean(n));
  const described = await describeTools({
    endpoint: raw.airlockMcp.endpoint,
    headers: { Authorization: `Bearer ${serviceToken}` },
    tools: aliasedNames,
  });
  const byRealName = new Map(described.map((d) => [d.name, d.inputSchema]));

  const hydratedTools = tools.map((t) => {
    const realName = raw.airlockMcp.toolAliases[t.toolSpec.name];
    const schema = realName ? byRealName.get(realName) : undefined;
    if (!schema) {
      throw new Error(
        `No inputSchema returned for tool "${t.toolSpec.name}" (real name: ${realName ?? '?'})`,
      );
    }
    return {
      toolSpec: { ...t.toolSpec, inputSchema: { json: schema } },
    };
  });

  return {
    ...raw,
    converse: {
      ...raw.converse,
      toolConfig: { ...raw.converse.toolConfig, tools: hydratedTools },
    },
  };
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
        data: { agentInvocationId, model: rendered.converse.modelId },
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
