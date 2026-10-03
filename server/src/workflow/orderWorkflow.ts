/**
 * The orchestrator: plain code (not an LLM) that runs the agents in order, passes each one the
 * verified output of the previous ones, saves results, and stops when it must.
 *
 *   message ─► Understanding ─► Pricing ─► Inventory ─► Production ─► Communication ─► awaiting_approval
 *                   │ stop: missing_info / unknown_product          │            │
 *                   │                    stop: insufficient_inventory  stop: deadline_impossible
 *                   └──────────────► Communication (drafts the clarifying / alternative reply)
 *
 * Every step is logged to agent_runs (agent, decision, summary, next step, verification, tool
 * calls), so the dashboard can show the whole trace. Nothing is confirmed here: approval is a
 * separate, human-triggered action (approveOrder), carried out by the Order Management Agent.
 */
import { randomUUID } from 'node:crypto';
import type {
  AgentName,
  Channel,
  CustomerDto,
  OrderStatus,
  StopReason,
  Verification,
  WorkflowResultDto,
  WorkflowStepDto,
} from '@sbom/shared';
import { gemini, type GeminiService } from '../ai/gemini.js';
import { queryOne, transaction } from '../db/client.js';
import { todayIso, weekdayName } from '../domain/dates.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { withOrderLock } from '../lib/orderLock.js';
import * as communication from '../agents/communication.js';
import * as inventoryAgent from '../agents/inventory.js';
import * as orderManagement from '../agents/orderManagement.js';
import * as pricing from '../agents/pricing.js';
import * as production from '../agents/production.js';
import type { AgentContext, AgentOutcome } from '../agents/types.js';
import * as understanding from '../agents/understanding.js';
import { listLatestRunSteps, recordAgentRun } from '../repositories/agentRuns.js';
import {
  createApprovalRequest,
  getPendingApproval,
  recordDecision,
} from '../repositories/approvals.js';
import {
  createCustomer,
  findCustomerByEmail,
  findCustomerByPhone,
  getCustomer,
} from '../repositories/customers.js';
import { createMessage } from '../repositories/messages.js';
import {
  createOrder,
  getOrderDetail,
  setOrderItems,
  updateOrder,
  updateOrderStatus,
} from '../repositories/orders.js';
import { listProducts } from '../repositories/products.js';
import { checkTransition } from '../domain/orderPolicy.js';
import { buildApprovalPacket } from './approvalPacket.js';
import type { InventoryOutput } from '../agents/inventory.js';
import type { PricingOutput } from '../agents/pricing.js';
import type { ProductionOutput } from '../agents/production.js';

export interface WorkflowDeps {
  ai?: GeminiService;
  today?: string;
  /** Called as soon as the order exists, before any agent runs (lets the API answer early). */
  onOrderCreated?: (orderId: number, info?: { duplicate: boolean }) => void;
}

/** Same text from the same sender within this window is treated as a duplicate submission. */
const DUPLICATE_WINDOW_MINUTES = 10;

export interface IncomingMessage {
  message: string;
  /** Client-supplied key (Idempotency-Key header): retries with the same key return the same order. */
  idempotencyKey?: string;
  channel?: Channel;
  customerId?: number;
  customer?: { name?: string; email?: string; phone?: string };
}

/** Where each stop leaves the order. */
const STOP_STATUS: Record<StopReason, OrderStatus> = {
  missing_info: 'needs_info',
  unknown_product: 'needs_info',
  insufficient_inventory: 'needs_review',
  deadline_impossible: 'needs_review',
  unverified_reply: 'needs_review',
  agent_error: 'needs_review',
  human_approval_required: 'awaiting_approval',
};

const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const longDate = (day: string) =>
  `${weekdayName(day)}, ${new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`;

