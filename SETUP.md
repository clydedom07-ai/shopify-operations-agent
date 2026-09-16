# Shopify Operations Agent — Setup Guide

An AI Ecommerce Operations Specialist: it investigates Shopify operations, reads
customer and supplier email, detects operational problems, takes permitted
actions, and holds significant ones for human approval — then calls back into
n8n so the surrounding automation can continue.

Current integration status:

| Integration | Status |
| --- | --- |
| Shopify read/investigate + deterministic permission tiers | ✅ Done |
| Email ingestion (customer + supplier) | ✅ Done |
| n8n callback (post-completion webhook + workflow trigger tool) | ✅ Done |
| Slack (inbound messages → tasks; auto ack on the channel) | ✅ Done |
| Generic REST (reads auto, writes approval, one base origin) | ✅ Done |

There is no build step — the project runs TypeScript directly on Node's native
type-stripping. Clone, install, configure, run.

---

## 1. Prerequisites

- **Node.js ≥ 24** (native TS type-stripping; anything under 24 will not run).
- **pnpm ≥ 10** (the repo is pinned via `packageManager`).
- Optional: **Docker** for local Postgres persistence (the agent runs fine on
  in-memory persistence with zero infrastructure).

## 2. Install

```sh
pnpm install
```

## 3. Configure

Copy the example env file and edit it:

```sh
cp .env.example .env
```

`.env` **wins over ambient shell variables** (the loader uses
`dotenv` with `override: true`). This is deliberate: a stray `DATABASE_URL`
exported by your shell for another project must never silently capture this
agent.

