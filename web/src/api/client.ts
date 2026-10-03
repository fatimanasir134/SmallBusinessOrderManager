import type {
  AiPingDto,
  ApiErrorBody,
  ApprovalQueueItemDto,
  ApprovalRequestDto,
  Channel,
  CustomerDto,
  HealthDto,
  OrderDetailDto,
  OrderStatus,
  OrderSummaryDto,
  ProductDto,
  StockReceiptDto,
  ToolInfoDto,
} from '@sbom/shared';

/** Error thrown for any failed API call, carrying the server's error code when available. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Is the backend running?');
  }

  const text = await res.text();
  const data: unknown = text ? safeJson(text) : undefined;

  if (!res.ok) {
    const err = (data as ApiErrorBody | undefined)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'HTTP_ERROR',
      err?.message ?? `Request failed (${res.status})`,
      err?.details,
    );
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const api = {
  health: () => request<HealthDto>('/health'),
  aiPing: () => request<AiPingDto>('/ai/ping', { method: 'POST', body: '{}' }),
  products: () => request<ProductDto[]>('/products'),
  orders: (status?: OrderStatus) =>
    request<OrderSummaryDto[]>(`/orders${status ? `?status=${status}` : ''}`),
  order: (id: number) => request<OrderDetailDto>(`/orders/${id}`),
  customers: () => request<CustomerDto[]>('/customers'),
  tools: () => request<ToolInfoDto[]>('/tools'),
  stockReceipts: () => request<StockReceiptDto[]>('/products/receipts'),
  /** Record stock received (human action). */
  restock: (id: number, body: { quantity: number; note?: string; receivedBy?: string }) =>
    request<{ receiptId: number; product: ProductDto }>(`/products/${id}/restock`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Starts the agent workflow; returns as soon as the order exists (agents keep running). */
  processMessage: (
    body: { message: string; channel?: Channel; customerId?: number },
    idempotencyKey: string,
  ) =>
    request<{ orderId: number; duplicate: boolean }>('/messages', {
      method: 'POST',
      body: JSON.stringify(body),
      // Safe to retry or double-click: the same key always returns the same order.
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
  /** The customer answered a clarifying question: resume the paused workflow. */
  reply: (id: number, message: string) =>
    request<{ orderId: number }>(`/orders/${id}/reply`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
  setStatus: (id: number, status: 'in_production' | 'ready' | 'completed' | 'cancelled') =>
    request<OrderDetailDto>(`/orders/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }),
  approvals: (status: ApprovalRequestDto['status'] = 'pending') =>
    request<ApprovalQueueItemDto[]>(`/approvals?status=${status}`),
  approve: (id: number, body: DecisionInput) =>
    request<DecisionResult>(`/orders/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  reject: (id: number, body: DecisionInput & { sendReply?: boolean }) =>
    request<DecisionResult>(`/orders/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

export interface DecisionInput {
  decidedBy?: string;
  note?: string;
  /** Edited reply; the server uses the draft when omitted. */
  reply?: string;
}

export interface DecisionResult {
  order: OrderDetailDto;
  approval: ApprovalRequestDto | null;
}