/** Runs one agent, logs it to agent_runs, and returns its outcome (or the error). */
class StepRunner {
  readonly steps: WorkflowStepDto[] = [];
  /** How each agent's claims were checked, for the approval request. */
  readonly checks: {
    agent: AgentName;
    verification: Verification;
    discrepancies: string[];
    route: string;
    routeReason: string;
  }[] = [];
  constructor(
    private readonly ctx: AgentContext,
    /** Successful outcomes from an earlier run of this order, reused instead of calling Gemini again. */
    private readonly reuse: Map<AgentName, AgentOutcome<unknown>> = new Map(),
    private readonly log = logger.child({
      component: 'workflow',
      orderId: ctx.orderId,
      runId: ctx.runId,
    }),
  ) {}

  async run<O>(
    agent: AgentName,
    input: unknown,
    fn: () => Promise<AgentOutcome<O>>,
    nextStep: (o: AgentOutcome<O>) => string,
  ): Promise<{ ok: true; outcome: AgentOutcome<O> } | { ok: false; error: AppError | Error }> {
    const start = Date.now();
    try {
      const saved = this.reuse.get(agent) as AgentOutcome<O> | undefined;
      const outcome: AgentOutcome<O> = saved
        ? { ...saved, summary: `(reused from previous run) ${saved.summary}` }
        : await fn();
      const durationMs = Date.now() - start;
      const next = nextStep(outcome);
      await recordAgentRun({
        orderId: this.ctx.orderId,
        runId: this.ctx.runId,
        agent,
        status: 'ok',
        input,
        output: {
          result: outcome.output,
          discrepancies: outcome.discrepancies,
          stopReason: outcome.stopReason ?? null,
          route: outcome.route,
          routeReason: outcome.routeReason,
          reused: Boolean(saved),
        },
        toolCalls: outcome.toolCalls,
        durationMs,
        decision: outcome.decision,
        summary: outcome.summary,
        nextStep: next,
        model: outcome.model ?? null,
        verification: outcome.verification,
      });
      this.checks.push({
        agent,
        verification: outcome.verification,
        discrepancies: outcome.discrepancies,
        route: outcome.route,
        routeReason: outcome.routeReason,
      });
      this.steps.push({
        agent,
        status: 'ok',
        decision: outcome.decision,
        route: outcome.route,
        routeReason: outcome.routeReason,
        summary: outcome.summary,
        nextStep: next,
        verification: outcome.verification,
        durationMs,
      });
      this.log.info('agent step', {
        agent,
        model: outcome.model ?? 'rule-based',
        reused: Boolean(saved),
        route: outcome.route,
        routeReason: outcome.routeReason,
        decision: outcome.decision,
        stopReason: outcome.stopReason,
        verification: outcome.verification,
        next,
        durationMs,
      });
      if (outcome.discrepancies.length) {
        this.log.warn('agent output corrected by backend', {
          agent,
          discrepancies: outcome.discrepancies,
        });
      }
      return { ok: true, outcome };
    } catch (err) {
      const durationMs = Date.now() - start;
      const error = err instanceof Error ? err : new Error(String(err));
      const summary = `Failed: ${error.message}`;
      await recordAgentRun({
        orderId: this.ctx.orderId,
        runId: this.ctx.runId,
        agent,
        status: 'error',
        input,
        error: error.message,
        durationMs,
        decision: 'stop',
        summary,
        nextStep: 'needs_review',
        model: this.ctx.ai.model,
        verification: 'not_applicable',
      });
      this.steps.push({
        agent,
        status: 'error',
        decision: 'stop',
        summary,
        nextStep: 'needs_review',
        verification: 'not_applicable',
        durationMs,
      });
      this.log.error('agent failed', { agent, error: error.message, code: (err as AppError).code });
      return { ok: false, error };
    }
  }
}

/** Find (or create) the customer from what we know. No AI involved. */
async function resolveCustomer(
  msg: IncomingMessage,
  extracted?: { name: string | null; email: string | null; phone: string | null },
): Promise<{ customer: CustomerDto | undefined; created: boolean }> {
  if (msg.customerId) {
    const c = await getCustomer(msg.customerId);
    if (!c) throw notFound(`Customer ${msg.customerId} not found`);
    return { customer: c, created: false };
  }
  const email = msg.customer?.email ?? extracted?.email ?? undefined;
  const phone = msg.customer?.phone ?? extracted?.phone ?? undefined;
  const found =
    (email ? await findCustomerByEmail(email) : undefined) ??
    (phone ? await findCustomerByPhone(phone) : undefined);
  if (found) return { customer: found, created: false };
  const name = msg.customer?.name ?? extracted?.name;
  if (!name) return { customer: undefined, created: false };
  const customer = await createCustomer({
    name,
    email: email ?? null,
    phone: phone ?? null,
    channel: msg.channel,
  });
  return { customer, created: true };
}

