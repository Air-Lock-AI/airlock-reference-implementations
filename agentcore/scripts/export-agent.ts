/**
 * Build-time export of an Airlock agent.
 *
 * Calls Airlock's REST `export_agent?adapter=claude-sdk` and writes the
 * resulting `ClaudeSdkAgentConfig` to `src/generated/agent.json`. The
 * `build-time-export.ts` entrypoint imports this file at bundle time.
 *
 * Reads env from `.env` (via `process.env`; no dotenv loader). Run as:
 *
 *   AIRLOCK_ORG_SLUG=acme \
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

const orgSlug = requireEnv('AIRLOCK_ORG_SLUG');
const agentName = requireEnv('AIRLOCK_AGENT_NAME');
const serviceToken = requireEnv('AIRLOCK_SERVICE_TOKEN');
const apiBaseUrl = process.env['AIRLOCK_API_BASE_URL'] ?? 'https://api.air-lock.ai';

const config = await fetchAgentConfig({ apiBaseUrl, orgSlug, agentName, serviceToken });

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
