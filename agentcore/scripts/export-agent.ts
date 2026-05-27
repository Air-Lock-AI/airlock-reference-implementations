/**
 * Build-time export of an Airlock agent.
 *
 * Calls Airlock's `export_agent` MCP tool with `adapter: 'bedrock'`,
 * hydrates every Converse `toolSpec.inputSchema` via `describe_tools`, and
 * writes the resulting `BedrockAgentConfig` to `src/generated/agent.json`.
 * The `build-time-export.ts` entrypoint imports that file at bundle time
 * and runs offline — no cold-start network calls to Airlock.
 *
 * Reads env from `.env` (via `process.env`; no dotenv loader). Run as:
 *
 *   AIRLOCK_MCP_URL=https://mcp.air-lock.ai/org/acme \
 *   AIRLOCK_AGENT_NAME=triage \
 *   AIRLOCK_SERVICE_TOKEN=svct_... \
 *   npm run export-agent
 *
 * The output JSON contains placeholders, never resolved secrets — see the
 * doc comment in `build-time-export.ts`.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { fetchAgentConfig } from '../src/lib/airlock-client.ts';
import { describeTools } from '../src/lib/mcp-client.ts';
import type { BedrockAgentConfig } from '../src/lib/types.ts';

const mcpUrl = requireEnv('AIRLOCK_MCP_URL');
const agentName = requireEnv('AIRLOCK_AGENT_NAME');
const serviceToken = requireEnv('AIRLOCK_SERVICE_TOKEN');

const raw = await fetchAgentConfig({ mcpUrl, agentName, serviceToken });
const config = await hydrate(raw);

const outPath = resolve(import.meta.dirname, '../src/generated/agent.json');
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

console.log(`Wrote ${outPath}`);
console.log(`  model:   ${config.converse.modelId}`);
console.log(`  tools:   ${config.converse.toolConfig.tools.length}`);
console.log(`  skills:  ${config.skills.length}`);

async function hydrate(input: BedrockAgentConfig): Promise<BedrockAgentConfig> {
  const tools = input.converse.toolConfig.tools;
  if (tools.length === 0) return input;
  const aliasedNames = tools
    .map((t) => input.airlockMcp.toolAliases[t.toolSpec.name])
    .filter((n): n is string => Boolean(n));
  const described = await describeTools({
    endpoint: input.airlockMcp.endpoint,
    headers: { Authorization: `Bearer ${serviceToken}` },
    tools: aliasedNames,
  });
  const byRealName = new Map(described.map((d) => [d.name, d.inputSchema]));
  const hydratedTools = tools.map((t) => {
    const realName = input.airlockMcp.toolAliases[t.toolSpec.name];
    const schema = realName ? byRealName.get(realName) : undefined;
    if (!schema) {
      throw new Error(
        `No inputSchema returned for tool "${t.toolSpec.name}" (real name: ${realName ?? '?'})`,
      );
    }
    return { toolSpec: { ...t.toolSpec, inputSchema: { json: schema } } };
  });
  return {
    ...input,
    converse: {
      ...input.converse,
      toolConfig: { ...input.converse.toolConfig, tools: hydratedTools },
    },
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}
