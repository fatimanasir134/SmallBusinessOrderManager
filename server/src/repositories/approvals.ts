import type {
  ApprovalPacket,
  ApprovalQueueItemDto,
  ApprovalRequestDto,
  OrderStatus,
  RecommendedAction,
} from '@sbom/shared';
import { type Db, query, queryOne } from '../db/client.js';
import { conflict } from '../lib/errors.js';

interface ApprovalRow {
  id: number;
  order_id: number;
  run_id: string | null;
  status: ApprovalRequestDto['status'];
  packet: ApprovalPacket;
  recommended_action: RecommendedAction;
  recommendation_reason: string;
  warning_count: number;
  draft_reply: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  final_reply: string | null;
  reply_sent: boolean | null;
  reply_edited: boolean | null;
  created_at: string;
}

const toDto = (r: ApprovalRow): ApprovalRequestDto => ({
  id: r.id,
  orderId: r.order_id,
  runId: r.run_id,
  status: r.status,
  packet: r.packet,
  recommendedAction: r.recommended_action,
  recommendationReason: r.recommendation_reason,
  warningCount: r.warning_count,
  draftReply: r.draft_reply,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
  decisionNote: r.decision_note,
  finalReply: r.final_reply,
  replySent: r.reply_sent,
  replyEdited: r.reply_edited,
  createdAt: r.created_at,
});

/** Open a request for a person to decide on. Any older pending request for the order is superseded. */
export async function createApprovalRequest(
  packet: ApprovalPacket,
  db?: Db,
): Promise<ApprovalRequestDto> {
  await query(
    `UPDATE approval_requests SET status = 'superseded' WHERE order_id = $1 AND status = 'pending'`,
    [packet.orderId],
    db,
  );
  const row = await queryOne<ApprovalRow>(
    `INSERT INTO approval_requests
       (order_id, run_id, packet, recommended_action, recommendation_reason, warning_count, draft_reply)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      packet.orderId,
      packet.runId,
      JSON.stringify(packet),
      packet.recommendedAction,
      packet.recommendationReason,
      packet.warnings.filter((w) => w.severity !== 'info').length,
      packet.response.draftReply,
    ],
    db,
  );
  return toDto(row!);
}

/** The most recent request for an order, whatever its status. */
export async function getLatestApproval(
  orderId: number,
  db?: Db,
): Promise<ApprovalRequestDto | undefined> {
  const row = await queryOne<ApprovalRow>(
    'SELECT * FROM approval_requests WHERE order_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
    [orderId],
    db,
  );
  return row && toDto(row);
}

export async function getPendingApproval(
  orderId: number,
  db?: Db,
): Promise<ApprovalRequestDto | undefined> {
  const row = await queryOne<ApprovalRow>(
    `SELECT * FROM approval_requests WHERE order_id = $1 AND status = 'pending'`,
    [orderId],
    db,
  );
  return row && toDto(row);
}

export interface ApprovalDecision {
  status: 'approved' | 'rejected';
  decidedBy: string;
  note: string | null;
  finalReply: string | null;
  replySent: boolean;
}

/**
 * Record a person's decision. Only a pending request can be decided, so a double click or a
 * second reviewer can't decide twice.
 */
export async function recordDecision(
  approvalId: number,
  d: ApprovalDecision,
  db?: Db,
): Promise<ApprovalRequestDto> {
  const row = await queryOne<ApprovalRow>(
    `UPDATE approval_requests
     SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4,
         final_reply = $5, reply_sent = $6,
         reply_edited = CASE WHEN $5::text IS NULL THEN NULL ELSE $5::text IS DISTINCT FROM draft_reply END
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [approvalId, d.status, d.decidedBy, d.note, d.finalReply, d.replySent],
    db,
  );
  if (!row) throw conflict(`Approval request ${approvalId} was already decided`);
  return toDto(row);
}

/** Orders waiting for a person, oldest first. */
export async function listApprovalQueue(
  status: ApprovalRequestDto['status'] = 'pending',
  db?: Db,
): Promise<ApprovalQueueItemDto[]> {
  const rows = await query<{
    id: number;
    order_id: number;
    order_status: OrderStatus;
    customer_name: string | null;
    total_cents: number | null;
    recommended_action: RecommendedAction;
    recommendation_reason: string;
    warning_count: number;
    created_at: string;
  }>(
    `SELECT a.id, a.order_id, o.status AS order_status, c.name AS customer_name, o.total_cents,
            a.recommended_action, a.recommendation_reason, a.warning_count, a.created_at
     FROM approval_requests a
     JOIN orders o ON o.id = a.order_id
     LEFT JOIN customers c ON c.id = o.customer_id
     WHERE a.status = $1
     ORDER BY a.created_at ${status === 'pending' ? 'ASC' : 'DESC'}`,
    [status],
    db,
  );
  return rows.map((r) => ({
    approvalId: r.id,
    orderId: r.order_id,
    orderStatus: r.order_status,
    customerName: r.customer_name,
    totalCents: r.total_cents,
    recommendedAction: r.recommended_action,
    recommendationReason: r.recommendation_reason,
    warningCount: r.warning_count,
    createdAt: r.created_at,
  }));
}
