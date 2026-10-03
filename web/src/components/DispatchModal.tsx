/**
 * Shown after APPROVE (or REJECT with "send reply"): runs the real decision call, then simulates
 * sending the reply on the customer's channel and previews the message next to the order status.
 * Nothing is actually sent to WhatsApp or email; the modal says so.
 */
import { useEffect, useRef, useState } from 'react';
import type { Channel, OrderDetailDto } from '@sbom/shared';
import type { DecisionResult } from '../api/client';
import { formatCents, formatDate, formatDateTime } from '../format';
import { ErrorMessage } from './Feedback';
import {
  FORMAT_LABELS,
  MessagePreview,
  type PreviewFormat,
  formatForChannel,
} from './MessagePreview';
import { StatusBadge } from './StatusBadge';

type StepState = 'waiting' | 'active' | 'done' | 'error';

interface Props {
  action: 'approve' | 'reject';
  channel: Channel;
  customerName: string;
  /** The real API call. When omitted, the modal only replays the preview of `result`. */
  run?: () => Promise<DecisionResult>;
  /** Show an already-sent message (reopening the preview later). */
  result?: DecisionResult;
  onClose: (result?: DecisionResult) => void;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function DispatchModal({
  action,
  channel,
  customerName,
  run,
  result: initial,
  onClose,
}: Props) {
  const native = formatForChannel(channel);
  const label = FORMAT_LABELS[native];
  const steps = [
    action === 'approve'
      ? 'Recording approval and confirming the order (Order Management Agent)'
      : 'Recording the rejection',
    `Formatting the reply for ${label}`,
    `Sending auto-reply to ${customerName} via ${label}…`,
  ];

  const [state, setState] = useState<StepState[]>(
    initial ? steps.map(() => 'done') : steps.map((_, i) => (i === 0 ? 'active' : 'waiting')),
  );
  const [result, setResult] = useState<DecisionResult | undefined>(initial);
  const [error, setError] = useState<Error>();
  const [format, setFormat] = useState<PreviewFormat>(native);
  const [sentAt, setSentAt] = useState(() => new Date());
  const closeRef = useRef<HTMLButtonElement>(null);
  const started = useRef(false);

  useEffect(() => {
    if (initial || !run || started.current) return;
    started.current = true;
    const pace = reducedMotion() ? 0.2 : 1;
    const mark = (i: number, s: StepState) =>
      setState((prev) => prev.map((v, j) => (j === i ? s : v)));
    (async () => {
      try {
        const r = await run();
        mark(0, 'done');
        mark(1, 'active');
        await wait(800 * pace);
        mark(1, 'done');
        mark(2, 'active');
        await wait(1600 * pace);
        mark(2, 'done');
        setSentAt(new Date());
        setResult(r);
      } catch (e) {
        setState((prev) => prev.map((v) => (v === 'active' ? 'error' : v)));
        setError(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  }, [initial, run]);

  const finished = Boolean(result) || Boolean(error);
  useEffect(() => {
    if (finished) closeRef.current?.focus();
  }, [finished]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && finished) onClose(result);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finished, onClose, result]);

  const order = result?.order;
  const reply = order?.finalReply;

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dispatch-title"
        aria-busy={!finished}
      >
        <header className="modal-head">
          <h2 id="dispatch-title">
            {error
              ? 'Something went wrong'
              : result
                ? reply
                  ? `Reply sent via ${label}`
                  : 'Decision recorded'
                : 'Sending to customer…'}
          </h2>
          <button
            ref={closeRef}
            className="btn btn-ghost"
            onClick={() => onClose(result)}
            disabled={!finished}
          >
            Close
          </button>
        </header>

        <ol className="dispatch-steps" aria-live="polite">
          {steps.map((s, i) => (
            <li key={s} className={`step step-${state[i]}`}>
              <span className="step-icon" aria-hidden="true">
                {state[i] === 'done'
                  ? '✓'
                  : state[i] === 'error'
                    ? '!'
                    : state[i] === 'active'
                      ? ''
                      : '·'}
              </span>
              <span>{s}</span>
              {state[i] === 'done' && i === steps.length - 1 && (
                <span className="step-tag">Delivered</span>
              )}
            </li>
          ))}
        </ol>

        {error && <ErrorMessage error={error} />}

        {order && reply && (
          <div className="dispatch-result">
            <section className="preview-pane" aria-label="Outgoing message">
              <div className="preview-tabs" role="tablist" aria-label="Preview format">
                {(['whatsapp', 'email', 'sms', 'instagram'] as const).map((f) => (
                  <button
                    key={f}
                    role="tab"
                    aria-selected={format === f}
                    className={`tab ${format === f ? 'tab-active' : ''}`}
                    onClick={() => setFormat(f)}
                  >
                    {FORMAT_LABELS[f]}
                    {f === native && <span className="tab-note"> · sent</span>}
                  </button>
                ))}
              </div>
              <MessagePreview format={format} order={order} reply={reply} sentAt={sentAt} />
              <p className="sim-note small">
                Simulated dispatch: nothing was actually sent. A live system would send this through
                the WhatsApp Business API, an SMS gateway, or an email provider.
              </p>
            </section>
            <OrderStatusCard order={order} result={result!} />
          </div>
        )}
        {order && !reply && <OrderStatusCard order={order} result={result!} />}
      </div>
    </div>
  );
}

function OrderStatusCard({ order, result }: { order: OrderDetailDto; result: DecisionResult }) {
  const approval = result.approval;
  const reserved = order.items.filter((i) => i.reservedQuantity > 0);
  const booked = order.productionBookings.reduce((s, b) => s + b.minutes, 0);
  return (
    <section className="status-card" aria-label="Order status">
      <div className="status-card-head">
        <span>Order #{order.id}</span>
        <StatusBadge status={order.status} />
      </div>
      <ul className="kv">
        <li>
          <span>Customer</span> {order.customer?.name ?? '—'}
        </li>
        <li>
          <span>Items</span>{' '}
          {order.items.map((i) => `${i.quantity} × ${i.productName}`).join(', ') || '—'}
        </li>
        <li>
          <span>Total</span> <b>{formatCents(order.totalCents)}</b>
        </li>
        {order.status === 'confirmed' && (
          <>
            <li>
              <span>Promised</span>{' '}
              {order.promisedDate ? formatDate(`${order.promisedDate}T12:00:00`) : '—'}
            </li>
            <li>
              <span>Stock</span>{' '}
              {reserved.length
                ? reserved.map((i) => `${i.reservedQuantity} × ${i.sku} reserved`).join(', ')
                : 'nothing reserved'}
            </li>
            <li>
              <span>Production</span> {booked ? `${booked} min booked` : 'none needed'}
            </li>
          </>
        )}
      </ul>
      {approval && (
        <p className="decision-audit small">
          {approval.status === 'approved' ? 'Approved' : 'Rejected'} by <b>{approval.decidedBy}</b>{' '}
          on {formatDateTime(approval.decidedAt)}
          {approval.replyEdited ? ' · reply edited before sending' : ''}
        </p>
      )}
    </section>
  );
}
