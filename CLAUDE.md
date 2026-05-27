# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository shape

Multi-host monorepo of deploy-ready reference implementations for Airlock-authored agents running on customer-owned runtimes. Each top-level subdirectory is a self-contained, deploy-ready reference impl for one host runtime.

Currently implemented: **`agentcore/`** (Amazon Bedrock AgentCore Runtime, TypeScript/Node 22, AWS CDK) — uses Airlock's `bedrock` adapter and drives Bedrock's Converse API directly. The umbrella `README.md` lists six more `TBD` rows, one per remaining adapter (`claude-sdk`, `claude-code`, `openai`, `cursor`, `gemini`, `vercel`); none of those subdirectories exist yet.

When adding a new host, mirror the structure of `agentcore/` and only change host-specific glue. See the umbrella `README.md` for the per-adapter mapping.

## The three load-bearing ideas (every host must implement these)

These are the invariants the reference impls exist to demonstrate. Any change that weakens one of them is a bug, not a refactor:

1. **Render the agent through the host's adapter.** Call Airlock's `export_agent` MCP tool (`tools/call` with `arguments: { agent, adapter }`) against the org's MCP URL. The response's `artifacts[0].content` is structured JSON the host SDK consumes directly. **Never string-parse the adapter output.** Cold-start fetch and tool calls share one channel and one credential.
2. **Wire `agentInvocationId` per invocation, never per process.** The adapter bakes `${AIRLOCK_TOKEN}` and `${AIRLOCK_AGENT_INVOCATION_ID}` into the MCP-server headers. The token is per-process; the invocation id MUST be a fresh UUID per loop run. Every MCP tool call within one loop must carry the same id — that's the audit-log correlation key.
3. **The host runs the LLM loop; Airlock runs the tools.** All tool calls go through `https://mcp.air-lock.ai/org/{slug}` (the URL the adapter writes). Never instantiate a tool client locally, never replay a tool call, never cache a tool result.

## Two deployment patterns (both ship in every host)

- **Pattern A — Runtime fetch (default):** cold start calls `export_agent`, caches the config in module scope, substitutes placeholders per invocation. Control-Room edits propagate within one cold-start cycle.
- **Pattern B — Build-time export:** CI calls `export_agent` before bundling, writes rendered config to a generated file (`src/generated/agent.json` in `agentcore/`), bakes it into the artifact. No cold-start dependency on Airlock; redeploy required for every agent edit.

Under both patterns the exported JSON **never contains resolved secrets** — `${AIRLOCK_TOKEN}` and `${AIRLOCK_AGENT_INVOCATION_ID}` stay as placeholders on disk and are substituted at invocation time only.

## Working in `agentcore/`

All commands are run from inside `agentcore/`. Node 22+ required (AgentCore CodeZip only supports `NODE_22`).

```bash
npm install
npm run bundle             # esbuild → dist/index.js (+ build-time-export.js if generated/agent.json exists)
npm run synth              # CDK synth
npm run deploy             # bundle + cdk deploy
npm run destroy            # cdk destroy
npm run export-agent       # Pattern B: write src/generated/agent.json
npm run typecheck          # tsc --noEmit
npm test                   # vitest run
npx vitest run tests/render-config.test.ts          # single test file
npx vitest run -t "substitutes both placeholders"   # single test by name
```

Required env for deploy (`agentcore/.env`, copy from `.env.example`): `AIRLOCK_MCP_URL` (e.g. `https://mcp.air-lock.ai/org/{slug}`), `AIRLOCK_AGENT_NAME`, `AIRLOCK_TOKEN_SECRET_ARN`, `AWS_REGION`. For Pattern B also set `AIRLOCK_SERVICE_TOKEN` locally (never commit). The build-time-export entrypoint is selected via `AGENT_ENTRYPOINT=build-time-export.js` at deploy time.

### Code map