| Variable | Default | Values | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | `development` / `test` / `production` | |
| `HOST` | `127.0.0.1` | | Bind address for the HTTP API |
| `PORT` | `3000` | | HTTP API port |
| `LOG_LEVEL` | `info` | pino levels | `silent` is supported and used in tests |
| `API_AUTH_TOKEN` | `local-dev-token` | | Required as `Authorization: Bearer <token>` on every route except `GET /health` |
| `PERSISTENCE` | `memory` | `memory` / `auto` / `postgres` | `auto` → Postgres only if `DATABASE_URL` is set |
| `DATABASE_URL` | — | | Postgres URL; Supabase URLs (`sslmode=require`) work with TLS enabled |
| `ANTHROPIC_API_KEY` | — | | Set to use the real Claude gateway (`claude-opus-5` adaptive-thinking, streaming) |
| `ANTHROPIC_MODEL` | `claude-opus-5` | | |
| `EMAIL_INGESTION` | `off` | `off` / `mock` | Opt-in; `mock` feeds scripted customer + supplier emails through the real event→task pipeline |
| `EMAIL_POLL_INTERVAL_MS` | `60000` | integer ≥ 1000 | |
| `N8N_CALLBACK` | `off` | `off` / `mock` / `http` | `mock` records callbacks without network; `http` POSTs to the webhook URL |
| `N8N_WEBHOOK_URL` | — | | **Required** when `N8N_CALLBACK=http`; startup fails otherwise |
| `SLACK_NOTIFY` | `off` | `off` / `mock` / `http` | Outbound Slack; `mock` records sends in memory, `http` POSTs to the webhook URL |
| `SLACK_WEBHOOK_URL` | — | | **Required** when `SLACK_NOTIFY=http`; startup fails otherwise |
| `SLACK_CHANNEL` | `#ops` | `≤ 120` chars | Default channel for the `slack_postMessage` tool when a reply has no explicit channel |
| `SLACK_INGESTION` | `off` | `off` / `mock` | Inbound Slack; `mock` feeds a customer message (#1001) through the real event→task pipeline |
| `SLACK_POLL_INTERVAL_MS` | `60000` | integer ≥ 1000 | |
| `REST_MODE` | `off` | `off` / `mock` / `http` | Generic outbound REST; `mock` answers from a route table, `http` fetches the base origin |
| `REST_BASE_URL` | — | | **Required** when `REST_MODE=http`; startup fails otherwise. The agent can only ever reach this one origin |

### LLM gateways

- **No `ANTHROPIC_API_KEY`** (default): the deterministic scripted gateway runs
  ("SOP as code"). Zero credentials, zero network, fully hermetic — every
  acceptance test runs this way. Every fact it emits comes from tool results
  already in the transcript.
- **With `ANTHROPIC_API_KEY`**: the real Claude gateway (`claude-opus-5`,
  adaptive thinking, streaming, `max_tokens: 16000`). The agent loop, tools,
  permissions, and audit trail are identical either way.

> Dump/verify the parsed config with: `node --env-file-if-exists=.env -e "import('src/config/env.ts').then(m=>{const e=m.parseEnv();console.log(e)})"` — note: `N8N_CALLBACK=http` without `N8N_WEBHOOK_URL` throws a clear error at startup rather than failing silently.

## 4. Persistence

The default is `PERSISTENCE=memory` — **nothing is ever written anywhere
implicitly.**

For durable state plus the "tasks survive agent restarts" guarantee:

```sh
docker compose up -d        # local Postgres 17 (agent/agent/agent on :5432)
```

Then set in `.env`:

```
PERSISTENCE=postgres
DATABASE_URL=postgres://agent:agent@localhost:5432/agent
```

Migrations run automatically at boot (`src/db/migrations/*.sql`, forward-only,
tracked in `schema_migrations`). You can also run them explicitly:

```sh
pnpm db:migrate
```

Supabase works the same way — point `DATABASE_URL` at it and TLS is enabled
automatically when the URL carries `sslmode=require`.

## 5. Run the agent + API

```sh
pnpm dev          # watch mode (restarts on change)
pnpm start        # production-ish run
```

On boot the log shows the resolved configuration, e.g.:

```json
{"persistence":"memory","port":3000,"tools":14,"pendingTasks":0,"llm":"scripted","emailIngestion":"off","slackNotify":"off","slackIngestion":"off","n8nCallback":"off","rest":"off","msg":"Shopify Operations Agent booted"}
```

The worker claims pending tasks, drives the agent loop (investigate → act →
verdict), persists the structured result, and fires the n8n callback — all on a
single process. `SIGINT`/`SIGTERM` shut it down cleanly.

## 6. HTTP API reference

All routes require `Authorization: Bearer <API_AUTH_TOKEN>` except `GET /health`.

| Method & path | Purpose |
| --- | --- |
| `GET /health` | Liveness; unauthenticated |
| `POST /agent/run` | Enqueue a generic investigation (`manual_investigation`) |
| `POST /agent/customer-email` | A customer message became a task (`customer_email_received`) |
| `POST /agent/investigate-order` | Manual order investigation (`manual_investigation`) |
| `POST /agent/detect-issues` | Proactive ops sweep (`scheduled_operations_check`) |
| `POST /agent/slack-message` | A Slack message became a task (`slack_message_received`) |
| `GET /agent/tasks/:id` | Task record incl. structured result |
| `GET /agent/issues?status=` | Issues (`open` / `resolved` / `escalated`) |
| `GET /agent/approvals?status=` | Pending approvals; `pending` shows the human queue |
| `GET /agent/actions?taskId=` | Audited action log rows |
| `POST /agent/approvals/:id/decide` | `{"decision":"approved"\|"rejected","actor":"…","reason":"…"}` |

Enqueue body: `{"text": "…", "orderId": "…", "customerEmail": "…", "eventType": "…", "priority": "low"|"medium"|"high"}`.

Example:

```sh
curl -X POST http://127.0.0.1:3000/agent/investigate-order \
  -H "authorization: Bearer local-dev-token" \
  -H "content-type: application/json" \
  -d '{"text":"Where is order #1001?","orderId":"ord_1001"}'
# {"taskId":"…","status":"pending","eventType":"manual_investigation"}
```

The structured result is:

```ts
{ status, summary, intent?, priority, confidence, findings, actions,
  recommendedActions, requiresHumanApproval, escalationReason? }
```

`confidence` is **informational only** — it is never consulted by the
permission system.

### Permission model (deterministic, never LLM-judged)

Each `ActionKind` maps to a mode in `DEFAULT_MODES` (`src/domain/permissions.ts`):

- **`auto`** — reads, order notes, issue filing, supplier delay recording,
  routine customer updates, internal notifications, n8n workflow triggers,
  posting an operational ack back to Slack, `rest_get` (read-only queries
  against the configured internal service).
- **`approval`** — refunds, replacements, discounts, order modifications,
  supplier disputes, policy exceptions, outbound customer emails, `rest_write`
  (any POST/PUT/PATCH/DELETE against the configured service): recorded as
  pending approvals; **executed only after a human approves**.
- **`blocked`** — credential access and destructive actions: refused and
  audited, always.

Authorizations never come from an LLM confidence score. The agent may never
invent tracking numbers, delivery dates, refunds, discounts, supplier
statements, or order facts — a real model could; the scripted one cannot.

## 7. Email ingestion

Opt-in (`EMAIL_INGESTION=mock` — the only backend today is the mock provider;
a real mailbox integration is a future step). On each poll, inbox emails are
turned into **events + tasks** through `ingestInbound`, which dedupes by email
id (re-polling the same inbox is idempotent):

- Customer emails → `customer-email` tasks (handled by the order SOP).
- Supplier emails → `supplier-email` tasks: the supplier directory is consulted
  (`Atlas Textiles` is marked delayed, `Brightwave Knits` on track), a delay is
  recorded as a `supplier_delay_detected` audited event, an issue is filed, and
  a `supplier_dispute` approval is raised for a human. On-track suppliers
  resolve with no issue and no escalation.

The same routes accept customer emails over HTTP (`/agent/customer-email`).

## 8. n8n callback

Two pieces, both opt-in:

1. **Post-completion webhook** (`N8N_CALLBACK=off|mock|http`). After each task
   succeeds, the runner POSTs a **truth-derived** `task_completed` payload to an
   n8n **Webhook** trigger — built strictly from the persisted task + recorded
   result, never from model narration:

   ```json
   { "event": "task_completed", "taskId": "…", "taskType": "…",
     "status": "resolved|needs_approval|needs_info|error", "summary": "…",
     "priority": "…", "requiresHumanApproval": true,
     "escalationReason": "…", "actions": ["…"], "findings": ["…"],
     "pendingApprovals": ["…"], "completedAt": "…" }
   ```

   `N8N_CALLBACK=mock` records payloads in memory (no network — hermetic
   dev/tests). `N8N_CALLBACK=http` POSTs to `N8N_WEBHOOK_URL` with a 5s timeout.
   A failed or slow webhook **never fails the task** — it is logged and the run
   moves on. Set the URL from an n8n **Webhook** node:

   ```
   N8N_CALLBACK=http
   N8N_WEBHOOK_URL=https://…/webhook/<your-webhook-id>
   ```

2. **`n8n_triggerWorkflow` tool** (auto tier). The agent can fire an n8n
   workflow mid-run with an honest `workflow_trigger` event — it signals the
   trigger and its inputs, and never fabricates a `task_completed` payload.

The webhook client, like Shopify and the email provider, sits behind an
interface (`mock` / `http`), so a real n8n instance is swappable with a mock.

## 9. Slack integration

Two directions, both opt-in:

1. **Inbound** (`SLACK_INGESTION=mock` — one mock message today). On each poll,
   new Slack messages become **events + tasks** through `ingestSlack`, which
   dedupes by message id (re-polling is idempotent). A customer message in
   `#support` turns into a `slack-message` task and the order SOP runs against
   it.
2. **Outbound** (`SLACK_NOTIFY=off|mock|http`). The agent gets a
   `slack_postMessage` tool (auto tier): `{channel?, text}` defaulting to
   `SLACK_CHANNEL`. The `http` backend POSTs `{channel, text}` to the webhook
   URL with a 5s timeout; failures are returned to the loop, never thrown.

**The reply rule is conservative by construction.** A `slack-message` task may
auto-post to the channel **only** when the SOP reaches a routine, fully
resolved verdict *(order located, on schedule/fulfilled — no issue, no pending
approval)*. Any sensitive outcome — refund/replacement, delivered-but-not-
received, supplier dispute, order unlocatable — stays behind the human gate:
the verdict is `needs_approval` / `needs_info` and **nothing is posted**. The
posted text is the honest verdict summary derived from tool results; it never
invents tracking numbers, dates, or carrier statements. When `SLACK_NOTIFY` is
`off`, the tool — and any proposal to use it — does not exist.

```
SLACK_NOTIFY=http
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/…  # Slack Incoming Webhook
SLACK_INGESTION=mock                                   # or off
```

The notifier/provider pair, like the email provider and n8n client, sits
behind interfaces (`mock` / `http`), so a real Slack app/webhook is swappable
without touching the agent core.

## 10. Generic REST integration

Opt-in outbound REST (`REST_MODE=off|mock|http`) against **one** operator-
configured base origin. Two tools, one deterministic rule (reads auto, writes
approval — the same split the rest of the policy uses):

- **`rest_get`** (auto tier): `{path, headers?}` → `GET`. A read-only query
  that lists or confirms state is exactly the investigation the agent already
  does, so it needs no human gate.
- **`rest_write`** (approval tier): `{method: POST|PUT|PATCH|DELETE, path,
  headers?, body?}`. Any write is a significant action: recorded as a pending
  approval and executed **only after a human approves this exact write**.

The client holds the base origin, so the agent can only ever reach the service
the deployment authorized. A crafted path that escapes the origin (absolute
URL like `https://attacker.example/x`, or protocol-relative `//host/x`) is
refused before any network I/O and audited. A call is `ok` only on a 2xx; a
404, 5xx, or transport failure is reported honestly — never wrapped as a
success. `REST_MODE=mock` answers from a route table (hermetic dev/tests);
`REST_MODE=http` fetches the base URL with a 5s timeout.

```
REST_MODE=http
REST_BASE_URL=https://ops.internal.example.com
```

The client, like the Shopify/email/n8n/Slack backends, sits behind an
interface (`mock` / `http`), so a real internal API is swappable without
touching the agent core. Deliberately lean: one origin, two tools, **no** SOP
changes — REST stays a capability the agent can call, not a new behavior to
learn.

## 11. Tests

```sh
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest run (106 tests, all hermetic, no network/PG)
pnpm test:watch
```

Every acceptance scenario runs on the scripted gateway, so the full suite
passes with zero credentials and no database:

| Scenario | Covered by |
| --- | --- |
| Where-is-my-order (#1001) — resolves, never invents tracking/dates | ✅ |
| Delayed shipment / no tracking updates (#1002) — dormant tracking flagged, issue filed | ✅ |
| Refund request — approval-tier, held, never executed | ✅ |
| Delivered-but-not-received (#1003) — human handling, hold proposed | ✅ |
| Supplier delay email — recorded, issue filed, dispute approval pending | ✅ |
| Proactive issue detection (#1004) — critical issue filed, no approval needed | ✅ |
| Requires human approval — reached `needs_approval`, pending approval listed | ✅ |
| Refuses unauthorized action — blocked tier refused & audited | ✅ |
| Never invents info — cancelled/healthy/solidly-in-transit controls | ✅ |
| Survives restart — running tasks reclaimed on boot | ✅ |
| n8n callback — payload shape, real HTTP delivery, failure isolation | ✅ |
| Slack ack — #1001 auto-posted to the channel, honest, no invented info | ✅ |
| Slack sensitive case — delivered-not-received never auto-posts | ✅ |
| Slack off — tool absent, nothing proposed | ✅ |
| REST read — `rest_get` auto, honest resource on 2xx / honest failure on 5xx | ✅ |
| REST write — `rest_write` approval-tier, refused without a recorded human approval | ✅ |
| REST origin guard — a path escaping the base origin is refused, never fetched | ✅ |

## 12. Architecture at a glance

```
HTTP API (Fastify) ──┬──> Repository (InMemory | Postgres)
  enqueue routes     │
  approvals          └──> AgentTaskRunner ──> runAgentTask (agent/core)
                                         │       │
                                         │       ├── ToolRegistry (Shopify, Supplier,
                                         │       │    Internal, Business, n8n, Slack,
                                         │       │    REST)
                                         │       └── PermissionResolver (auto/approval/blocked)
                                         │
                                         └──> LlmGateway (Scripted | Anthropic)
                                                    ↑ tool results feed the loop
                                                    ↓ structured verdict merged with ground truth

Email poller ──> ingestInbound ──> events + tasks ─┐
Slack poller ──> ingestSlack   ──> events + tasks ─┴──> onTaskComplete ──> n8n webhook (mock|http)
                                                    │        └──> Slack ack (mock|http) — routine only
```

Key invariants guard the "production shape":

- **Domain tools are interfaces** — `MockShopifyClient`/`MockSupplierDirectory`/
  `MockEmailProvider`/`MockN8nWebhookClient`/`MockSlackProvider`+
  `MockSlackNotifier`/`MockRestClient`/`HttpRestClient`/`RestToolProvider`
  stand in for real integrations; swapping in real ones never touches the
  agent core.
- **Everything is audited** — events, tool calls, approvals, and decisions all
  persist regardless of backend.
- **Persistence is a switch, not a fork** — the same `Repository` interface
  backs memory and Postgres; the in-memory tests and the real deployment run
  identical agent logic.
- **Never-invent is structural** — the scripted gateway only quotes facts from
  tool results; the n8n payload comes from persisted records, not the model.

## 13. Integration roadmap (current order)

1. **Email ingestion** ✅ (`customer` + `supplier` via mock provider)
2. **n8n callback** ✅ (post-completion webhook + workflow trigger tool)
3. **Slack** ✅ (inbound messages → tasks; conservative auto-ack via `slack_postMessage`)
4. **Generic REST** ✅ (`rest_get` auto, `rest_write` approval; `mock`/`http` against one base origin)