/**
 * Process a new customer message end to end, up to the human approval gate.
 */
export async function processCustomerMessage(
  msg: IncomingMessage,
  deps: WorkflowDeps = {},
): Promise<WorkflowResultDto> {
  const started = Date.now();
  const today = deps.today ?? todayIso();
  const ai = deps.ai ?? gemini();

  // 1. Record the order and the message before any AI runs, so nothing is lost if it fails.
  //    Duplicate submissions (retry, double click, same message pasted twice) return the existing
  //    order. An advisory lock serialises identical submissions so two can't both get through.
  const { customer: knownCustomer, created: customerIsNew } = await resolveCustomer(msg);
  const channel = msg.channel ?? knownCustomer?.channel ?? 'email';
  const body = msg.message.trim();
  const sender = knownCustomer ? `customer:${knownCustomer.id}` : `channel:${channel}`;
  const created = await transaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      msg.idempotencyKey ? `idem:${msg.idempotencyKey}` : `msg:${sender}:${body.toLowerCase()}`,
    ]);
    const existing = msg.idempotencyKey
      ? await queryOne<{ id: number }>(
          'SELECT id FROM orders WHERE idempotency_key = $1',
          [msg.idempotencyKey],
          db,
        )
      : await queryOne<{ id: number }>(
          `SELECT o.id FROM messages m JOIN orders o ON o.id = m.order_id
           WHERE m.direction = 'inbound'
             AND lower(btrim(m.body)) = lower($1)
             AND ${knownCustomer ? 'o.customer_id = $2' : 'o.customer_id IS NULL AND m.channel = $2'}
             AND m.created_at > now() - make_interval(mins => $3)
             AND o.status NOT IN ('cancelled', 'rejected')
           ORDER BY m.id LIMIT 1`,
          [body, knownCustomer ? knownCustomer.id : channel, DUPLICATE_WINDOW_MINUTES],
          db,
        );
    if (existing) return { orderId: existing.id, duplicate: true };

    const id = await createOrder(
      {
        customerId: knownCustomer?.id ?? null,
        actor: 'system',
        idempotencyKey: msg.idempotencyKey,
      },
      db,
    );
    await createMessage(
      { customerId: knownCustomer?.id ?? null, orderId: id, direction: 'inbound', channel, body },
      db,
    );
    return { orderId: id, duplicate: false };
  });
  const { orderId } = created;
  if (created.duplicate) {
    logger.info('duplicate message: returning the existing order', { orderId });
    deps.onOrderCreated?.(orderId, { duplicate: true });
    const existing = (await getOrderDetail(orderId))!;
    return {
      orderId,
      duplicate: true,
      runId: '',
      status: existing.status,
      stopReason: existing.stopReason,
      draftReply: existing.draftReply,
      approval: existing.approval,
      steps: [],
      durationMs: Date.now() - started,
    };
  }
  await updateOrderStatus(orderId, 'processing', 'system', 'Agent workflow started');
  deps.onOrderCreated?.(orderId, { duplicate: false });
  return runAgents({ orderId, msg, knownCustomer, customerIsNew, ai, today, started });
}

