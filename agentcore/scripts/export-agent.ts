/**
 * Build-time export of an Airlock agent.
 *
 * Calls Airlock's `export_agent` MCP tool and writes the resulting
 * `ClaudeSdkAgentConfig` to `src/generated/agent.json`. The
 * `build-time-export.ts` entrypoint imports this file at bundle time.
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

const mcpUrl = requireEnv('AIRLOCK_MCP_URL');
const agentName = requireEnv('AIRLOCK_AGENT_NAME');
const serviceToken = requireEnv('AIRLOCK_SERVICE_TOKEN');

const config = await fetchAgentConfig({ mcpUrl, agentName, serviceToken });

const outPath = resolve(import.meta.dirname, '../src/generated/agent.json');
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

console.log(`Wrote ${outPath}`);
console.log(`  agentName: ${config.agentName}`);
console.log(`  model:     ${config.agentDefinition.model}`);
console.log(`  tools:     ${config.agentDefinition.tools.length}`);
console.log(`  skills:    ${config.skills.length}`);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}
