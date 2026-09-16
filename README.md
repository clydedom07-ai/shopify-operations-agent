# Shopify Operations Agent

An AI e-commerce operations specialist. It investigates Shopify operations,
reads customer and supplier email, detects operational problems, takes the
actions it is **permitted** to take, holds significant ones for human approval,
then hands back into the surrounding automation — so the humans decide what only
humans should.

It runs **TypeScript directly on Node 24's native type-stripping** — there is no
build step. Clone, install, configure, run.

## What it does

Given an event — "where is order #1001?", a delayed-supplier email, a proactive
ops sweep, a Slack message, a customer email — the agent walks a deterministic
investigation SOP through a tool registry (Shopify orders, suppliers, internal
REST, n8n, Slack), then produces a structured verdict:

- routine findings are resolved and (where appropriate) acted on automatically;
- refunds, replacements, discounts, write-backs, and outbound customer emails
  are raised as **pending human approvals** and executed only after a human
  approves the exact action;
- credential access and destructive actions are **refused and audited**.

### Two principles that hold it together

- **Deterministic permissions, never an LLM confidence score.** Every action
  kind maps to `auto`, `approval`, or `blocked` in a static policy. An LLM may
  fill in scores, but the permission system never consults them.
- **Never invent.** The agent does not fabricate tracking numbers, delivery
  dates, refunds, discounts, supplier statements, or order facts. If a read
  fails or an order is unknown, it says so honestly. The structured result and
  the n8n callback payload are built from persisted records, not model
  narration.

Everything is audited: events, tool calls, approvals, and decisions.

## Integrations

Every backend sits behind an interface with a **`mock`** (hermetic, zero
credentials, zero network) and a **`http`** (live) implementation — swapping in
real services never touches the agent core.

| Integration | Status | Mode |
| --- | --- | --- |
| Shopify — read/investigate + `addOrderNote` | ✅ | `mock` (default) / `http` |
| Email (customer + supplier intake) | ✅ | `off` / `mock` |
| n8n — post-completion webhook + workflow trigger | ✅ | `off` / `mock` / `http` |
| Slack — inbound → tasks, conservative auto-ack | ✅ | `off` / `mock` / `http` |
| Generic REST — one base origin, reads auto / writes approval | ✅ | `off` / `mock` / `http` |
| Postgres persistence (local Docker or Supabase) | ✅ | `memory` (default) / `postgres` |

Running with **zero credentials** is the designed default: no API key, no
Shopify token, no webhooks — the scripted gateway and mock backends drive the
full agent loop hermetically.

## Quick start

Requires **Node.js ≥ 24** and **pnpm ≥ 10**.

```sh
git clone https://github.com/clydedom07-ai/shopify-operations-agent.git
cd shopify-operations-agent
pnpm install
cp .env.example .env     # safe defaults: memory persistence, mock Shopify
pnpm start
```

On boot you see the resolved configuration, e.g.:

```json
{"persistence":"memory","port":3000,"tools":14,"pendingTasks":0,"llm":"scripted",
 "emailIngestion":"off","slackNotify":"off","slackIngestion":"off","n8nCallback":"off",
 "rest":"off","shopify":"mock","msg":"Shopify Operations Agent booted"}
```

Hit the API (default token `local-dev-token`):

```sh
curl -X POST http://127.0.0.1:3000/agent/investigate-order \
  -H "authorization: Bearer local-dev-token" \
  -H "content-type: application/json" \
  -d '{"text":"Where is order #1001?","orderId":"ord_1001"}'
# {"taskId":"…","status":"pending","eventType":"manual_investigation"}
```

`pnpm dev` runs in watch mode; `pnpm test` runs the hermetic suite (119 tests,
no network, no database).

## Configuration

Copy `.env.example` to `.env` and edit. `.env` deliberately **overrides ambient
shell variables**, so a stray `DATABASE_URL` in your shell can never capture the
agent. Highlights:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PERSISTENCE` | `memory` | `memory` / `auto` / `postgres` — where tasks, approvals, issues live |
| `DATABASE_URL` | — | Postgres URL — local Docker or Supabase (`sslmode=require` → TLS) |
| `SHOPIFY_MODE` | `mock` | `off` / `mock` / `http` — live mode needs `SHOPIFY_STORE` + `SHOPIFY_ACCESS_TOKEN` |
| `ANTHROPIC_API_KEY` | — | Set → real Claude gateway (`claude-opus-5`, adaptive thinking, streaming); unset → deterministic scripted SOP |
| `N8N_CALLBACK` / `SLACK_NOTIFY` / `SLACK_INGESTION` / `REST_MODE` / `EMAIL_INGESTION` | `off` | `mock` hermetic / `http` live as applicable |

The full env reference, the HTTP API reference, and the permission model are in
**[SETUP.md](SETUP.md)**.

## Persistence

`memory` is the safe default — nothing is written anywhere implicitly. For
durable state:

```sh
docker compose up -d        # local Postgres 17 (agent/agent/agent on :5432)
```

```sh
PERSISTENCE=postgres
DATABASE_URL=postgres://agent:agent@localhost:5432/agent
```

Migrations auto-run at boot (`src/db/migrations/*.sql`, forward-only, tracked in
`schema_migrations`). Supabase works the same way — same `DATABASE_URL` shape,
TLS enabled automatically on `sslmode=require`. Tasks are claimed atomically
(`FOR UPDATE SKIP LOCKED`), so the worker stops, restarts, and scales across
replicas without double-processing.

## Docker

This project is a single **stateless** Node 24 container — state lives in
Postgres, so it deploys anywhere and scales to zero.

```sh
docker build -t shopify-ops-agent .
docker run --rm -p 3000:3000 -e PERSISTENCE=memory shopify-ops-agent
```

The image runs as non-root, binds `0.0.0.0:3000`, and ships with **no secrets** —
configuration comes from the runtime environment. See [SETUP.md §13](SETUP.md)
for Docker + Supabase details.

## License

[MIT](LICENSE) — © 2026 clydedom-shopify. Bundled third-party components retain
their own licenses (e.g. the Ghost skill under BSD-3-Clause).