/** Runs the agent pipeline for an order already in 'processing'. */
async function runAgents(args: {
  orderId: number;
  msg: IncomingMessage;
  knownCustomer: CustomerDto | undefined;
  customerIsNew?: boolean;
  ai: GeminiService;
  today: string;
  started: number;
  reuse?: Map<AgentName, AgentOutcome<unknown>>;
}): Promise<WorkflowResultDto> {
  const { orderId, msg, knownCustomer, ai, today, started } = args;
  const runId = randomUUID();
  const ctx: AgentContext = { ai, today, orderId, runId };
  const steps = new StepRunner(ctx, args.reuse);
  let stopReason: StopReason | null = null;
  let customer = knownCustomer;
  let customerIsNew = args.customerIsNew ?? false;
  const channel = msg.channel ?? knownCustomer?.channel ?? 'email';
  // Verified results, collected for the approval request.
  let extraction: understanding.UnderstandingOutput | null = null;
  let pricingOut: PricingOutput | null = null;
  let inventoryOut: InventoryOutput | null = null;
  let productionOut: ProductionOutput | null = null;

  // Facts the Communication Agent may use. Only verified values are added.
  const facts: Record<string, unknown> = {
    today: longDate(today),
    channel,
  };

  /**
   * End of the analysis. Nothing is confirmed here: the order waits in its status, and (unless the
   * analysis failed) an approval request with everything a person needs is opened.
   */
  const finish = async (
    reason: StopReason,
    draftReply: string | null,
  ): Promise<WorkflowResultDto> => {
    const status = STOP_STATUS[reason];
    const approval = await transaction(async (db) => {
      await updateOrder(orderId, { stopReason: reason, draftReply }, db);
      await updateOrderStatus(
        orderId,
        status,
        reason === 'agent_error' ? 'system' : 'agent',
        reason === 'human_approval_required'
          ? 'Quote and reply ready for approval'
          : `Stopped: ${reason}`,
        db,
      );
      if (reason === 'agent_error') return null;
      const packet = buildApprovalPacket({
        orderId,
        runId,
        stopReason: reason,
        message: msg.message,
        channel,
        customer,
        customerIsNew,
        extraction,
        pricing: pricingOut,
        inventory: inventoryOut,
        production: productionOut,
        draftReply,
        steps: steps.checks,
      });
      return createApprovalRequest(packet, db);
    });
    return {
      orderId,
      runId,
      status,
      stopReason: reason,
      draftReply,
      approval,
      steps: steps.steps,
      durationMs: Date.now() - started,
    };
  };

  // 2. Order Understanding
  const u = await steps.run(
    'understanding',
    { message: msg.message },
    () => understanding.run(ctx, { message: msg.message }),
    (o) => (o.decision === 'stop' ? 'communication' : 'pricing'),
  );
  if (!u.ok) return finish('agent_error', null);
  const ex = u.outcome.output;
  extraction = ex;
  const items = ex.items.map((i) => ({ productId: i.productId, quantity: i.quantity }));

  if (!customer) {
    const r = await resolveCustomer(msg, ex.customer);
    customer = r.customer;
    customerIsNew = r.created;
  }
  const catalogue = await listProducts({ activeOnly: true });
  const priceOf = new Map(catalogue.map((p) => [p.id, p.unitPriceCents]));
  await transaction(async (db) => {
    await updateOrder(
      orderId,
      {
        customerId: customer?.id ?? null,
        requestedDeadline: ex.requestedDeadline,
        customization: ex.customization,
        notes: ex.otherRequests ?? '',
      },
      db,
    );
    // Prices come from the catalogue, never from the model.
    await setOrderItems(
      orderId,
      items.map((i) => ({ ...i, unitPriceCents: priceOf.get(i.productId)! })),
      db,
    );
  });

  Object.assign(facts, {
    customerName: customer?.name ?? ex.customer.name ?? null,
    requested: ex.items.map((i) => ({ product: i.productName, quantity: i.quantity })),
    deadline: ex.requestedDeadline ? longDate(ex.requestedDeadline) : null,
    customization: ex.customization,
    otherRequests: ex.otherRequests,
    discountRequested: ex.discountRequested,
  });

  if (u.outcome.decision === 'stop') {
    stopReason = u.outcome.stopReason!;
    facts.openQuestions = ex.missingInfo;
    facts.unmatchedRequests = ex.unresolvedItems.map((x) => ({
      customerAskedFor: x.productQuery,
      quantity: x.quantity,
      options: x.candidates.map((c) => ({
        product: c.name,
        unitPrice: fmt(priceOf.get(c.productId) ?? 0),
      })),
    }));
  }

  // 3. Pricing
  if (!stopReason) {
    const input = {
      items,
      customerId: customer?.id ?? null,
      requestedDeadline: ex.requestedDeadline,
      discountRequested: ex.discountRequested,
    };
    const p = await steps.run(
      'pricing',
      input,
      () => pricing.run(ctx, input),
      () => 'inventory',
    );
    if (!p.ok) return finish('agent_error', null);
    pricingOut = p.outcome.output;
    const q = p.outcome.output.quote;
    await updateOrder(orderId, {
      subtotalCents: q.subtotalCents,
      discountPercent: q.discountPercent,
      surchargePercent: q.surchargePercent,
      totalCents: q.totalCents,
    });
    facts.quote = {
      lines: q.lines.map((l) => ({
        product: (l as { name?: string }).name,
        quantity: l.quantity,
        unitPrice: fmt(l.unitPriceCents),
        lineTotal: fmt(l.totalCents),
        discountPercent: l.discountPercent,
      })),
      subtotal: fmt(q.subtotalCents),
      ...(q.discountCents && { discount: fmt(q.discountCents) }),
      ...(q.surchargeCents && { rushSurcharge: fmt(q.surchargeCents) }),
      total: fmt(q.totalCents),
      pricingNotes: q.notes,
      ...(p.outcome.output.upsell && {
        howToGetADiscount: {
          addUnits: p.outcome.output.upsell.addUnits,
          product: p.outcome.output.upsell.name,
          newQuantity: p.outcome.output.upsell.newQuantity,
          discountPercent: p.outcome.output.upsell.newLineDiscountPercent,
          newTotal: fmt(p.outcome.output.upsell.newTotalCents),
        },
      }),
    };
  }

  // 4. Inventory
  let productionMinutes = 0;
  if (!stopReason) {
    const input = { items };
    const inv = await steps.run(
      'inventory',
      input,
      () => inventoryAgent.run(ctx, input),
      (o) => (o.decision === 'stop' ? 'communication' : 'production'),
    );
    if (!inv.ok) return finish('agent_error', null);
    inventoryOut = inv.outcome.output;
    const a = inv.outcome.output.assessment;
    productionMinutes = a.totalProductionMinutes;
    facts.availability = a.lines.map((l) => ({
      product: l.name,
      requested: l.requested,
      inStock: l.fromStock,
      madeForThisOrder: l.unfulfillable ? 0 : l.toProduce,
      ...(l.unfulfillable && {
        unavailable: l.unfulfillable,
        note: 'bought in; currently out of stock',
      }),
    }));
    const { offer, substitutes } = inv.outcome.output;
    if (offer === 'substitute') {
      facts.offer = {
        type: 'substitute',
        products: substitutes.map((s) => ({
          product: s.name,
          unitPrice: fmt(s.unitPriceCents),
          inStock: s.available,
        })),
      };
    } else if (offer === 'partial') {
      facts.offer = {
        type: 'partial',
        weCanSupply: a.lines
          .filter((l) => l.requested - l.unfulfillable > 0)
          .map((l) => ({ product: l.name, quantity: l.requested - l.unfulfillable })),
      };
    }
    if (inv.outcome.decision === 'stop') stopReason = inv.outcome.stopReason!;
  }

  // 5. Production
  if (!stopReason) {
    const input = { items, requestedDeadline: ex.requestedDeadline, productionMinutes };
    const pr = await steps.run(
      'production',
      input,
      // Nothing to make: a rule answers, saving two Gemini calls.
      () =>
        productionMinutes === 0 ? production.runRuleBased(ctx, input) : production.run(ctx, input),
      () => 'communication',
    );
    if (!pr.ok) return finish('agent_error', null);
    productionOut = pr.outcome.output;
    const e = pr.outcome.output.estimate;
    await updateOrder(orderId, { estimatedCompletion: e.estimatedCompletionDate });
    facts.timing = {
      readyBy: e.estimatedCompletionDate ? longDate(e.estimatedCompletionDate) : null,
      meetsDeadline: e.meetsDeadline,
      ...(pr.outcome.decision === 'stop' && {
        earliestPossible: e.earliestPossibleDate ? longDate(e.earliestPossibleDate) : null,
      }),
    };
    const alt = pr.outcome.output.alternative;
    if (alt) {
      const describe = (x: typeof alt) =>
        x.type === 'later_date'
          ? { option: 'the full order on a later date', readyBy: longDate(x.readyBy) }
          : x.type === 'reduced_quantity'
            ? {
                option: 'a smaller quantity by your deadline',
                quantity: x.quantity,
                insteadOf: x.requested,
                readyBy: longDate(x.readyBy),
              }
            : {
                option: 'part now, the rest later',
                readyNow: x.now.map((n) => `${n.quantity} × ${n.sku}`).join(', '),
                restReadyBy: longDate(x.restReadyBy),
              };
      facts.proposedAlternative = describe(alt);
      facts.otherOptions = (e.alternatives ?? [])
        .filter((x) => x !== alt && x.type !== alt.type)
        .map(describe);
    }
    if (pr.outcome.decision === 'stop') stopReason = pr.outcome.stopReason!;
  }

  // 6. Communication: always drafts a reply, for the happy path or for the stop.
  const situation = stopReason ?? 'human_approval_required';
  const c = await steps.run(
    'communication',
    { situation, facts },
    () => communication.run(ctx, { facts, situation }),
    (o) => STOP_STATUS[o.decision === 'stop' ? o.stopReason! : situation],
  );
  if (!c.ok) return finish('agent_error', null);
  return finish(
    c.outcome.decision === 'stop' ? c.outcome.stopReason! : situation,
    c.outcome.output.reply,
  );
}

