import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { OrderStatus, OrderSummaryDto } from '@sbom/shared';
import { api } from '../api/client';
import { useApi } from '../api/useApi';
import { ErrorMessage, Loading } from '../components/Feedback';
import { StatusBadge } from '../components/StatusBadge';
import { formatCents, formatDate } from '../format';

/** Status groups shown as tabs. "Pending" covers everything not yet confirmed. */
const GROUPS: { key: string; label: string; statuses: OrderStatus[] }[] = [
  { key: 'all', label: 'All', statuses: [] },
  {
    key: 'pending',
    label: 'Pending',
    statuses: ['received', 'processing', 'needs_info', 'needs_review', 'awaiting_approval'],
  },
  { key: 'confirmed', label: 'Confirmed', statuses: ['confirmed'] },
  { key: 'in_production', label: 'In production', statuses: ['in_production'] },
  { key: 'ready', label: 'Ready', statuses: ['ready'] },
  { key: 'delivered', label: 'Delivered', statuses: ['completed'] },
  { key: 'cancelled', label: 'Cancelled', statuses: ['cancelled', 'rejected'] },
];

/** The next fulfilment step a person can take. */
const NEXT: Partial<
  Record<OrderStatus, { status: 'in_production' | 'ready' | 'completed'; label: string }>
> = {
  confirmed: { status: 'in_production', label: 'Start production' },
  in_production: { status: 'ready', label: 'Mark ready' },
  ready: { status: 'completed', label: 'Mark delivered' },
};

export function Orders() {
  const [params, setParams] = useSearchParams();
  const group = GROUPS.find((g) => g.key === params.get('group')) ?? GROUPS[0]!;
  const orders = useApi(() => api.orders());
  const [busy, setBusy] = useState<number>();
  const [actionError, setActionError] = useState<Error>();

  const shown = (orders.data ?? []).filter(
    (o) => group.statuses.length === 0 || group.statuses.includes(o.status),
  );
  const countFor = (g: (typeof GROUPS)[number]) =>
    orders.data?.filter((o) => g.statuses.length === 0 || g.statuses.includes(o.status)).length;

  const advance = async (o: OrderSummaryDto) => {
    const next = NEXT[o.status];
    if (!next) return;
    setBusy(o.id);
    setActionError(undefined);
    try {
      await api.setStatus(o.id, next.status);
      orders.reload();
    } catch (e) {
      setActionError(e as Error);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <>
      <h1>Orders</h1>
      <div className="preview-tabs" role="tablist" aria-label="Order status">
        {GROUPS.map((g) => (
          <button
            key={g.key}
            role="tab"
            aria-selected={g.key === group.key}
            className={`tab ${g.key === group.key ? 'tab-active' : ''}`}
            onClick={() => setParams(g.key === 'all' ? {} : { group: g.key })}
          >
            {g.label}
            {orders.data && <span className="tab-count">{countFor(g)}</span>}
          </button>
        ))}
      </div>

      {actionError && <ErrorMessage error={actionError} />}
      <section className="card">
        {orders.loading && !orders.data && <Loading />}
        {orders.error && <ErrorMessage error={orders.error} onRetry={orders.reload} />}
        {orders.data && shown.length === 0 && <p className="muted">No orders here.</p>}
        {shown.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Status</th>
                  <th className="num">Items</th>
                  <th className="num">Total</th>
                  <th>Due</th>
                  <th>
                    <span className="sr-only">Next step</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((o) => {
                  const next = NEXT[o.status];
                  return (
                    <tr key={o.id}>
                      <td>
                        <Link to={`/orders/${o.id}`}>#{o.id}</Link>
                      </td>
                      <td>{o.customerName ?? '—'}</td>
                      <td>
                        <StatusBadge status={o.status} />
                      </td>
                      <td className="num">{o.itemCount || '—'}</td>
                      <td className="num">{formatCents(o.totalCents)}</td>
                      <td>{formatDate(o.promisedDate ?? o.requestedDeadline)}</td>
                      <td className="actions">
                        {o.status === 'awaiting_approval' || o.status === 'needs_review' ? (
                          <Link to={`/orders/${o.id}`}>Review →</Link>
                        ) : next ? (
                          <button
                            className="btn btn-small-inline"
                            disabled={busy === o.id}
                            onClick={() => advance(o)}
                          >
                            {busy === o.id ? '…' : next.label}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
