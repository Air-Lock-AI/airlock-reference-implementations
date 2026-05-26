# airlock-reference-implementations

Deployable reference implementations of [Airlock](https://air-lock.ai)-authored agents running on customer-owned hosts.

Each subdirectory is a self-contained, deploy-ready repo for one host runtime. They all share the same three load-bearing ideas; the rest is host glue.

Airlock ships **seven adapter targets** end-to-end (`export_agent` renders an `AgentSpec` into each host's native shape). One reference impl per adapter is the target state for this repo; today only the `claude-sdk` row is deployable.

| Adapter | Host runtime | Subdir | Status |
|---|---|---|---|
| `claude-sdk` | **Amazon Bedrock AgentCore Runtime** (TypeScript / Node 22, AWS CDK) | [`agentcore/`](./agentcore) | v0.1 |
| `claude-code` | Claude Code CLI (install target, not a server deploy) | TBD | planned |
| `openai` | OpenAI Agents SDK loop, host of your choice | TBD | planned |
| `cursor` | Cursor IDE (install target, not a server deploy) | TBD | planned |
| `bedrock` | AWS Bedrock Converse API, host of your choice | TBD | planned |
| `gemini` | Google Gemini SDK loop, host of your choice | TBD | planned |
| `vercel` | Vercel AI SDK loop, host of your choice | TBD | planned |

---

## The three load-bearing ideas

Every reference implementation does the same three things. If you're writing one for a host that isn't listed yet, copy these from the closest sibling and change only the bits that are actually host-specific.

### 1. Render the agent through the right adapter

Airlock stores an agent as a portable `AgentSpec`. Before the host can run it, Airlock renders it into the host's native shape via an *adapter*. Pick the adapter whose native shape your host SDK already understands — the seven shipped today are `claude-sdk`, `claude-code`, `openai`, `cursor`, `bedrock`, `gemini`, and `vercel`.

Get the rendered output by calling the `export_agent` MCP tool on the org's MCP endpoint (`POST {mcpUrl}` with JSON-RPC `tools/call`, arguments `{ agent, adapter }`). The adapter returns a JSON object the host SDK can consume directly. **No string parsing.** The `content` field of the artifact is structured data on purpose.

One MCP URL, one service token, one channel: the same endpoint and credential handles cold-start config fetch *and* every per-invocation tool call.

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

Adding a host means writing one more reference impl — one of the six `TBD` rows above, or a new deployment target for an adapter already covered — that:

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