export interface ApprovalInput {
  /** Who decided (no login yet, so the UI sends a name). */
  decidedBy?: string;
  note?: string;
  /** Edited reply; defaults to the AI's draft. */
  reply?: string;
}

/** Statuses a person can approve from. needs_review means they looked at the warnings. */
const APPROVABLE: OrderStatus[] = ['awaiting_approval', 'needs_review'];

/**
 * APPROVE. Only now is anything committed: the Order Management Agent confirms the order through
 * the order tool (which re-checks stock and capacity, reserves stock, and books production), then
 * the decision is recorded and the reply becomes the final response.
 */
export async function approveOrder(orderId: number, input: ApprovalInput, deps: WorkflowDeps = {}) {
  return withOrderLock(orderId, () => approveLocked(orderId, input, deps));
}

async function approveLocked(orderId: number, input: ApprovalInput, deps: WorkflowDeps) {
  const order = await getOrderDetail(orderId);
  if (!order) throw notFound(`Order ${orderId} not found`);
  const approval = await getPendingApproval(orderId);
  if (!approval) throw conflict(`Order ${orderId} has no pending approval request`);
  if (!APPROVABLE.includes(order.status)) {
    throw conflict(
      order.status === 'needs_info'
        ? `Order ${orderId} is waiting for information from the customer; it can't be approved yet`
        : `Order ${orderId} is ${order.status}; only orders awaiting approval or review can be approved`,
    );
  }
  const decidedBy = input.decidedBy?.trim() || 'shop owner';
  const note = input.note?.trim() || null;
  const finalReply = input.reply?.trim() || approval.draftReply || order.draftReply;
  if (!finalReply) throw conflict(`Order ${orderId} has no reply to send`);

  // A reviewed order first moves into the approval state, by the person.
  if (order.status === 'needs_review') {
    await updateOrderStatus(orderId, 'awaiting_approval', 'human', `Reviewed by ${decidedBy}`);
  }

  const ctx: AgentContext = {
    ai: deps.ai ?? gemini(),
    today: deps.today ?? todayIso(),
    orderId,
    runId: randomUUID(),
  };
  const steps = new StepRunner(ctx);
  const agentInput = {
    orderId,
    approvedBy: decidedBy,
    note: `Approved by ${decidedBy}${note ? `: ${note}` : ''}`,
  };
  const r = await steps.run(
    'order_management',
    agentInput,
    () => orderManagement.run(ctx, agentInput),
    (o) => (o.output.confirmed ? 'confirmed' : 'awaiting_approval'),
  );
  if (!r.ok) throw r.error;
  if (!r.outcome.output.confirmed) {
    // Business validation refused (e.g. stock sold meanwhile): nothing is confirmed, the request stays open.
    throw conflict(r.outcome.output.error ?? 'The order could not be confirmed', {
      steps: steps.steps,
    });
  }

  const decision = await transaction(async (db) => {
    const d = await recordDecision(
      approval.id,
      { status: 'approved', decidedBy, note, finalReply, replySent: true },
      db,
    );
    await updateOrder(orderId, { finalReply, stopReason: null }, db);
    await createMessage(
      {
        customerId: order.customerId,
        orderId,
        direction: 'outbound',
        channel: order.customer?.channel ?? approval.packet.customer.channel,
        body: finalReply,
      },
      db,
    );
    return d;
  });
  return { order: (await getOrderDetail(orderId))!, approval: decision, steps: steps.steps };
}

