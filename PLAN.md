# Small Business Order Manager: Design and Status

Turn unstructured customer messages ("I need 3 pink sticker sheets by Friday. Can I get a discount?")
into priced, stock-checked, deadline-checked orders with an AI-drafted reply, gated by human approval.

**AI engine: Google Gemini API only** (via the official `@google/genai` SDK). No other LLM is used.

**Status: complete.** Everything below is implemented and covered by tests (211). The README has setup,
scripts, testing, and security details.

---

## 1. Architecture

```
 ┌──────────────────────── web (React + Vite) ─────────────────────────┐
 │ Dashboard · New Request (live workflow) · Approvals · Audit Log ·    │
 │ Order / approval screen (+ dispatch preview) · Orders · Inventory    │
 └───────────────────────────────┬─────────────────────────────────────┘
                                 │ REST /api (JSON)
 ┌───────────────────────────────▼─────────────────────────────────────┐
 │ server (Node.js + Express 5 + TypeScript)                            │
 │                                                                      │
 │  routes ─► workflow/orderWorkflow (orchestrator: plain code)         │
 │               │ runs agents in order, routes on validated decisions, │
 │               │ logs every step, stops at the human approval gate    │
 │      ┌────────┼─────────┬──────────┬────────────┬──────────────┐     │
 │  Understanding Pricing  Inventory  Production  Communication   │     │
 │      └────────┴─────────┴──── Gemini (ai/gemini.ts) ───────────┘     │
 │               │  structured output · function calling · fallback     │
 │               ▼                                                      │
 │        tools/registry: executeTool() — zod validation, permissions   │
 │               │                                                      │
 │        domain/ (pure business rules) ─ repositories/ ─► PostgreSQL   │
 │                                                                      │
 │  human APPROVE ─► Order Management Agent ─► updateOrderStatus (guarded)│
 └──────────────────────────────────────────────────────────────────────┘
```

Key decisions:

- **The orchestrator is code, not an LLM.** It runs the agents in order, passes verified outputs forward, routes on
  each agent's (validated) decision, records every step, and stops at the approval gate.
- **Agents decide; the backend validates.** Each agent has one job, its own system instruction, a zod output schema,
  and only the tools it needs. Agents choose routes and options from tool results; the backend accepts a choice only
  if the tool results support it, otherwise it substitutes a valid one and logs `corrected`.
- **Facts come from tools.** Prices, stock, capacity, and dates always come from backend tools, never the model.
- **Human in the loop.** Nothing is confirmed, reserved, booked, or sent until a person approves.

## 2. Technology choices

| Concern     | Choice                                                              | Why                                                   |
| ----------- | ------------------------------------------------------------------- | ----------------------------------------------------- |
| Language    | TypeScript everywhere                                               | Shared types between server and web                   |
| Repo layout | npm workspaces (`shared`, `server`, `web`)                          | No extra tooling                                      |
| Backend     | Node.js 22.13+ · Express 5                                          | Familiar, minimal; async errors handled natively      |
| AI          | `@google/genai`; primary model + free-tier fallback chain (env)     | Structured output, function calling, thinking control |
| Database    | PostgreSQL via `pg`; `embedded-postgres` for local dev              | Real constraints and row locks; no install or Docker  |
| Validation  | `zod` (+ `zod-to-json-schema` for Gemini schemas)                   | One schema for validation, tool declarations, outputs |
| Tests       | `node:test` via `tsx`; scripted fake Gemini; separate test database | No extra framework; no real Gemini calls in tests     |
| Frontend    | React 18 + Vite + React Router 7, plain CSS                         | Fast setup, proxy to the API                          |

Not included on purpose: user accounts, Docker, queues, ORMs, LangChain, vector databases.

## 3. Folder structure

