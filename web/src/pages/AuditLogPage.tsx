import { useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useApi } from '../api/useApi';
import { AuditLog } from '../components/AuditLog';
import { ErrorMessage, Loading } from '../components/Feedback';
import { StatusBadge } from '../components/StatusBadge';
import { isProcessing } from '../components/WorkflowView';

/** Step-by-step audit of one order's AI run, live while the agents are working. */
export function AuditLogPage() {
  const params = useParams();
  const navigate = useNavigate();
  const orders = useApi(() => api.orders());
  const tools = useApi(api.tools);
  // Default to the newest order.
  const id = params.id ? Number(params.id) : orders.data?.[0]?.id;
  const order = useApi(() => (id ? api.order(id) : Promise.resolve(undefined)), [id]);

  const processing = order.data ? isProcessing(order.data) : false;
  const reload = order.reload;
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(reload, 1500);
    return () => clearInterval(t);
  }, [processing, reload]);

  return (
    <>
      <div className="page-head page-head-split">
        <h1>Audit log</h1>
        <div className="row">
          <label htmlFor="audit-order">Order</label>
          <select
            id="audit-order"
            value={id ?? ''}
            onChange={(e) => navigate(`/audit/${e.target.value}`)}
          >
            {orders.data?.map((o) => (
              <option key={o.id} value={o.id}>
                #{o.id} {o.customerName ?? 'Unknown'} · {o.status.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>
      </div>

      {(orders.error ?? tools.error ?? order.error) && (
        <ErrorMessage
          error={(orders.error ?? tools.error ?? order.error)!}
          onRetry={order.reload}
        />
      )}
      {order.loading && !order.data && <Loading />}
      {order.data && tools.data && (
        <>
          <div className="row">
            <b>Order #{order.data.id}</b>
            <StatusBadge status={order.data.status} />
            {processing && <span className="live-dot">Live</span>}
            <Link to={`/orders/${order.data.id}`}>Approval screen →</Link>
          </div>
          {order.data.agentRuns.length === 0 && !processing ? (
            <p className="muted">
              This order was not processed by the agents (it is part of the demo data). Process a
              message on the <Link to="/new">New Request</Link> page to see a full audit.
            </p>
          ) : (
            <AuditLog order={order.data} tools={tools.data} />
          )}
        </>
      )}
    </>
  );
}