/**
 * REJECT. Nothing is confirmed or reserved. The decision, status change, and (optionally) the reply
 * sent to the customer are recorded together.
 */
export async function rejectOrder(orderId: number, input: ApprovalInput & { sendReply?: boolean }) {
  return withOrderLock(orderId, () => rejectLocked(orderId, input));
}

async function rejectLocked(orderId: number, input: ApprovalInput & { sendReply?: boolean }) {
  const order = await getOrderDetail(orderId);
  if (!order) throw notFound(`Order ${orderId} not found`);
  const decidedBy = input.decidedBy?.trim() || 'shop owner';
  const note = input.note?.trim() || null;

  const check = checkTransition(order.status, 'rejected', 'human');
  if (!check.ok) throw new AppError(409, check.code, check.reason);

  const approval = await getPendingApproval(orderId);
  const finalReply = input.sendReply
    ? input.reply?.trim() || approval?.draftReply || order.draftReply
    : null;
  if (input.sendReply && !finalReply) throw conflict(`Order ${orderId} has no reply to send`);

  const decision = await transaction(async (db) => {
    const d = approval
      ? await recordDecision(
          approval.id,
          { status: 'rejected', decidedBy, note, finalReply, replySent: Boolean(finalReply) },
          db,
        )
      : null;
    await updateOrderStatus(
      orderId,
      'rejected',
      'human',
      `Rejected by ${decidedBy}${note ? `: ${note}` : ''}`,
      db,
    );
    if (finalReply) {
      await updateOrder(orderId, { finalReply }, db);
      await createMessage(
        {
          customerId: order.customerId,
          orderId,
          direction: 'outbound',
          channel: order.customer?.channel ?? approval?.packet.customer.channel ?? 'email',
          body: finalReply,
        },
        db,
      );
    }
    return d;
  });
  return { order: (await getOrderDetail(orderId))!, approval: decision };
}