```
small-business-order-manager/
├─ package.json  tsconfig.base.json  .env.example  README.md  PLAN.md
├─ shared/src/index.ts       statuses, transitions, agent info, DTOs
├─ server/
│  ├─ migrations/            001 schema · 002 allocations · 003 agent workflow · 004 approvals · 005 idempotency
│  └─ src/
│     ├─ config/ lib/ middleware/   env validation, logger, errors, auth, request ids, order lock
│     ├─ db/                  pg pool, migrations, seed, consistency checks, embedded Postgres, CLI
│     ├─ repositories/        parameterised SQL per entity
│     ├─ domain/              pure rules: pricing, inventory, production, alternatives, dates, matching, policy
│     ├─ tools/               9 business tools + registry (executeTool, Gemini declarations)
│     ├─ ai/                  Gemini service (retries, fallback, pacing, structured output, tool loop), Conversation
│     ├─ agents/              6 agents + runtime (verification helpers)
│     ├─ workflow/            orchestrator, approval packet builder
│     ├─ routes/              HTTP endpoints
│     └─ test/                setup, fake Gemini, fixtures, test database helper
└─ web/src/                   pages, components (WorkflowView, AuditLog, DispatchModal, MessagePreview), API client
```

## 4. Agents

| Agent               | Gemini usage                                | Tools                                                     | Routes / decisions                                                               |
| ------------------- | ------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Order Understanding | Structured output; catalogue in instruction | none (backend matches products and dates)                 | `continue`, `ask_clarification` (incl. its own judgement), `ask_about_product`   |
| Pricing             | Function calling + structured answer        | `calculateOrderPrice`                                     | discount decision; offer the nearest volume tier or not                          |
| Inventory           | Structured answer on a backend stock check  | `checkInventory` (run by the backend)                     | `continue` / `insufficient_stock`; offer substitute, partial, or none            |
| Production          | Function calling + structured answer        | `calculateEstimatedCompletion`, `checkProductionCapacity` | `continue` / `propose_alternative`: later date, reduced quantity, split delivery |
| Communication       | Structured output from verified facts       | none (backend checks every money amount)                  | `send_for_approval` / `draft_for_review` / `review_needed`                       |
| Order Management    | Function calling (after human approval)     | `updateOrderStatus`, guarded to confirm one order         | confirmed / not confirmed                                                        |

Production is rule-based (no Gemini call) when everything ships from stock.

## 5. Database entities

customers · products · inventory (on hand, reserved, generated available, reorder point) · pricing_rules ·
production_capacity · production_bookings · stock_receipts (who received how much, when) · orders (incl. stop reason, estimated completion, idempotency key) ·
order_items (incl. reserved quantity) · order_status_history (actor system/agent/human) · messages ·
agent_runs (run id, decision, route, summary, next step, model, verification, tool calls) ·
approval_requests (packet, recommendation, decision, who/when/note, final reply, edited flag).

Constraints enforce the rules too: stock can't go negative or be over-reserved, capacity can't be overbooked,
one pending approval per order, decisions recorded with who and when. `npm run db:check` verifies the
cross-table invariants.

## 6. API endpoints

| Method | Path                        | Purpose                                                                              |
| ------ | --------------------------- | ------------------------------------------------------------------------------------ |
| GET    | `/api/health`               | API, database, Gemini models and their availability                                  |
| POST   | `/api/ai/ping`              | Minimal Gemini round-trip                                                            |
| POST   | `/api/ai/extract`           | Customer message → structured order information (read-only)                          |
| GET    | `/api/products`, `/:id`     | Catalogue with inventory (incl. suggested reorder quantity)                          |
| POST   | `/api/products/:id/restock` | Receive stock (human only, audited)                                                  |
| GET    | `/api/products/receipts`    | Recent restocks                                                                      |
| GET    | `/api/customers`, `/:id`    | Customers                                                                            |
| GET    | `/api/pricing-rules`        | Pricing rules                                                                        |
| GET    | `/api/capacity`             | Production capacity per day                                                          |
| GET    | `/api/tools`                | Business tools and whether each writes to the database                               |
| POST   | `/api/messages`             | Start the agent workflow (202, background; `?wait=true` to block; `Idempotency-Key`) |
| GET    | `/api/orders`, `/:id`       | Orders; detail with items, history, messages, agent runs, approval                   |
| GET    | `/api/orders/:id/approval`  | The approval state                                                                   |
| POST   | `/api/orders/:id/approve`   | Human approval → Order Management Agent confirms                                     |
| POST   | `/api/orders/:id/reject`    | Human rejection, optionally sending the reply                                        |
| POST   | `/api/orders/:id/reply`     | Customer answered: resume a paused order                                             |
| POST   | `/api/orders/:id/retry`     | Resume after an agent failure, reusing successful steps                              |
| POST   | `/api/orders/:id/status`    | Fulfilment: in production → ready → delivered (or cancel)                            |
| GET    | `/api/approvals`            | Approval queue / decided requests                                                    |

