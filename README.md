# airlock-agentcore-reference

Reference implementation: deploy an [Airlock](https://air-lock.ai)-authored agent to **Amazon Bedrock AgentCore Runtime** on Node.js.

This repo is the canonical example for [RFC-011 — Portable Agents](https://linear.app/air-lock/issue/AIR-359). It shows how to take an agent defined in the Airlock Control Room, render it through the `claude-sdk` adapter, and run it on a host you own — with every tool call still flowing through Airlock's governance plane (policy, approval, audit, budgets).

> **Status:** v0.1. Tracking ticket: [AIR-374](https://linear.app/air-lock/issue/AIR-374). Tested against `bedrock-agentcore@^0.2.4` and `@anthropic-ai/claude-agent-sdk@^0.3.150`.

---

## What you get vs. what you own

| Airlock owns | You own |
|---|---|
| Agent definition (system prompt, model preference, tool allowlist, skills, budget, approval mode) | This repo — deployment glue + IAM + observability |
| Tool catalog + policy engine + approval workflow | The AWS account hosting the AgentCore Runtime |
| Audit log + `agentInvocationId` correlation | The service-token rotation + storage |
| Budget enforcement | The model-access entitlement in Bedrock |
| Per-invocation MCP authentication | The CDK stack, the bundling, the redeploy schedule |

Concretely: the agent definition lives in `https://control-room.air-lock.ai/<your-org>/agents/<name>`. Every tool call the agent makes goes back through `https://mcp.air-lock.ai/org/<your-org>`. This repo is the loop driver — not the policy engine.

See [RFC-011 §6.4 — portability bounds](https://github.com/Air-Lock-AI/airlock/blob/main/docs/rfcs/RFC-011-portable-agents.md#64-same-agent-a-third-host-nobody-anticipated--and-what-limits-portable) for what AgentCore can and cannot express vs. the canonical `AgentSpec`.

---

## Two patterns, pick one

This repo ships both. Each is a separate entrypoint; the CDK stack picks one via `AGENT_ENTRYPOINT`.

### Pattern A — Runtime fetch (default, `src/index.ts`)

On cold start, the runtime calls Airlock's REST `export_agent?adapter=claude-sdk` and caches the rendered config in module scope for the rest of the worker's life. Every invocation reuses the cached config; substitution of `${AIRLOCK_TOKEN}` and `${AIRLOCK_AGENT_INVOCATION_ID}` happens per call.

- **Pro:** edits to the agent in the Control Room reach the deployed runtime within one cold-start cycle. No redeploy.
- **Con:** cold start depends on Airlock being reachable. If Airlock's REST API is down when your runtime cycles workers, new invocations fail fast (loud, visible in CloudWatch) rather than serving stale state. This is intentional — silent staleness is worse than visible outage.

This is the right default for almost everyone.

### Pattern B — Build-time export (`src/build-time-export.ts`)

The CI workflow runs `npm run export-agent` before bundling, writing the rendered config to `src/generated/agent.json`. That JSON gets baked into the deployment zip. The deployed runtime never talks to Airlock except via the MCP endpoint (which it does need at invocation time, for the actual tool calls).

- **Pro:** no cold-start dependency on Airlock's REST API. Air-gappable. Deterministic — same deploy, same agent.
- **Con:** every Control-Room edit to the agent spec requires a redeploy to take effect.

Right answer when: you have strict deploy-determinism requirements, run in an isolated VPC, or your compliance posture forbids fetching config from outside the deployment artifact.

The exported JSON **does not contain secrets.** The `${AIRLOCK_TOKEN}` and `${AIRLOCK_AGENT_INVOCATION_ID}` placeholders the adapter bakes in are still placeholders on disk — they're substituted at invocation time, the same way as Pattern A.

---

## Prerequisites

- An Airlock organization with at least one agent. The walkthrough below uses the `triage` agent from RFC-011 §6.1 — you can either create it (paste the spec from the RFC into the Control Room agent editor) or substitute any agent name you already have.
- AWS account with:
  - Bedrock model access enabled for Anthropic Claude Sonnet 4 (the model `triage` resolves to via `claude-sdk/models.ts`). Console: Bedrock → Model access → enable `anthropic.claude-sonnet-4-*`.
  - AgentCore Runtime available in your target region (`us-west-2`, `us-east-1`, `eu-central-1`, plus newer regions — check the [AWS What's New page](https://aws.amazon.com/about-aws/whats-new/2026/04/amazon-bedrock-agentcore-runtime/)).
  - Permissions to create IAM roles, Secrets Manager entries, and Bedrock AgentCore Runtimes.
- **Node.js 22+** locally. AgentCore Runtime CodeZip only supports `NODE_22` today.
- AWS CDK bootstrapped in your target account: `npx cdk bootstrap aws://<account>/<region>`.

---

## Setup walkthrough

### 1. Clone + install

```bash
git clone https://github.com/Air-Lock-AI/airlock-agentcore-reference.git
cd airlock-agentcore-reference
npm install
```

### 2. Create an Airlock service token

In the Control Room: **Settings → Service Accounts → New service account**. Give it the toolset assignment that matches the agent you're deploying (otherwise the agent's allowed tools won't be visible to the loop). Copy the token — it starts with `svct_` and is shown once.

### 3. Store the token in AWS Secrets Manager

```bash
aws secretsmanager create-secret \
  --name airlock/agentcore-reference/service-token \
  --secret-string "svct_..." \
  --region us-west-2
```

Copy the returned `ARN` — you'll put it in `.env` next.

### 4. Configure env

```bash
cp .env.example .env
# Edit .env: set AIRLOCK_ORG_SLUG, AIRLOCK_AGENT_NAME, AIRLOCK_TOKEN_SECRET_ARN, AWS_REGION.
```

If you want to use Pattern B (build-time export), also set `AIRLOCK_SERVICE_TOKEN` in `.env` — but only locally. **Never commit that value.**

### 5. Bundle + deploy

```bash
# Bundle src/index.ts and src/build-time-export.ts to dist/ via esbuild
npm run bundle

# Synth to inspect what will be created
npm run synth

# Deploy
npm run deploy
```

If you want Pattern B:

```bash
npm run export-agent   # writes src/generated/agent.json
npm run bundle
AGENT_ENTRYPOINT=build-time-export.js npm run deploy
```

The stack output prints `AgentRuntimeArn` — copy it.

### 6. Invoke the agent

```bash
cat > invoke.ts <<'EOF'
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { randomUUID } from 'node:crypto';

const arn = process.env.AGENT_RUNTIME_ARN!;
const client = new BedrockAgentCoreClient({ region: 'us-west-2' });
const command = new InvokeAgentRuntimeCommand({
  agentRuntimeArn: arn,
  runtimeSessionId: randomUUID(),
  payload: JSON.stringify({ prompt: 'Triage issue #1294 — look at the title and labels and suggest a route.' }),
  contentType: 'application/json',
  qualifier: 'DEFAULT',
});
const response = await client.send(command);
console.log(await response.response?.transformToString());
EOF

AGENT_RUNTIME_ARN=<arn from step 5> npx tsx invoke.ts
```

You should see SSE events stream back — `invocation_started`, `tool_use`, `message`, and a final `result`.

### 7. Watch the audit log

In the Control Room: **Logs → AuditLog**. Filter by your service-account ID. You'll see one row per tool call, all sharing the same `agentInvocationId` — that's the UUID we generated in `src/index.ts` and put in the `X-Airlock-Agent-Invocation-Id` header on every MCP call. This is the load-bearing piece — it's what makes "this run of the agent" a queryable concept across tool calls.

If the correlation id is missing, the agent isn't reaching Airlock's MCP endpoint correctly — usually because of a typo in the toolset assignment or because the service token has been rotated. Check CloudWatch logs at `/aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT`.

---

## Local development

`agentcore dev` from the [AgentCore CLI](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-cli-typescript.html) runs the runtime locally on `http://localhost:8080`. Configure it to bundle `dist/index.js` (or `dist/build-time-export.js`) as the entrypoint after `npm run bundle`.

For quick smoke tests:

```bash
AIRLOCK_ORG_SLUG=acme \
AIRLOCK_AGENT_NAME=triage \
AIRLOCK_SERVICE_TOKEN=svct_... \
node --experimental-strip-types src/index.ts &
curl -X POST http://localhost:8080/invocations \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"hello"}'
```

---

## Repo layout

```
.
├── README.md                       ← you are here
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                    ← Pattern A entrypoint (runtime fetch)
│   ├── build-time-export.ts        ← Pattern B entrypoint (baked in)
│   ├── generated/                  ← gitignored; produced by `npm run export-agent`
│   └── lib/
│       ├── types.ts                ← claude-sdk adapter shape
│       ├── airlock-client.ts       ← REST export_agent fetch
│       ├── render-config.ts        ← placeholder substitution
│       ├── service-token.ts        ← Secrets Manager / env-var resolution
│       └── run-agent.ts            ← Claude Agent SDK driver
├── scripts/
│   ├── bundle.ts                   ← esbuild → dist/
│   └── export-agent.ts             ← writes src/generated/agent.json
├── infrastructure/
│   ├── cdk.json
│   ├── bin/app.ts                  ← CDK app entry
│   └── agentcore-stack.ts          ← AgentCore Runtime + IAM
├── tests/
│   ├── render-config.test.ts
│   └── airlock-client.test.ts
└── .github/workflows/deploy.yml    ← example CI deploy
```

---

## Reference & further reading

- Notion: [V1 MVP — agent portability](https://www.notion.so/28eb59c8985d839a999a81a33a9fcf95) (`Air-Lock-AI` workspace)
- Notion: [V2 backlog — agent portability](https://www.notion.so/364b59c8985d81f7b526c9a00a1945b8)
- [RFC-011 — Portable agents](https://github.com/Air-Lock-AI/airlock/blob/main/docs/rfcs/RFC-011-portable-agents.md), especially:
  - §5.1 — `AgentEnvelope` / `AgentSpec` shape
  - §5.3 — adapter runtime contract
  - §5.7 — `agentInvocationId` correlation
  - §6.1 — `triage` worked example
  - **§6.4 — portability bounds** (what AgentCore can and can't express)
- [AWS Bedrock AgentCore Runtime — TypeScript getting started](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-cli-typescript.html)
- [`bedrock-agentcore` SDK](https://github.com/aws/bedrock-agentcore-sdk-typescript)
- [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)

---

## Sibling repos (planned)

This is the first reference implementation. The same pattern — *export the agent through a vendor adapter, run it on a host you own* — works for any MCP-speaking runtime. Planned siblings:

- `airlock-vertex-ae-reference` (Vertex AI Agent Engine, Python)
- `airlock-lambda-reference` (AWS Lambda + Function URL, Node.js)
- `airlock-cloud-run-reference` (Google Cloud Run, Python)

If you build one against another runtime, open an issue or PR — we'll link it from here.

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