- `src/index.ts` — Pattern A entrypoint. On cold start: fetches the agent via `export_agent` (adapter=`bedrock`), then **hydrates** each `toolSpec.inputSchema` via `describe_tools` (Converse requires schemas). Caches the hydrated config + service token per process; generates a fresh `agentInvocationId` UUID per invocation; renders headers; drives `runAgent`.
- `src/build-time-export.ts` — Pattern B entrypoint. Imports the pre-hydrated `./generated/agent.json` at bundle time; runs offline (no cold-start MCP calls). Otherwise identical to `index.ts`.
- `src/lib/types.ts` — Mirror of the `bedrock` adapter's output shape (`BedrockAgentConfig`). The single source of truth for the adapter contract; if Airlock's adapter evolves, only this file changes.
- `src/lib/airlock-client.ts` — `fetchAgentConfig()` calls `export_agent` over MCP with adapter=`bedrock`. **No retries by design** — a failed cold-start fetch should fail loud, not paper over with stale data.
- `src/lib/mcp-client.ts` — JSON-RPC `tools/call` helper + thin `describeTools` / `executeTool` wrappers. Three call sites (cold-start fetch, cold-start hydration, in-loop tool dispatch) share this plumbing.
- `src/lib/render-config.ts` — Placeholder substitution. Intentionally narrow: only walks `airlockMcp.headers`. Returns a shallow copy; never mutates the cached config.
- `src/lib/service-token.ts` — Resolves the service token from `AIRLOCK_SERVICE_TOKEN` env var (local dev) or `AIRLOCK_TOKEN_SECRET_ARN` Secrets Manager. Cached per process.
- `src/lib/run-agent.ts` — Drives Bedrock's `ConverseStreamCommand` loop. On `stopReason: tool_use` it resolves the alias via `airlockMcp.toolAliases`, POSTs `execute_tool` to MCP, feeds the result back as a Converse `toolResult` content block, and repeats until `end_turn`. Surfaces MCP error bodies in `toolResult.error` so the model can self-correct. Applies the cross-region inference-profile prefix (`us.` / `eu.` / `apac.` / `global.`) to the model id based on `AWS_REGION`. Translates Converse stream events into AgentCore SSE (`message`, `tool_use`, `tool_result`, `result`, `error`).
- `scripts/bundle.ts` — esbuild → `dist/`. Bundles everything reachable through static imports — **including** `@aws-sdk/*`, since the AgentCore Runtime container does NOT pre-install the AWS SDK at `/var/task` (verified the hard way: deploy crashed at `require('@aws-sdk/credential-provider-node')`). Injects an `import.meta.url` shim via banner so ESM-source deps bundled to CJS still resolve. The only externals are `@fastify/sse` and `@fastify/websocket`: `bedrock-agentcore` pulls them in via `createRequire(import.meta.url)('…')`, which bypasses the bundle's module registry, so they're shipped in `dist/node_modules/` via a post-bundle `npm install`. Conditionally bundles `build-time-export.ts` only if `src/generated/agent.json` exists.
- `scripts/export-agent.ts` — Build-time export script for Pattern B. Calls both `export_agent` AND `describe_tools` so the written `agent.json` is fully hydrated.
- `infrastructure/agentcore-stack.ts` — CDK stack. Uses the L1 `AWS::BedrockAgentCore::Runtime` CFN resource (no L2 construct exists in `aws-cdk-lib@^2.257.0`). IAM scoped to `bedrock:InvokeModel*`, the single secret ARN, and the runtime's CloudWatch log group.
- `infrastructure/bin/app.ts` — CDK app entry; `AGENT_ENTRYPOINT` env var selects Pattern A vs B.
- `.github/workflows/agentcore-deploy.yml` — `workflow_dispatch` deploy with `stage` (environment) and `pattern` (`runtime-fetch` / `build-time-export`) inputs.

### Host-specific notes for `agentcore/`

- AgentCore Runtime is **arm64-only**. esbuild output is pure JS so this is normally invisible — but any future native npm dep needs `npm install --arch=arm64 --platform=linux`.
- `NetworkMode: PUBLIC` in the stack; switch to `VPC` if the service token must stay on a private network.
- Inbound auth is SIGv4 by default; OAuth via `AuthorizerConfiguration` if needed.
- `dist/` and `cdk.out/` are build outputs and gitignored; `src/generated/` is gitignored too (produced by `npm run export-agent`).

## TypeScript conventions used here

- ESM project (`"type": "module"`). Relative imports include the `.ts` extension (`./lib/types.ts`) because `tsconfig.json` sets `allowImportingTsExtensions` and the runtime uses `node --experimental-strip-types`.
- `noUncheckedIndexedAccess` is on — index accesses are `T | undefined`. Don't paper over with non-null assertions unless the invariant is local and obvious.
- Zod (`zod@^4`) is the request-validation library for invocation handlers.
