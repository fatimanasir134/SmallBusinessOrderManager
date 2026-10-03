import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CHANNELS, type Channel, type OrderDetailDto } from '@sbom/shared';
import { api } from '../api/client';
import { useApi } from '../api/useApi';
import { ErrorMessage } from '../components/Feedback';
import { StatusBadge } from '../components/StatusBadge';
import { WorkflowView, isProcessing } from '../components/WorkflowView';
import { formatCents } from '../format';

/** One message per routing case, so each branch of the workflow can be shown live. */
const EXAMPLES = [
  { label: '1 · In stock', text: 'Hi! Could I get 2 holographic sticker sheets? No rush.' },
  { label: '2 · Out of stock', text: "I'd like 2 pastel washi tape sets please." },
  {
    label: '3 · Impossible deadline',
    text: 'We need 40 packs of custom die-cut stickers by tomorrow. Our logo artwork is attached.',
  },
  {
    label: '4 · Discount',
    text: 'Can I get 2 holographic sticker sheets? Any discount available?',
  },
  { label: '5 · Missing info', text: 'Can you make custom stickers with our logo for our café?' },
  { label: '6 · Unknown product', text: 'Do you sell unicorn mugs? I would like two.' },
  { label: 'Demo order', text: 'I need 3 pink sticker sheets by Friday. Can I get a discount?' },
];

const POLL_MS = 1500;

/** Paste a customer message, run the agents, and watch the workflow live. */
export function NewRequest() {
  const customers = useApi(api.customers);
  const [message, setMessage] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [channel, setChannel] = useState<Channel>('email');
  const [orderId, setOrderId] = useState<number>();
  const [order, setOrder] = useState<OrderDetailDto>();
  const [error, setError] = useState<Error>();
  const [submitting, setSubmitting] = useState(false);

  // Poll the order while the agents work.
  useEffect(() => {
    if (!orderId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const o = await api.order(orderId);
        if (stopped) return;
        setOrder(o);
        if (isProcessing(o)) timer = setTimeout(tick, POLL_MS);
      } catch (e) {
        if (!stopped) setError(e as Error);
      }
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [orderId]);

  const running = submitting || (order ? isProcessing(order) : Boolean(orderId));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setOrder(undefined);
    setOrderId(undefined);
    setSubmitting(true);
    try {
      const r = await api.processMessage(
        {
          message: message.trim(),
          channel,
          ...(customerId && { customerId: Number(customerId) }),
        },
        crypto.randomUUID(),
      );
      setOrderId(r.orderId);
    } catch (err) {
      setError(err as Error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <h1>New customer request</h1>
      <div className="request-layout">
        <section className="card">
          <form onSubmit={submit}>
            <label htmlFor="msg">Customer message</label>
            <textarea
              id="msg"
              className="big-input"
              rows={8}
              value={message}
              placeholder="Paste the message exactly as the customer wrote it…"
              onChange={(e) => setMessage(e.target.value)}
            />
            <div className="examples">
              <span className="muted small">Try:</span>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.label}
                  type="button"
                  className="tab"
                  onClick={() => setMessage(ex.text)}
                >
                  {ex.label}
                </button>
              ))}
            </div>
            <div className="form-row">
              <div className="grow">
                <label htmlFor="customer">Customer</label>
                <select
                  id="customer"
                  value={customerId}
                  onChange={(e) => {
                    setCustomerId(e.target.value);
                    const c = customers.data?.find((x) => String(x.id) === e.target.value);
                    if (c) setChannel(c.channel);
                  }}
                >
                  <option value="">New / unknown (detect from message)</option>
                  {customers.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.tier})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="channel">Received via</label>
                <select
                  id="channel"
                  value={channel}
                  onChange={(e) => setChannel(e.target.value as Channel)}
                >
                  {CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {c.replace('_', '-')}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <button
              type="submit"
              className="btn btn-primary-lg"
              disabled={!message.trim() || running}
            >
              {running ? 'Processing…' : 'Process Order'}
            </button>
          </form>
          {error && <ErrorMessage error={error} />}
        </section>

        <section className="card">
          <h2>AI workflow</h2>
          {!order && !running && (
            <p className="muted">
              Process a message to watch the five Gemini agents work, step by step, up to your
              approval.
            </p>
          )}
          {!order && running && <p className="muted">Recording the order…</p>}
          {order && <WorkflowView order={order} />}
          {orderId && (
            <p className="small">
              <Link to={`/audit/${orderId}`}>Open the step-by-step audit log →</Link>
            </p>
          )}
          {order && !isProcessing(order) && <ResultCard order={order} />}
        </section>
      </div>
    </>
  );
}

function ResultCard({ order }: { order: OrderDetailDto }) {
  const a = order.approval;
  return (
    <div className="result-card">
      <div className="row">
        <b>Order #{order.id}</b>
        <StatusBadge status={order.status} />
        {order.totalCents != null && <b>{formatCents(order.totalCents)}</b>}
      </div>
      {a?.status === 'pending' ? (
        <Link className="btn" to={`/orders/${order.id}`}>
          Review and decide →
        </Link>
      ) : (
        <Link to={`/orders/${order.id}`}>Open order →</Link>
      )}
    </div>
  );
}