/**
 * Re-run the workflow for an order that stopped because an agent failed (e.g. Gemini quota).
 * Steps that succeeded in the previous run are reused, so only the remaining agents call Gemini.
 */
export async function retryWorkflow(orderId: number, deps: WorkflowDeps = {}) {
  const order = await getOrderDetail(orderId);
  if (!order) throw notFound(`Order ${orderId} not found`);
  if (order.status !== 'needs_review' || order.stopReason !== 'agent_error') {
    throw conflict(`Order ${orderId} did not stop on an agent error; nothing to retry`);
  }
  const inbound = order.messages.find((m) => m.direction === 'inbound');
  if (!inbound) throw conflict(`Order ${orderId} has no customer message`);

  const reuse = new Map<AgentName, AgentOutcome<unknown>>();
  for (const step of await listLatestRunSteps(orderId)) {
    if (step.status !== 'ok' || step.agent === 'communication') continue;
    const out = step.output as {
      result: unknown;
      discrepancies?: string[];
      stopReason?: StopReason | null;
      route?: string;
      routeReason?: string;
    };
    reuse.set(step.agent, {
      route: out.route ?? 'continue',
      routeReason: out.routeReason ?? '',
      output: out.result,
      summary: (step.summary ?? '').replace(/^\(reused from previous run\) /, ''),
      decision: step.decision ?? 'continue',
      stopReason: out.stopReason ?? undefined,
      verification: step.verification ?? 'not_applicable',
      toolCalls: step.toolCalls as AgentOutcome<unknown>['toolCalls'],
      discrepancies: out.discrepancies ?? [],
      model: step.model ?? undefined,
    });
  }

  await updateOrder(orderId, { stopReason: null });
  await updateOrderStatus(orderId, 'processing', 'system', 'Retrying agent workflow');
  return runAgents({
    orderId,
    msg: {
      message: conversationText(order.messages),
      channel: inbound.channel,
      ...(order.customerId && { customerId: order.customerId }),
    },
    knownCustomer: order.customer ?? undefined,
    ai: deps.ai ?? gemini(),
    today: deps.today ?? todayIso(),
    started: Date.now(),
    reuse,
  });
}

