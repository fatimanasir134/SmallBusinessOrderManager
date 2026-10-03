import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ApprovalRequestDto, RecommendedAction } from '@sbom/shared';
import { api } from '../api/client';
import { useApi } from '../api/useApi';
import { ErrorMessage, Loading } from '../components/Feedback';
import { StatusBadge } from '../components/StatusBadge';
import { formatCents, formatDateTime } from '../format';

const TABS: { status: ApprovalRequestDto['status']; label: string }[] = [
  { status: 'pending', label: 'Waiting' },
  { status: 'approved', label: 'Approved' },
  { status: 'rejected', label: 'Rejected' },
];

const ACTION: Record<RecommendedAction, string> = {
  approve: 'Approve',
  review: 'Review',
  reject: 'Reject',
  request_info: 'Ask for info',
};

/** The approval queue: orders the agents analysed, waiting for a person to decide. */
export function Approvals() {
  const [status, setStatus] = useState<ApprovalRequestDto['status']>('pending');
  const queue = useApi(() => api.approvals(status), [status]);

  return (
    <>
      <h1>Approvals</h1>
      <div className="preview-tabs" role="tablist" aria-label="Approval status">
        {TABS.map((t) => (
          <button
            key={t.status}
            role="tab"
            aria-selected={status === t.status}
            className={`tab ${status === t.status ? 'tab-active' : ''}`}
            onClick={() => setStatus(t.status)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <section className="card">
        {queue.loading && <Loading />}
        {queue.error && <ErrorMessage error={queue.error} onRetry={queue.reload} />}
        {queue.data && queue.data.length === 0 && (
          <p className="muted">
            {status === 'pending' ? 'Nothing waiting for approval.' : 'No decisions yet.'}
          </p>
        )}
        {queue.data && queue.data.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Status</th>
                  <th className="num">Total</th>
                  <th>Recommended</th>
                  <th>Since</th>
                </tr>
              </thead>
              <tbody>
                {queue.data.map((q) => (
                  <tr key={q.approvalId}>
                    <td>
                      <Link to={`/orders/${q.orderId}`}>#{q.orderId}</Link>
                    </td>
                    <td>{q.customerName ?? '—'}</td>
                    <td>
                      <StatusBadge status={q.orderStatus} />
                    </td>
                    <td className="num">{formatCents(q.totalCents)}</td>
                    <td>
                      <span className={`chip chip-action-${q.recommendedAction}`}>
                        {ACTION[q.recommendedAction]}
                      </span>
                      {q.warningCount > 0 && (
                        <span className="muted small"> · {q.warningCount} warning(s)</span>
                      )}
                    </td>
                    <td className="small">{formatDateTime(q.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
