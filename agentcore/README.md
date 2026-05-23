# agentcore/

Reference deployment of an Airlock agent to **Amazon Bedrock AgentCore Runtime** on Node.js. One of several hosts under [`airlock-reference-implementations`](../README.md) — read the umbrella README first if you haven't.

> **Status:** v0.1. Tracking: [AIR-374](https://linear.app/air-lock/issue/AIR-374). Tested against `bedrock-agentcore@^0.2.4` and `@anthropic-ai/claude-agent-sdk@^0.3.150`.

## Adapter

This impl uses the **`claude-sdk` adapter** — the AgentCore Runtime hosts the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) loop, which talks to Airlock's MCP endpoint via the `Options.mcpServers` HTTP transport.

The adapter's output is a JSON object with `agentName`, `agentDefinition`, `mcpServers`, `skills`, and `airlock` (stash). See `src/lib/types.ts` for the mirror of that shape.

## Prerequisites

- An Airlock organization with at least one agent. The walkthrough below uses the `triage` agent from RFC-011 §6.1 — paste the spec from the RFC into the Control Room agent editor, or substitute any agent name you already have.
- AWS account with:
  - Bedrock model access enabled for Anthropic Claude Sonnet 4 (Console: Bedrock → Model access).
  - AgentCore Runtime available in your target region. Check the [AWS What's New page](https://aws.amazon.com/about-aws/whats-new/2026/04/amazon-bedrock-agentcore-runtime/) for the current region list.
  - Permissions for IAM, Secrets Manager, S3, and Bedrock AgentCore.
- **Node.js 22+** locally. AgentCore Runtime CodeZip only supports `NODE_22`.
- AWS CDK bootstrapped: `npx cdk bootstrap aws://<account>/<region>`.

## Setup walkthrough

### 1. Install

```bash
cd agentcore
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
# Edit: set AIRLOCK_ORG_SLUG, AIRLOCK_AGENT_NAME, AIRLOCK_TOKEN_SECRET_ARN, AWS_REGION.
```

For Pattern B (build-time export), also set `AIRLOCK_SERVICE_TOKEN` in `.env`, locally only. **Never commit that value.**

### 5. Bundle + deploy (Pattern A — runtime fetch, default)

```bash
npm run bundle    # esbuild → dist/index.js
npm run synth     # inspect the CloudFormation
npm run deploy    # deploys via CDK
```

For Pattern B:

```bash
npm run export-agent     # writes src/generated/agent.json
npm run bundle
AGENT_ENTRYPOINT=build-time-export.js npm run deploy
```

Stack output prints `AgentRuntimeArn`.

### 6. Invoke

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
  payload: JSON.stringify({ prompt: 'Triage issue #1294 — suggest a route.' }),
  contentType: 'application/json',
  qualifier: 'DEFAULT',
});
const response = await client.send(command);
console.log(await response.response?.transformToString());
EOF

AGENT_RUNTIME_ARN=<arn from step 5> npx tsx invoke.ts
```

You'll see SSE events stream back — `invocation_started`, `tool_use`, `message`, and a final `result`.

### 7. Watch the audit log

Control Room: **Logs → AuditLog**. Filter by your service-account ID. One row per tool call, all sharing the same `agentInvocationId` — the UUID `src/index.ts` generates per invocation and pins to the `X-Airlock-Agent-Invocation-Id` header on every MCP call.

If the correlation id is missing, the agent isn't reaching Airlock's MCP endpoint correctly — usually a typo in the toolset assignment or a rotated token. Check CloudWatch at `/aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT`.

## Local development

[`agentcore dev`](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-cli-typescript.html) from the AgentCore CLI runs the runtime locally on `http://localhost:8080`. Configure it to bundle `dist/index.js` (or `dist/build-time-export.js`) as the entrypoint after `npm run bundle`.

Quick smoke test:

```bash
AIRLOCK_ORG_SLUG=acme \
AIRLOCK_AGENT_NAME=triage \
AIRLOCK_SERVICE_TOKEN=svct_... \
node --experimental-strip-types src/index.ts &
curl -X POST http://localhost:8080/invocations \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"hello"}'
```

## Layout

```
agentcore/
├── README.md
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                  ← Pattern A entrypoint (runtime fetch)
│   ├── build-time-export.ts      ← Pattern B entrypoint (baked in)
│   ├── generated/                ← gitignored; produced by `npm run export-agent`
│   └── lib/
│       ├── types.ts              ← mirror of claude-sdk adapter shape
│       ├── airlock-client.ts     ← REST export_agent fetch
│       ├── render-config.ts      ← placeholder substitution
│       ├── service-token.ts      ← Secrets Manager / env-var resolution
│       └── run-agent.ts          ← Claude Agent SDK driver
├── scripts/
│   ├── bundle.ts                 ← esbuild → dist/
│   └── export-agent.ts           ← writes src/generated/agent.json
├── infrastructure/
│   ├── cdk.json
│   ├── bin/app.ts                ← CDK app entry
│   └── agentcore-stack.ts        ← AWS::BedrockAgentCore::Runtime + IAM
└── tests/
    ├── render-config.test.ts
    └── airlock-client.test.ts
```

## Host-specific notes

- AgentCore Runtime is **arm64-only**. esbuild produces pure JS so this is invisible to you — but native npm modules need `npm install --arch=arm64 --platform=linux`. The current dep set is pure JS.
- CodeZip max size: 250 MB zipped / 750 MB unzipped. Current `dist/index.js` is ~2.8 MB.
- CDK uses the L1 `AWS::BedrockAgentCore::Runtime` resource directly. No L2 construct exists yet in `aws-cdk-lib@^2.257.0`.
- The `NetworkMode: PUBLIC` is the simplest option; switch to `VPC` if your service token must stay inside a private network (Secrets Manager works from inside a VPC fine).
- Inbound auth is SIGv4 (default) — the invoker uses AWS creds. To use OAuth instead, see `AuthorizerConfiguration` and the [AgentCore OAuth docs](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-oauth.html).

## References

- [AWS Bedrock AgentCore Runtime — TypeScript getting started](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-cli-typescript.html)
- [`bedrock-agentcore` SDK](https://github.com/aws/bedrock-agentcore-sdk-typescript)
- [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [HTTP protocol contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html)
- [`AWS::BedrockAgentCore::Runtime` CFN reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-bedrockagentcore-runtime.html)
