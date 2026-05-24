# airlock-reference-implementations

Deployable reference implementations of [Airlock](https://air-lock.ai)-authored agents running on customer-owned hosts.

Each subdirectory is a self-contained, deploy-ready repo for one host runtime. They all share the same three load-bearing ideas; the rest is host glue.

| Host | Subdir | Status | Language | Infra |
|---|---|---|---|---|
| **Amazon Bedrock AgentCore Runtime** | [`agentcore/`](./agentcore) | v0.1 | TypeScript / Node 22 | AWS CDK |
| AWS Lambda + Function URL | `lambda/` | planned | TypeScript / Node 22 | AWS CDK |
| Google Vertex AI Agent Engine | `vertex-ae/` | planned | Python | GCP CDK / Terraform |
| Google Cloud Run | `cloud-run/` | planned | Python | Terraform |

---

## The three load-bearing ideas

Every reference implementation does the same three things. If you're writing one for a host that isn't listed yet, copy these from the closest sibling and change only the bits that are actually host-specific.

### 1. Render the agent through the right adapter

Airlock stores an agent as a portable `AgentSpec`. Before the host can run it, Airlock renders it into the host's native shape via an *adapter*:

| Host | Adapter | Output shape |
|---|---|---|
| AgentCore (Node) | `claude-sdk` | `{ agentName, agentDefinition, mcpServers, skills, airlock }` |
| Lambda (Node) | `claude-sdk` | same |
| Vertex AE (Py) | `gemini` | Vertex `GenerativeModel` + function-calling config |
| Cloud Run (Py) | `vercel` or `openai` | depends on which Python loop driver you pick |

Get the rendered output via either:
- **Runtime**: `GET https://api.air-lock.ai/v1/orgs/{slug}/agents/{name}/export?adapter={adapter}`
- **MCP tool**: `export_agent` (org-wide MCP endpoint)

Either way, the adapter returns a JSON object the host SDK can consume directly. **No string parsing.** The `content` field of the artifact is structured data on purpose.

### 2. Wire the per-invocation `agentInvocationId`

The adapter bakes two placeholders into the MCP-server config it hands you:

```
Authorization:                Bearer ${AIRLOCK_TOKEN}
X-Airlock-Agent-Invocation-Id: ${AIRLOCK_AGENT_INVOCATION_ID}
```

Substitute these **at invocation time**, never at build time:

- `${AIRLOCK_TOKEN}` — your service token. One per process is fine.
- `${AIRLOCK_AGENT_INVOCATION_ID}` — a fresh UUID **per invocation** of the agent loop.

Every MCP tool call the agent makes within one loop carries the same invocation id. That's what makes "this run of the agent" a queryable concept in the Airlock audit log — without it you have N independent tool-call rows and no way to ask "what did the agent do for that one user request?" This is the single most important contract — get it wrong and your audit log becomes useless.

### 3. Don't re-implement tool execution

The host runs the LLM loop. **Airlock runs the tools.** Every tool call goes through `https://mcp.air-lock.ai/org/{slug}` (the URL the adapter writes into the MCP-server config). That's where the policy engine, the approval workflow, the budget check, and the audit log all run.

You never instantiate a tool client in the host code. You never replay a tool call. You never cache a tool result. If you find yourself reaching for any of those, you're rebuilding what Airlock is for.

---

## What you own vs. what Airlock owns

This is true for every host — only the noun "AgentCore Runtime" changes per row.

| Airlock owns | You own |
|---|---|
| Agent definition (system prompt, model preference, tool allowlist, skills, budget, approval mode) | The reference impl in this repo — deployment glue + IAM + observability |
| Tool catalog + policy engine + approval workflow | The cloud account hosting the runtime |
| Audit log + `agentInvocationId` correlation | The service-token rotation + storage |
| Budget enforcement | The model-access entitlement on your cloud |
| Per-invocation MCP authentication | The infra-as-code, the bundling, the redeploy schedule |

Some host runtimes can't express every field of the canonical `AgentSpec` — adapters lossy-render where they must, and stash the unrepresented bits in the `airlock` field of the output for round-trip fidelity.

---

## Two deployment patterns (every host gets both)

Each subdir ships both. Pick one per environment — same code path, different staging.

### Pattern A — Runtime fetch (default)

The deployed runtime calls Airlock's REST `export_agent` on cold start, caches the rendered config in module scope, and substitutes placeholders per invocation.

- **Pro:** Control-Room edits to the agent reach the deployed runtime within one cold-start cycle. No redeploy.
- **Con:** Cold start depends on Airlock being reachable. Failures are loud (visible in cloud logs) rather than silently serving stale state — by design.

### Pattern B — Build-time export

CI calls `export_agent` before bundling, writes the rendered config to a generated file, and bakes it into the deployment artifact. The runtime never touches Airlock's REST API.

- **Pro:** No cold-start dependency on Airlock. Air-gappable. Deterministic.
- **Con:** Every Control-Room agent edit requires a redeploy.

The exported JSON **never contains secrets** — the `${AIRLOCK_TOKEN}` and `${AIRLOCK_AGENT_INVOCATION_ID}` placeholders the adapter emits stay as placeholders on disk under both patterns. They're substituted at invocation time, always.

---

## Picking a starting point

| You want to… | Start with |
|---|---|
| Deploy an Airlock agent on AWS, Node.js, dedicated runtime | [`agentcore/`](./agentcore) |
| Build a reference impl for a host that's not listed yet | Copy the closest sibling, change only host-specific bits. PRs welcome. |
| Understand the contract without deploying anything | Read this README end-to-end — the three load-bearing ideas above are the whole contract. |

---

## Contributing a new host

Adding a host (e.g. `lambda/`, `vertex-ae/`) means writing one more reference impl that:

1. Calls `export_agent` with the right adapter for its language/SDK
2. Substitutes the two placeholders per invocation
3. Drives the LLM loop with the host SDK, pointing tools at the Airlock MCP endpoint
4. Ships a deploy-ready infra-as-code stack and a README that walks a new user end-to-end

When in doubt, mirror the structure of [`agentcore/`](./agentcore). Open a PR; we'll link it from the table above.

---

## Reference & further reading

- [Airlock Control Room](https://control-room.air-lock.ai)
- [Airlock site](https://air-lock.ai)

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
