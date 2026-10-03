# Small Business Order Manager

AI-powered order management for small businesses. Paste a customer message like
_"I need 3 pink sticker sheets by Friday. Can I get a discount?"_ and a team of **Gemini**-powered agents
extracts the order, checks pricing, inventory, and production capacity, then drafts a reply. A human approves
before anything is confirmed.

See [PLAN.md](PLAN.md) for the architecture, agents, data model, and roadmap.

> **Status: complete and demo-ready.** Six Gemini agents with conditional routing, validated business tools,
> human approval, an audit log, and a web dashboard, on PostgreSQL. 211 automated tests; see
> [Testing](#testing) and [Security](#security).

## Tech stack

- **Backend:** Node.js 22.13+, Express 5, TypeScript, PostgreSQL (`pg`), zod
- **AI:** Google Gemini via [`@google/genai`](https://www.npmjs.com/package/@google/genai)
- **Frontend:** React 18, Vite, React Router 7
- **Monorepo:** npm workspaces: `shared/` (types), `server/`, `web/`

## Prerequisites

- **Node.js 22.13 or newer** (`node -v`). It's needed for built-in `.env` loading.
- **Nothing else.** PostgreSQL runs from npm (`embedded-postgres`), so you don't need to install Postgres or Docker.
- A **Gemini API key** from <https://aistudio.google.com/app/apikey> (the app still starts without one, but AI features are disabled).

## Setup

```bash
# 1. Install dependencies (all workspaces)
npm install

# 2. Create your local env file
cp .env.example .env          # macOS/Linux/Git Bash
copy .env.example .env        # Windows cmd / PowerShell

# 3. Edit .env and set GEMINI_API_KEY=...

# 4. Start the database, API, and web app together
npm run dev
```

- Web app: <http://localhost:5173>
- API: <http://localhost:3001/api/health>

On the first run, `npm run dev` creates a local PostgreSQL cluster in `server/data/postgres/`
(about 15 seconds), the server applies migrations, and the demo data is loaded automatically.
Stopping `npm run dev` (Ctrl+C) also stops the database; your data is kept for next time.

### Using a different PostgreSQL

Set `DATABASE_URL` in `.env` to any Postgres 14+ database (local install, Docker, Neon, Supabase, ...),
then run `npm run dev:app` (starts only the API and web app) and `npm run db:reset` once to load the demo data.

To check that Gemini is working, open the **Dashboard** and click **Test Gemini connection**, or run:

```bash
curl -X POST http://localhost:3001/api/ai/ping -H "Content-Type: application/json" -d "{}"
```

To see Gemini turn a customer message into structured order information:

```bash
curl -X POST http://localhost:3001/api/ai/extract -H "Content-Type: application/json" -d "{\"message\": \"I need 3 pink sticker sheets by Friday. Can I get a discount?\"}"
```

## Scripts (run from the repo root)

| Command              | What it does                                                                     |
| -------------------- | -------------------------------------------------------------------------------- |
| `npm run dev`        | Builds `shared`, then runs Postgres, the API (`tsx watch`), and web (Vite)       |
| `npm run dev:app`    | Same, without the embedded Postgres (for an external `DATABASE_URL`)             |
| `npm run typecheck`  | Type-checks every workspace                                                      |
| `npm test`           | Unit + integration tests (integration needs Postgres running; skipped otherwise) |
| `npm run test:unit`  | Unit tests only (no database, no Gemini)                                         |
| `npm run build`      | Production build (`server/dist`, `web/dist`)                                     |
| `npm start`          | Runs the built API server                                                        |
| `npm run db:start`   | Runs only the embedded PostgreSQL (keep it open; Ctrl+C stops it)                |
| `npm run db:migrate` | Applies pending migrations from `server/migrations/`                             |
| `npm run db:seed`    | Replaces all business data with the demo data set                                |
| `npm run db:reset`   | Drops all tables, re-runs migrations, and seeds the demo data                    |
| `npm run db:status`  | Checks connectivity; shows the Postgres version, migrations, and row counts      |
| `npm run db:check`   | Verifies business invariants: stock, capacity, and human-only decisions          |
| `npm run format`     | Formats the code with Prettier                                                   |

After editing `shared/src/index.ts`, run `npm run build:shared` (or restart `npm run dev`).

## Environment variables

All configuration comes from environment variables, validated at startup in
[server/src/config/env.ts](server/src/config/env.ts). The server reads the repo-level `.env`,
and real environment variables take precedence over it.

| Variable                 | Default                                                     | Notes                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GEMINI_API_KEY`         | none                                                        | **Secret.** Required for AI features. Never commit it.                                                                                                   |
| `GEMINI_MODEL`           | `gemini-3.6-flash`                                          | Any Gemini model that supports structured output and function calling                                                                                    |
| `GEMINI_TIMEOUT_MS`      | `30000`                                                     | Per-request timeout                                                                                                                                      |
| `GEMINI_MAX_ATTEMPTS`    | `3`                                                         | Total tries per Gemini call (retries rate limits, overload, timeouts)                                                                                    |
| `GEMINI_FALLBACK_MODELS` | (see `.env.example`)                                        | Comma-separated models tried when the primary is rate-limited or overloaded                                                                              |
| `GEMINI_MIN_INTERVAL_MS` | `4000`                                                      | Minimum gap between calls to the same model                                                                                                              |
| `PORT`                   | `3001`                                                      | API port (the Vite proxy assumes 3001; set `VITE_API_PROXY` if you change it)                                                                            |
| `NODE_ENV`               | `development`                                               | `production` switches logs to JSON                                                                                                                       |
| `LOG_LEVEL`              | `info`                                                      | `debug` \| `info` \| `warn` \| `error`                                                                                                                   |
| `DATABASE_URL`           | `postgres://postgres:postgres@localhost:5433/order_manager` | Postgres connection string. The default matches the embedded database                                                                                    |
| `DATABASE_POOL_MAX`      | `10`                                                        | Maximum pooled connections                                                                                                                               |
| `EMBEDDED_PG_DIR`        | `./data/postgres`                                           | Embedded Postgres data folder, relative to `server/`                                                                                                     |
| `CORS_ORIGIN`            | `http://localhost:5173`                                     | Comma-separated list                                                                                                                                     |
| `API_TOKEN`              | none                                                        | Optional (16+ chars). When set, requests that change data need `Authorization: Bearer <token>`; the Vite dev proxy adds it, so the browser never sees it. Leave unset when deployed; `off` also means unset (for hosts that demand a value) |

## API

| Method | Path                        | Description                                                                                                                                                                                         |
| ------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`               | API, database, and Gemini configuration status                                                                                                                                                      |
| POST   | `/api/ai/ping`              | Minimal Gemini round-trip (`{ "prompt"?: string }`)                                                                                                                                                 |
| POST   | `/api/ai/extract`           | Dev: customer message → structured order info (`{ "message": string }`). Read-only                                                                                                                  |
| GET    | `/api/products`             | Product catalogue with inventory (on hand, reserved, available)                                                                                                                                     |
| GET    | `/api/products/:id`         | A single product                                                                                                                                                                                    |
| POST   | `/api/products/:id/restock` | Receive stock (human only): `{ quantity, note?, receivedBy? }`; logged in `stock_receipts`                                                                                                          |
| GET    | `/api/products/receipts`    | Recent restocks                                                                                                                                                                                     |
| GET    | `/api/customers`            | Customers (`/api/customers/:id` for one)                                                                                                                                                            |
| GET    | `/api/pricing-rules`        | Discount, surcharge, and cap rules                                                                                                                                                                  |
| GET    | `/api/capacity?from=&to=`   | Production minutes per day (defaults to the next 14 days)                                                                                                                                           |
| GET    | `/api/orders?status=`       | Order list, optionally filtered by status                                                                                                                                                           |
| GET    | `/api/orders/:id`           | Order with customer, items, status history, messages, agent trace                                                                                                                                   |
| POST   | `/api/messages`             | Customer message → agents. Returns `202 { orderId }` at once and runs in the background (poll the order); `?wait=true` waits and returns all steps. `{ message, channel?, customerId?, customer? }` |
| POST   | `/api/orders/:id/approve`   | APPROVE: Order Management Agent confirms (reserves stock, books production); decision recorded. `{ decidedBy?, note?, reply? }`                                                                     |
| POST   | `/api/orders/:id/reject`    | REJECT: nothing confirmed; decision recorded, reply optionally sent. `{ decidedBy?, note?, reply?, sendReply? }`                                                                                    |
| GET    | `/api/orders/:id/approval`  | The approval state for an order (latest request and its decision)                                                                                                                                   |
| GET    | `/api/approvals?status=`    | Approval queue (`pending`, default) or decided requests (`approved`, `rejected`, `superseded`)                                                                                                      |
| GET    | `/api/tools`                | Business tools agents can call, with `access: read \| write`                                                                                                                                        |
| POST   | `/api/orders/:id/reply`     | The customer answered our question or offer: resume the paused order with the whole conversation. `{ message }`                                                                                     |
| POST   | `/api/orders/:id/retry`     | Resume a workflow that stopped on an agent error (reuses successful steps)                                                                                                                          |
| POST   | `/api/orders/:id/status`    | Fulfilment by a person: `{ status: "in_production" \| "ready" \| "completed" \| "cancelled" }`                                                                                                      |

Errors always have this shape, and every response carries an `X-Request-Id` header that matches the server logs:

```json
{ "error": { "code": "AI_NOT_CONFIGURED", "message": "…", "requestId": "…" } }
```

## Project structure

```
shared/   Types and constants shared by server and web (order statuses, transitions, DTOs)
server/   Express API
  src/config/       env validation
  src/lib/          logger, AppError helpers
  src/middleware/   request logging, 404, error handler
  migrations/       numbered SQL migrations (applied in order, never edited once shared)
  src/db/           pg pool, migration runner, seed, embedded Postgres, db CLI
  src/repositories/ SQL access per entity
  src/ai/gemini.ts  the only module that talks to Gemini
  src/domain/       pure business logic: pricing, stock, scheduling, dates, product matching, status policy
  src/tools/        the nine tools agents can call, plus the registry (validation + Gemini declarations)
  src/agents/       the six Gemini agents (+ runtime: verification helpers)
  src/workflow/     the orchestrator: runs agents, stops, approval, logging
  src/routes/       HTTP endpoints
web/      React app (Dashboard, New Request, Approvals, Audit Log, Orders, Order/approval screen, Inventory)
```

## Database

Tables (see [server/migrations/001_initial_schema.sql](server/migrations/001_initial_schema.sql)):
`customers`, `products`, `inventory`, `pricing_rules`, `production_capacity`, `orders`, `order_items`,
`order_status_history`, `messages`, `agent_runs`.

- Money is integer cents; percentages are `NUMERIC(5,2)`; deadlines are `DATE`.
- Business rules live in the schema too: stock can't go negative or be over-reserved, capacity can't be
  overbooked, and statuses are limited to the known list. Allowed status _transitions_ are enforced in
  [server/src/repositories/orders.ts](server/src/repositories/orders.ts), and every change is written to `order_status_history`.
- To change the schema, add `server/migrations/002_<name>.sql`. The server applies pending migrations on startup.

Demo data ("Petal & Ink Studio"): 6 customers across standard/loyal/wholesale tiers, 9 products
(including low-stock pink sticker sheets with only **2 available**, an out-of-stock item with an in-stock substitute, and a made-to-order item),
8 pricing rules, 4 weeks of production capacity, and 5 sample orders in different statuses.

## Gemini integration

Gemini is the only LLM in the app, and only [server/src/ai/](server/src/ai/) talks to it.

- **`GeminiService`** ([gemini.ts](server/src/ai/gemini.ts)): `generateText`, `generateStructured` (zod schema →
  JSON Schema → validated result), and `runTools` (function-calling loop). Every call supports a system
  instruction, temperature, token limit, and thinking level.
- **`Conversation`** ([conversation.ts](server/src/ai/conversation.ts)): keeps history across turns, so follow-ups
  see earlier messages, tool calls, and answers.
- **Failure handling:** per-call timeout; retries with exponential backoff on overload (5xx), network errors,
  timeouts, and rate limits (waiting for Google's suggested `retryDelay` when it's short); blocked or cut-off
  answers are detected; malformed or off-schema JSON gets one automatic repair turn.
- The business tools are passed in (`toolsForGemini(names, ctx)`), so the AI module never depends on business code.

| Error code            | HTTP | Meaning                                                 |
| --------------------- | ---- | ------------------------------------------------------- |
| `AI_NOT_CONFIGURED`   | 503  | `GEMINI_API_KEY` missing                                |
| `AI_RATE_LIMITED`     | 429  | Quota or rate limit hit; `details.retryAfterSeconds`    |
| `AI_UNAVAILABLE`      | 503  | Gemini overloaded or unreachable (after retries)        |
| `AI_TIMEOUT`          | 504  | No response within `GEMINI_TIMEOUT_MS` (after retries)  |
| `AI_BLOCKED`          | 422  | Gemini declined (safety)                                |
| `AI_INVALID_RESPONSE` | 502  | Malformed/off-schema output even after a repair attempt |
| `AI_ERROR`            | 502  | Bad API key, unknown model, or rejected request         |

## Multi-agent workflow

Six Gemini agents in [server/src/agents/](server/src/agents/), each with one responsibility, its own system
instruction, a zod output schema, and only the tools it needs. The orchestrator
([server/src/workflow/orderWorkflow.ts](server/src/workflow/orderWorkflow.ts)) is plain code that runs them in order.

| Agent               | Tools                                                     | Stops the workflow when…             |
| ------------------- | --------------------------------------------------------- | ------------------------------------ |
| Order Understanding | none (backend validates against catalogue and calendar)   | info missing, or product unknown     |
| Pricing             | `calculateOrderPrice`                                     | –                                    |
| Inventory           | `checkInventory`                                          | stock is short and can't be produced |
| Production          | `calculateEstimatedCompletion`, `checkProductionCapacity` | the deadline is impossible           |
| Communication       | none (writes from verified facts only)                    | reply mentions unverified amounts    |
| Order Management    | `updateOrderStatus` (guarded: confirm this order only)    | runs only after a human approves     |

```
message → Understanding → Pricing → Inventory → Production → Communication → awaiting_approval
              └ stop ───────────────────┴ stop ──────┴ stop ──→ Communication → needs_info / needs_review
human approves → Order Management → confirmed
```

### Conditional routing

Agents choose the route from tool results; the backend accepts a choice only if the tool results support it
(otherwise it's replaced and logged as `corrected`). Every route and its evidence appears in the workflow view and audit log.

| Case                   | What happens                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. In stock, on time   | Straight to approval (Production is rule-based when nothing needs making)                                                                                                |
| 2. Insufficient stock  | Inventory Agent stops (`insufficient_stock`) and chooses an offer from real options: an in-stock substitute from the same category, or the part we can supply            |
| 3. Deadline impossible | `calculateEstimatedCompletion` returns real alternatives (earliest date, the quantity that fits the deadline, split delivery); the Production Agent picks one to propose |
| 4. Discount requested  | Pricing Agent evaluates the pricing rules; if none applies, it can offer the nearest volume tier ("add 1 for 5% off → $18.52") from `discountOpportunities`              |
| 5. Missing information | The order pauses (`needs_info`); the Understanding Agent may also judge something critical is missing (e.g. artwork) and ask                                             |
| 6. Unknown product     | Stops and asks the customer, suggesting close matches when there are any                                                                                                 |

**Pause and resume:** when the customer answers a question or an offer (`POST /api/orders/:id/reply`, or the
"Customer's reply" box on the order page), the agents re-read the whole conversation and continue: e.g. "the gold
ones are fine" turns an out-of-stock request into a priced order for the substitute.

**Agents can't bypass business validation.** Numbers always come from the backend tools: each agent's
claims are checked against the tool results (`matched`), replaced if wrong (`corrected`), or recomputed by
the backend if the agent skipped its tool or changed the items (`recomputed`). Agents can only call the
tools they're given, can never approve, and the reply is checked for invented prices.

**Logging:** every step is saved in `agent_runs` (run id, agent, decision, one-line summary, next step,
verification, tool calls, timing) and returned by `GET /api/orders/:id` for the dashboard.

> **Free tier:** each model has its own small daily quota. The app is built for that:
>
> - **Model fallback:** when `GEMINI_MODEL` runs out or stays overloaded, the next model in
>   `GEMINI_FALLBACK_MODELS` takes over; exhausted models rest until their quota resets
>   (see `GET /api/health` → `gemini.models`).
> - **Pacing:** calls to one model are spaced by `GEMINI_MIN_INTERVAL_MS` to avoid per-minute bursts.
> - **Fewer calls:** about 5–7 Gemini calls per order (Inventory reads a backend stock check in one call;
>   Production is rule-based when everything ships from stock), plus 2 for approval.
> - **Resume:** `POST /api/orders/:id/retry` re-runs a failed workflow, reusing the steps that succeeded.
> - Each teammate can use their own free API key; quotas reset daily.

## Web app

| Page                        | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dashboard**               | Total orders, pending approvals, confirmed, in production, low-stock products; approval queue, low stock, recent orders                                                                                                                                                                                                                                                                                                                             |
| **New Request**             | Paste a customer message → **Process Order** → the AI workflow fills in live: Customer Message → 5 agents → Human Approval, each Pending / Running / Completed / Failed / Waiting for approval                                                                                                                                                                                                                                                      |
| **Approvals**               | The approval queue (waiting / approved / rejected)                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Audit Log**               | For judges: every agent step in order with role, the business tools it executed (read-only vs. writes DB, called by Gemini or the backend, arguments and results), latency, model, verification, and the structured decision payload; a highlighted **human approval gate** before any stock, capacity, or confirmation write; the writes committed after approval; and the status history by system / agent / human. Updates live while agents run |
| **Order** (approval screen) | Recommendation and warnings, workflow, customer, request, price, inventory and deadline, editable reply, APPROVE / REJECT. After a decision, a dispatch modal simulates sending the reply and previews it as WhatsApp, SMS, Instagram DM, or email next to the order status (nothing is actually sent)                                                                                                                                              |
| **Orders**                  | Tabs: Pending, Confirmed, In production, Ready, Delivered, Cancelled; one-click next fulfilment step                                                                                                                                                                                                                                                                                                                                                |
| **Inventory**               | Products with available / on hand / reserved and a stock status                                                                                                                                                                                                                                                                                                                                                                                     |

## Human approval

The agents never confirm an order. When the analysis finishes, the workflow opens an **approval request**
(`approval_requests` table) with everything a person needs:

- customer, requested products and quantities, customization and other requests
- verified price (with applied rules), inventory result, production/deadline result
- the AI-drafted reply
- **warnings** (`info` / `warning` / `critical`): low stock, production needed, rush surcharge, customization,
  new or unknown customer, tight deadline, agents the backend had to correct, and the stop reason
- a **recommended action** (`approve`, `review`, `reject`, `request_info`) with the reason

| Action      | What happens                                                                                                                                                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **APPROVE** | Only from `awaiting_approval` or `needs_review`. The Order Management Agent confirms through the order tool, which re-checks stock and capacity, reserves stock, and books production. Then the decision is recorded and the reply (draft or edited) becomes the final response. If validation fails, nothing changes and the request stays open. |
| **REJECT**  | From `awaiting_approval`, `needs_review`, or `needs_info`. Nothing is confirmed or reserved. The decision and, with `sendReply`, the reply sent are recorded.                                                                                                                                                                                     |

**Audit trail:** each request records who decided, when, their note, the final reply, whether it was sent, and
whether the person edited the AI's draft. Decisions can't be made twice, and re-analysing an order supersedes its
old request. Together with `order_status_history` (every status change, by `system` / `agent` / `human`) and
`agent_runs` (every agent step), the whole path from message to decision can be reconstructed.

## Business tools

Gemini never touches the database. It can only _ask_ for a tool by name; the backend validates the
arguments (zod), checks permissions, runs the business logic, and returns a result or a structured error.
All tools run through `executeTool()` in [server/src/tools/registry.ts](server/src/tools/registry.ts),
which also generates the Gemini function declarations from the same zod schemas.

| Tool                           | Access | What it does                                                                                                             |
| ------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| `extractOrderInformation`      | read   | Gemini reads the message; code matches products, checks quantities, resolves dates                                       |
| `calculateOrderPrice`          | read   | Volume + tier discounts (capped), rush surcharge. Integer cents                                                          |
| `checkInventory`               | read   | Per line: units from stock vs. to produce, production minutes, reorder warnings                                          |
| `checkProductionCapacity`      | read   | Fits minutes into free daily capacity; schedule, completion day, deadline check                                          |
| `calculateEstimatedCompletion` | read   | Stock + production → ready date, meets deadline?, earliest possible date                                                 |
| `createOrder`                  | write  | Finds/creates the customer, prices server-side, stores items and the message                                             |
| `updateOrderStatus`            | write  | Enforces transitions and who may make them; confirm reserves stock and books production, cancel releases, complete ships |
| `getCustomerInformation`       | read   | By id/email/phone/name: tier, tier discount, order stats, recent orders                                                  |
| `restockProduct`               | write  | Receive stock for a product (supplier delivery or batch); **human only**, audited. Not given to any agent                |
| `getProductInformation`        | read   | By id/SKU/free text: price, stock, production time, volume discounts                                                     |

**Human approval is enforced in code:** agents may only set `processing`, `needs_info`, `needs_review`, or
`awaiting_approval`. Confirming, rejecting, cancelling, and fulfilment require `actor: 'human'`, which the
backend sets from who is calling, never from the model's arguments.

## Deploy (free: Render + Neon)

In production the API server also serves the built web app, so it's **one service and one URL**. Migrations run on
startup, and the demo data is loaded automatically into an empty database.

1. **Database (Neon, free):** create a project at <https://neon.tech>, click **Connect**, turn **off**
   "Connection pooling" (the migration lock needs a direct connection), and copy the string ending in
   `?sslmode=require`.
2. **Code on GitHub:** push this repo (`.env` and `server/data/` are git-ignored, so no secrets are uploaded).
3. **App (Render, free):** create the service **manually**, not with "Blueprint" (Blueprints often ask for a card):
   **New → Web Service** → connect GitHub → pick the repo, then set:

   | Setting       | Value                                   |
   | ------------- | --------------------------------------- |
   | Language      | Node                                    |
   | Branch        | your branch (`master` or `main`)        |
   | Build command | `npm ci --include=dev && npm run build` |
   | Start command | `npm start`                             |
   | Instance type | **Free**                                |
   | Health check  | `/api/health` (under Advanced)          |

   Environment variables: `DATABASE_URL` (Neon), `GEMINI_API_KEY`, `NODE_ENV=production`, `DATABASE_POOL_MAX=5`,
   and optionally `GEMINI_FALLBACK_MODELS`. The Node version comes from `.node-version`.

4. Open `https://<your-service>.onrender.com` and check `/api/health`.

Notes:

- Free services sleep after ~15 minutes idle; the first visit then takes about a minute. Open the site before judging.
- A public URL lets anyone trigger Gemini calls on your key: share it with judges only.
- [render.yaml](render.yaml) describes the same setup as a Blueprint, and the [Dockerfile](Dockerfile) runs the app on
  any Docker host (port 7860; set `PORT` to change it).
- To try production locally: `npm run build`, then `npm start` (with Postgres running) and open <http://localhost:3001>.

## Testing

```bash
npm test             # everything (starts nothing: run `npm run db:start` first for the database tests)
npm run test:unit    # no database, no Gemini
npm run typecheck && npm run build
npm run db:check     # business invariants on your dev database
```

Tests never call the real Gemini API: the key is blanked in [server/src/test/setup.ts](server/src/test/setup.ts)
and agents run against a scripted fake ([server/src/test/fakeGemini.ts](server/src/test/fakeGemini.ts)) that
behaves honestly by default and is overridden per test to misbehave. Database tests use a separate
`order_manager_test` database, re-seeded before each test.

| Area                | What is covered                                                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Business logic      | Pricing rules and caps, stock assessment, scheduling, alternatives (substitutes, deadline options, discount tiers), date parsing, product matching, status policy                             |
| Gemini service      | Retries, rate limits with server delay, timeouts, overload, blocked/empty/cut-off answers, malformed JSON repair, tool loops, model fallback, pacing, thought-signature handling, missing key |
| Agents and workflow | All six routing cases; agents that lie, skip tools, change quantities, invent prices, call tools they weren't given, or touch another order; pause → resume; retry after failure              |
| Human approval      | Approve/reject from each status, audit record, edited replies, business validation on approval, Order Management guard                                                                        |
| API                 | Invalid input (never a 500), oversized bodies, impossible dates, injection-shaped input, lifecycle rules, duplicates and idempotency keys, API token, security headers                        |
| Races               | Simultaneous approvals, two orders racing for the last stock, concurrent identical submissions, concurrent customer replies                                                                   |
| Consistency         | Reserved stock and booked capacity always match the orders; every confirm/reject/cancel/fulfilment was made by a human                                                                        |
| Configuration       | Invalid env vars stop startup with a clear message; a missing Gemini key does not                                                                                                             |

## Security

- **AI never touches the database or the system directly.** Agents can only _propose_ tool calls by name. Every
  call goes through `executeTool()`, which validates arguments with zod, enforces who may do what, and runs
  parameterised SQL. A test checks that AI and agent code never imports the database client, `pg`, shell, or
  filesystem modules, or any repository function that writes.
- **Least privilege per agent.** Each agent is shown only its own tools. Only the Order Management Agent has a
  write tool (`updateOrderStatus`), and it runs only after a person approves, through a guard that allows just
  "confirm this one order". Agents can never approve, reject, cancel, or fulfil (enforced in the tool, from the
  caller's identity, never from the model's arguments).
- **Facts come from tools, not the model.** Numbers, stock, and dates are taken from tool results; agent claims are
  checked and overruled when wrong; replies are checked for invented prices.
- **Untrusted text stays data.** Customer messages are passed as data with instructions to ignore embedded
  instructions; outputs are schema-validated.
- **SQL injection:** all queries are parameterised; dynamic SQL is limited to whitelisted fragments (checked by a test).
- **Duplicates and races:** `Idempotency-Key` support, duplicate-message detection under a database lock, row
  locks and conditional updates for stock and capacity, one decision per approval request, and a per-order guard
  against simultaneous human actions.
- **API hardening:** input validation on every endpoint, 100 kB body limit, consistent JSON errors without
  internal details in production, `nosniff` / `X-Frame-Options: DENY` / no `X-Powered-By`, CORS limited to the
  web app, optional `API_TOKEN` for changes, secrets never logged.
- **Not in scope for the hackathon:** user accounts and roles (`API_TOKEN` is a single shared key), rate limiting
  per client, and real message sending.

## Troubleshooting

- **`AI_NOT_CONFIGURED`**: `GEMINI_API_KEY` is missing. Add it to `.env` and restart.
- **`AI_ERROR: Gemini rejected the API key`**: the key is wrong or revoked.
- **`AI_ERROR: model … not available`**: change `GEMINI_MODEL` to a model your key can access (the error's `details.reason` often names one).
- **`AI_RATE_LIMITED`**: the free tier allows only a few requests per minute and has a daily quota per model. The app falls back to `GEMINI_FALLBACK_MODELS` automatically; if all are exhausted, wait for the reset or use another free API key.
- **`UNAUTHORIZED`**: `API_TOKEN` is set; restart `npm run dev` so the web proxy picks it up, or send `Authorization: Bearer <token>`.
- **`port 3001 is already in use`**: stop the other process or change `PORT`.
- **`Could not connect to PostgreSQL`**: the database isn't running. Use `npm run dev` (which starts it), or run `npm run db:start` in another terminal.
- **Embedded Postgres won't start (port 5433 busy)**: another Postgres is running there. Stop it, or change the port in `DATABASE_URL`.
- **Start the database from scratch**: stop `npm run dev`, delete `server/data/postgres/`, and start again.
- **`Cannot reach the server` in the UI**: the API isn't running. Start it with `npm run dev`.
