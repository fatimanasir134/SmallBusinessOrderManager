import type { OrderStatus } from '@sbom/shared';

const LABELS: Record<OrderStatus, string> = {
  received: 'Received',
  processing: 'Processing',
  needs_info: 'Needs info',
  needs_review: 'Needs review',
  awaiting_approval: 'Awaiting approval',
  confirmed: 'Confirmed',
  rejected: 'Rejected',
  in_production: 'In production',
  ready: 'Ready',
  completed: 'Delivered',
  cancelled: 'Cancelled',
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  return <span className={`badge badge-${status}`}>{LABELS[status]}</span>;
}