Errors always come back as `{ error: { code, message, details?, requestId } }` with a matching HTTP status.

## 7. Gemini integration

One service, `server/src/ai/gemini.ts`: system instructions, structured output (zod → JSON Schema → validated, one
repair turn), a function-calling loop (tools injected, only offered tools run), conversation context, per-call
timeout, retries with backoff and server-suggested delays, blocked/empty/cut-off detection, model fallback with
cooldowns for exhausted models, per-model pacing, and thought-signature handling when the model changes. The key
comes only from `GEMINI_API_KEY`; without it, AI steps fail cleanly with `AI_NOT_CONFIGURED`.

## 8. Tools and function calling

Each tool has a zod input schema (also its Gemini declaration), an access level (read/write), and a handler that
uses the repositories. `executeTool()` validates, enforces permissions (`actor` comes from the backend), and
returns `{ ok, result }` or `{ ok: false, error }`, never throwing to the model. Tools: `extractOrderInformation`,
`calculateOrderPrice`, `checkInventory`, `checkProductionCapacity`, `calculateEstimatedCompletion`, `createOrder`,
`updateOrderStatus`, `getCustomerInformation`, `getProductInformation`, `restockProduct` (human only:
receives stock and writes an audit record; no agent has it).

## 9. Workflow and states

```
received → processing ─┬─► awaiting_approval ── APPROVE ─► confirmed → in_production → ready → completed (Delivered)
                       ├─► needs_info  (missing info / unknown product)          ── REJECT ─► rejected
                       └─► needs_review (insufficient stock / deadline / agent error / unverified reply)
needs_info, needs_review ── customer reply ─► processing (resume with the whole conversation)
needs_review (agent error) ── retry ─► processing (successful steps reused)
any open state ─► cancelled (human; releases stock and capacity)
```

Allowed transitions live in `shared/src/index.ts`; who may make them lives in `server/src/domain/orderPolicy.ts`
(agents: analysis states only; everything that commits or ends an order: humans only).

## 10. Frontend pages

Dashboard (KPIs, approval queue, low stock, recent orders) · New Request (message box, six example cases, live
workflow view) · Approvals (queue) · Audit Log (every step: tools, latency, structured output, routing, the
approval gate, committed writes, status history) · Order / approval screen (recommendation, warnings, offers,
editable reply, APPROVE / REJECT, customer reply to resume, dispatch simulation with WhatsApp / SMS / Instagram /
email previews) · Orders (status tabs, next fulfilment step) · Inventory (Restock with suggested quantity,
recent restocks; the Dashboard's low-stock list has Reorder shortcuts).

## 11. Demo flow (about 4 minutes)

1. Dashboard: KPIs, low stock (pink sticker sheets: 2 left).
2. New Request → "Demo order": watch the five agents run live; the order waits at the approval gate.
3. Approval screen: price, stock, timing, warnings, draft reply → APPROVE → dispatch preview (switch to WhatsApp / Email).
4. Audit Log: tools executed, latency, structured outputs, routing decisions, the approval gate, the writes committed after it.
5. Conditional routing: "2 · Out of stock" offers a substitute; paste "the gold ones are fine" as the customer's reply → the order resumes and is re-priced.
6. Orders: Start production → Mark ready → Mark delivered; Inventory shows the stock change.
7. Restock: Dashboard → Reorder on a low-stock item → Receive → the low-stock count drops; re-sending the
   out-of-stock message now goes straight to approval.

## 12. Build history

Foundation → PostgreSQL data layer → business tools → Gemini service → multi-agent workflow → free-tier
resilience (fallback, pacing, fewer calls, resume) → human approval → dispatch simulation → dashboard → audit log →
conditional routing → restocking → testing and security pass (idempotency, race handling, consistency checks, API hardening,
security invariant tests, dependency audit clean).