/** The thread as the agents read it: every customer message and our replies, in order. */
function conversationText(messages: { direction: 'inbound' | 'outbound'; body: string }[]): string {
  if (messages.filter((m) => m.direction === 'inbound').length === 1) {
    return messages.find((m) => m.direction === 'inbound')!.body;
  }
  return messages
    .map((m) => `${m.direction === 'inbound' ? 'Customer' : 'Us'}: ${m.body}`)
    .join('\n\n');
}

/**
 * Orders waiting on the customer: we asked a question, or offered an alternative (a substitute,
 * a later date, a smaller quantity). Their answer can resume the workflow.
 */
export function canResumeWithReply(order: { status: OrderStatus; stopReason: StopReason | null }) {
  return (
    order.status === 'needs_info' ||
    (order.status === 'needs_review' &&
      (order.stopReason === 'insufficient_inventory' || order.stopReason === 'deadline_impossible'))
  );
}

/**
 * Resume a paused order with the customer's answer. The whole conversation goes to
 * the agents, so the Understanding Agent combines the original request with the reply.
 */
export async function continueWithCustomerReply(
  orderId: number,
  reply: string,
  deps: WorkflowDeps = {},
) {
  const order = await getOrderDetail(orderId);
  if (!order) throw notFound(`Order ${orderId} not found`);
  if (!canResumeWithReply(order)) {
    throw conflict(
      `Order ${orderId} is ${order.status}; only orders waiting on the customer can resume with a reply`,
    );
  }
  const channel =
    order.messages.find((m) => m.direction === 'inbound')?.channel ??
    order.customer?.channel ??
    'email';
  await transaction(async (db) => {
    // The clarifying question counts as sent if nobody sent it from the approval screen.
    if (order.draftReply && !order.messages.some((m) => m.direction === 'outbound')) {
      await createMessage(
        {
          customerId: order.customerId,
          orderId,
          direction: 'outbound',
          channel,
          body: order.draftReply,
        },
        db,
      );
    }
    await createMessage(
      { customerId: order.customerId, orderId, direction: 'inbound', channel, body: reply },
      db,
    );
    await updateOrder(orderId, { stopReason: null }, db);
    await updateOrderStatus(
      orderId,
      'processing',
      'system',
      'Customer replied: workflow resumed',
      db,
    );
  });
  const thread = (await getOrderDetail(orderId))!.messages;
  const run = runAgents({
    orderId,
    msg: {
      message: conversationText(thread),
      channel,
      ...(order.customerId && { customerId: order.customerId }),
    },
    knownCustomer: order.customer ?? undefined,
    ai: deps.ai ?? gemini(),
    today: deps.today ?? todayIso(),
    started: Date.now(),
  });
  deps.onOrderCreated?.(orderId);
  return run;
}
