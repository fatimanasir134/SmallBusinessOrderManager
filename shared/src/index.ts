/**
 * Types and constants shared by the server and the web app.
 * Rebuild with `npm run build:shared` after changing this file.
 */

export const ORDER_STATUSES = [
  'received',
  'processing',
  'needs_info',
  'needs_review',
  'awaiting_approval',
  'confirmed',
  'rejected',
  'in_production',
  'ready',
  'completed',
  'cancelled',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Allowed status transitions. The server enforces these; the UI uses them to show valid actions. */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  received: ['processing', 'cancelled'],
  processing: ['awaiting_approval', 'needs_info', 'needs_review', 'cancelled'],
  needs_info: ['processing', 'rejected', 'cancelled'],
  needs_review: ['processing', 'awaiting_approval', 'rejected', 'cancelled'],
  awaiting_approval: ['confirmed', 'rejected', 'processing', 'cancelled'],
  confirmed: ['in_production', 'cancelled'],
  in_production: ['ready', 'cancelled'],
  ready: ['completed'],
  rejected: [],
  completed: [],
  cancelled: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export const AGENT_NAMES = [
  'understanding',
  'pricing',
  'inventory',
  'production',
  'communication',
  'order_management',
] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

/** Who each agent is, for the UI. `tools` must match the agent's TOOLS (checked by a test). */
export const AGENT_INFO: Record<
  AgentName,
  { label: string; role: string; tools: readonly string[] }
> = {
  understanding: {
    label: 'Order Understanding Agent',
    role: 'Reads the customer message and extracts products, quantities, deadline, and requests',
    tools: [],
  },
  pricing: {
    label: 'Pricing Agent',
    role: 'Prices the order with the pricing rules; never invents prices',
    tools: ['calculateOrderPrice'],
  },
  inventory: {
    label: 'Inventory Agent',
    role: 'Checks real stock and whether the order can be fulfilled',
    tools: ['checkInventory'],
  },
  production: {
    label: 'Production Agent',
    role: 'Checks production capacity and whether the deadline can be met',
    tools: ['calculateEstimatedCompletion', 'checkProductionCapacity'],
  },
  communication: {
    label: 'Communication Agent',
    role: 'Writes the customer reply from verified facts only',
    tools: [],
  },
  order_management: {
    label: 'Order Management Agent',
    role: 'After human approval, confirms the order: reserves stock and books production',
    tools: ['updateOrderStatus'],
  },
};

/** A business tool, as listed by GET /api/tools. */
export interface ToolInfoDto {
  name: string;
  description: string;
  /** read = no side effects; write = changes the database. */
  access: 'read' | 'write';
}

/** Why the workflow stopped before (or at) the approval gate. */
export const STOP_REASONS = [
  'missing_info',
  'unknown_product',
  'insufficient_inventory',
  'deadline_impossible',
  'human_approval_required',
  'unverified_reply',
  'agent_error',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/** How the backend checked an agent's claims against the business tools. */
export type Verification =
  | 'matched' // agent's claims agree with the tool results
  | 'corrected' // agent misreported; the tool results were used instead
  | 'recomputed' // agent skipped or misused its tool; the backend ran it
  | 'not_applicable';

// ---------- Domain enums ----------

export const CUSTOMER_TIERS = ['standard', 'loyal', 'wholesale'] as const;
export type CustomerTier = (typeof CUSTOMER_TIERS)[number];

export const CHANNELS = ['email', 'instagram', 'whatsapp', 'sms', 'walk_in'] as const;
export type Channel = (typeof CHANNELS)[number];

export const PRICING_RULE_TYPES = [
  'volume_discount',
  'customer_tier_discount',
  'rush_surcharge',
  'max_discount',
] as const;
export type PricingRuleType = (typeof PRICING_RULE_TYPES)[number];

/** Who caused a status change. */
export type StatusActor = 'system' | 'agent' | 'human';

// ---------- DTOs returned by the API ----------
// Money is always integer cents; dates are 'YYYY-MM-DD'; timestamps are ISO-8601 strings.

export interface CustomerDto {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  channel: Channel;
  tier: CustomerTier;
  notes: string;
  createdAt: string;
}

export interface InventoryDto {
  onHand: number;
  reserved: number;
  /** onHand - reserved: what new orders can use. */
  available: number;
  reorderPoint: number;
  /** available is at or below the reorder point. */
  lowStock: boolean;
  /** For low-stock items: units that bring available stock back to twice the reorder point. */
  suggestedReorder: number | null;
  updatedAt: string;
}

export interface ProductDto {
  id: number;
  sku: string;
  name: string;
  description: string;
  category: string;
  unitPriceCents: number;
  productionMinutesPerUnit: number;
  madeToOrder: boolean;
  active: boolean;
  inventory: InventoryDto;
}

/** A restock (supplier delivery or finished batch) recorded by a person. */
export interface StockReceiptDto {
  id: number;
  productId: number;
  sku: string;
  productName: string;
  quantity: number;
  onHandAfter: number;
  receivedBy: string;
  note: string;
  createdAt: string;
}

export interface PricingRuleDto {
  id: number;
  name: string;
  description: string;
  ruleType: PricingRuleType;
  /** null = applies to every product. */
  productId: number | null;
  customerTier: CustomerTier | null;
  minQuantity: number | null;
  maxDaysUntilDeadline: number | null;
  percent: number;
  active: boolean;
}

export interface CapacityDayDto {
  day: string;
  capacityMinutes: number;
  bookedMinutes: number;
  freeMinutes: number;
}

export interface OrderSummaryDto {
  id: number;
  customerId: number | null;
  customerName: string | null;
  status: OrderStatus;
  requestedDeadline: string | null;
  promisedDate: string | null;
  totalCents: number | null;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrderItemDto {
  id: number;
  productId: number;
  sku: string;
  productName: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
  /** Units taken from stock when the order was approved; the rest is produced. */
  reservedQuantity: number;
}

export interface ProductionBookingDto {
  day: string;
  minutes: number;
}

export interface StatusHistoryDto {
  id: number;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  actor: StatusActor;
  note: string | null;
  createdAt: string;
}

export interface MessageDto {
  id: number;
  customerId: number | null;
  orderId: number | null;
  direction: 'inbound' | 'outbound';
  channel: Channel;
  body: string;
  createdAt: string;
}

export interface AgentRunDto {
  id: number;
  orderId: number;
  agent: AgentName;
  status: 'ok' | 'error';
  input: unknown;
  output: unknown;
  toolCalls: unknown[];
  error: string | null;
  durationMs: number | null;
  /** Groups the steps of one workflow execution. */
  runId: string | null;
  decision: 'continue' | 'stop' | null;
  /** One line: what the agent concluded. */
  summary: string | null;
  /** What the workflow did next (next agent, or the status it stopped in). */
  nextStep: string | null;
  model: string | null;
  verification: Verification | null;
  createdAt: string;
}

export interface OrderDetailDto extends OrderSummaryDto {
  customer: CustomerDto | null;
  subtotalCents: number | null;
  discountPercent: number;
  surchargePercent: number;
  draftReply: string | null;
  finalReply: string | null;
  notes: string;
  stopReason: StopReason | null;
  /** The latest approval request (pending or decided), if the agents produced one. */
  approval: ApprovalRequestDto | null;
  customization: string | null;
  estimatedCompletion: string | null;
  items: OrderItemDto[];
  productionBookings: ProductionBookingDto[];
  history: StatusHistoryDto[];
  messages: MessageDto[];
  agentRuns: AgentRunDto[];
}

export interface HealthDto {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  database: 'ok' | 'error';
  gemini: {
    configured: boolean;
    /** Model the next call will use (the first one not cooling down). */
    model: string;
    /** Every configured model; unavailable ones are cooling down after a quota or overload error. */
    models: { model: string; available: boolean; until: string | null; reason: string | null }[];
  };
  version: string;
}

// ---------- AI extraction ----------

/** What Gemini read from the message, before validation. */
export interface RawExtractionDto {
  customer: { name: string | null; email: string | null; phone: string | null };
  items: { productQuery: string; quantity: number | null }[];
  deadlineText: string | null;
  deadlineDate: string | null;
  discountRequested: boolean;
  customization: string | null;
  otherRequests: string | null;
  /** Questions the agent judged necessary before the order can be quoted. */
  clarificationQuestions?: string[];
}

export interface ExtractedItemDto {
  productId: number;
  sku: string;
  productName: string;
  quantity: number;
  matchedFrom: string;
  matchScore: number;
}

export interface UnresolvedItemDto {
  productQuery: string;
  quantity: number | null;
  reason: 'unknown_product' | 'ambiguous_product' | 'missing_quantity' | 'invalid_quantity';
  candidates: { productId: number; sku: string; name: string }[];
}

/** Validated order request: products matched to the catalogue, real dates, and open questions. */
export interface OrderExtractionDto {
  customer: RawExtractionDto['customer'];
  items: ExtractedItemDto[];
  unresolvedItems: UnresolvedItemDto[];
  requestedDeadline: string | null;
  /** How the deadline was determined: our own date parser, the model, or none. */
  deadlineSource: 'parsed' | 'model' | null;
  deadlineText: string | null;
  discountRequested: boolean;
  customization: string | null;
  otherRequests: string | null;
  /** Questions to ask the customer before the order can be quoted. */
  missingInfo: string[];
  /** True when every requested item is resolved and nothing essential is missing. */
  isComplete: boolean;
}

export interface AiExtractDto {
  model: string;
  today: string;
  latencyMs: number;
  extraction: OrderExtractionDto & {
    raw: RawExtractionDto;
    /** True if Gemini's first answer was invalid and a repair turn fixed it. */
    repaired: boolean;
  };
}

// ---------- Workflow ----------

export interface WorkflowStepDto {
  agent: AgentName;
  status: 'ok' | 'error';
  decision: 'continue' | 'stop';
  /** The route the agent chose, validated against tool results (e.g. 'insufficient_stock'). */
  route?: string;
  routeReason?: string;
  summary: string;
  nextStep: string;
  verification: Verification;
  durationMs: number;
}

// ---------- Human approval ----------

export const RECOMMENDED_ACTIONS = ['approve', 'review', 'reject', 'request_info'] as const;
export type RecommendedAction = (typeof RECOMMENDED_ACTIONS)[number];

export interface ApprovalWarning {
  code: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
}

/** Everything a person needs to approve or reject an order, built from verified agent results. */
export interface ApprovalPacket {
  orderId: number;
  runId: string;
  stopReason: StopReason;
  customer: {
    id: number | null;
    name: string | null;
    tier: CustomerTier | null;
    channel: Channel;
    email: string | null;
    phone: string | null;
    isNew: boolean;
  };
  request: {
    message: string;
    items: { productId: number; sku: string; name: string; quantity: number }[];
    unresolved: { asked: string; reason: string }[];
    requestedDeadline: string | null;
    customization: string | null;
    otherRequests: string | null;
    discountRequested: boolean;
  };
  pricing: {
    subtotalCents: number;
    discountCents: number;
    surchargeCents: number;
    totalCents: number;
    discountPercent: number;
    appliedRules: string[];
    discountDecision: 'applied' | 'not_eligible' | 'not_requested';
    explanation: string;
  } | null;
  inventory: {
    fulfillable: boolean;
    allInStock: boolean;
    lines: {
      sku: string;
      requested: number;
      fromStock: number;
      toProduce: number;
      unfulfillable: number;
      availableAfter: number;
      belowReorderPointAfter: boolean;
    }[];
    summary: string;
  } | null;
  production: {
    feasible: boolean;
    needsProduction: boolean;
    estimatedCompletionDate: string | null;
    requestedDeadline: string | null;
    meetsDeadline: boolean | null;
    slackDays: number | null;
    earliestPossibleDate: string | null;
    summary: string;
  } | null;
  response: { draftReply: string | null };
  /** Steps where the backend overruled an agent (corrected or recomputed). */
  verification: { agent: AgentName; verification: Verification; discrepancies: string[] }[];
  /** Each agent's routing decision and the tool evidence behind it. */
  routing: { agent: AgentName; route: string; reason: string }[];
  /** Alternatives the agents chose to offer the customer (upsell, substitute, later date, ...). */
  offers: string[];
  warnings: ApprovalWarning[];
  recommendedAction: RecommendedAction;
  recommendationReason: string;
}

export interface ApprovalRequestDto {
  id: number;
  orderId: number;
  runId: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'superseded';
  packet: ApprovalPacket;
  recommendedAction: RecommendedAction;
  recommendationReason: string;
  warningCount: number;
  draftReply: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  finalReply: string | null;
  replySent: boolean | null;
  replyEdited: boolean | null;
  createdAt: string;
}

/** A row in the approval queue. */
export interface ApprovalQueueItemDto {
  approvalId: number;
  orderId: number;
  orderStatus: OrderStatus;
  customerName: string | null;
  totalCents: number | null;
  recommendedAction: RecommendedAction;
  recommendationReason: string;
  warningCount: number;
  createdAt: string;
}

export interface WorkflowResultDto {
  orderId: number;
  /** True when this message was already received: the existing order is returned, nothing new runs. */
  duplicate?: boolean;
  runId: string;
  status: OrderStatus;
  stopReason: StopReason | null;
  draftReply: string | null;
  /** The approval request created for a person to decide on (null if the analysis failed). */
  approval: ApprovalRequestDto | null;
  steps: WorkflowStepDto[];
  durationMs: number;
}

export interface AiPingDto {
  model: string;
  reply: string;
  latencyMs: number;
}

/** Shape of every error response from the API. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}
