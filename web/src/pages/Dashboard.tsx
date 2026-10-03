import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useApi } from '../api/useApi';
import { ErrorMessage, Loading } from '../components/Feedback';
import { StatusBadge } from '../components/StatusBadge';
import { formatCents, formatDateTime } from '../format';

/** At-a-glance numbers for the business, plus what needs attention. */
export function Dashboard() {
  const orders = useApi(() => api.orders());
  const approvals = useApi(() => api.approvals());
  const products = useApi(api.products);
  const health = useApi(api.health);

  const count = (s: string) => orders.data?.filter((o) => o.status === s).length;
  const lowStock = products.data?.filter((p) => p.active && p.inventory.lowStock) ?? [];
  const error = orders.error ?? approvals.error ?? products.error;

  const kpis = [
    { label: 'Total orders', value: orders.data?.length, to: '/orders' },
    { label: 'Pending approvals', value: approvals.data?.length, to: '/approvals', tone: 'warn' },
    { label: 'Confirmed', value: count('confirmed'), to: '/orders?group=confirmed' },
    { label: 'In production', value: count('in_production'), to: '/orders?group=in_production' },
    {
      label: 'Low-stock products',
      value: products.data ? lowStock.length : undefined,
      to: '/inventory',
      tone: lowStock.length ? 'danger' : undefined,
    },
  ];

  return (
    <>
      <div className="page-head page-head-split">
        <h1>Dashboard</h1>
        <Link className="btn" to="/new">
          + New customer request
        </Link>
      </div>

      {error && <ErrorMessage error={error} onRetry={orders.reload} />}

      <section className="kpis" aria-label="Key numbers">
        {kpis.map((k) => (
          <Link key={k.label} to={k.to} className={`kpi ${k.tone ? `kpi-${k.tone}` : ''}`}>
            <span className="kpi-value">{k.value ?? '–'}</span>
            <span className="kpi-label">{k.label}</span>
          </Link>
        ))}
      </section>

      <div className="grid-2">
        <section className="card">
          <h2>Waiting for your approval</h2>
          {approvals.loading && <Loading />}
          {approvals.data?.length === 0 && <p className="muted">All caught up.</p>}
          <ul className="list">
            {approvals.data?.slice(0, 5).map((a) => (
              <li key={a.approvalId}>
                <Link to={`/orders/${a.orderId}`}>
                  #{a.orderId} {a.customerName ?? 'Unknown customer'}
                </Link>
                <span className={`chip chip-action-${a.recommendedAction}`}>
                  {a.recommendedAction.replace('_', ' ')}
                </span>
                <span className="muted small">{formatCents(a.totalCents)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <h2>Low stock</h2>
          {products.loading && <Loading />}
          {products.data && lowStock.length === 0 && (
            <p className="muted">Stock levels are fine.</p>
          )}
          <ul className="list">
            {lowStock.map((p) => (
              <li key={p.id}>
                <span>{p.name}</span>
                <b className={p.inventory.available === 0 ? 'text-danger' : ''}>
                  {p.inventory.available} left
                </b>
                <span className="muted small">reorder at {p.inventory.reorderPoint}</span>
                <Link className="btn btn-small-inline" to={`/inventory?restock=${p.id}`}>
                  Reorder{p.inventory.suggestedReorder ? ` ${p.inventory.suggestedReorder}` : ''}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="card">
        <h2>Recent orders</h2>
        {orders.loading && <Loading />}
        <ul className="list">
          {orders.data?.slice(0, 6).map((o) => (
            <li key={o.id}>
              <Link to={`/orders/${o.id}`}>
                #{o.id} {o.customerName ?? 'Unknown customer'}
              </Link>
              <StatusBadge status={o.status} />
              <span className="muted small">
                {formatCents(o.totalCents)} · {formatDateTime(o.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {health.data && (
        <p className="muted small system-line">
          API {health.data.status} · Database {health.data.database} · Gemini{' '}
          {health.data.gemini.configured
            ? `${health.data.gemini.model} (${health.data.gemini.models.filter((m) => m.available).length}/${health.data.gemini.models.length} models available)`
            : 'not configured'}
        </p>
      )}
    </>
  );
}
