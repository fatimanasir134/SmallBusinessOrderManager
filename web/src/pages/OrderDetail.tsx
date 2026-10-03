import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  ApprovalPacket,
  ApprovalRequestDto,
  OrderDetailDto,
  RecommendedAction,
} from '@sbom/shared';
import { api, type DecisionResult } from '../api/client';
import { useApi } from '../api/useApi';
import { DispatchModal } from '../components/DispatchModal';
import { ErrorMessage, Loading } from '../components/Feedback';
import { StatusBadge } from '../components/StatusBadge';
import { WorkflowView, isProcessing } from '../components/WorkflowView';
import { formatCents, formatDate, formatDateTime } from '../format';

const APPROVABLE = ['awaiting_approval', 'needs_review'];
const REJECTABLE = ['awaiting_approval', 'needs_review', 'needs_info'];

const ACTION_LABEL: Record<RecommendedAction, string> = {
  approve: 'Approve',
  review: 'Review before approving',
  reject: 'Reject',
  request_info: 'Ask the customer for more information',
};

const NAME_KEY = 'sbom.decidedBy';
const loadName = () => {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
};
const saveName = (name: string) => {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Storage unavailable: the name just isn't remembered.
  }
};

type Dispatch =
  | { action: 'approve' | 'reject'; run?: () => Promise<DecisionResult>; result?: DecisionResult }
  | undefined;

/** The approval screen: everything the agents found, and the human decision. */
export function OrderDetail() {
  const id = Number(useParams().id);
  const order = useApi(() => api.order(id), [id]);
  const [dispatch, setDispatch] = useState<Dispatch>();
  const reload = order.reload;
  const processing = order.data ? isProcessing(order.data) : false;
  // While the agents are still working, refresh so the workflow view fills in.
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(reload, 1500);
    return () => clearInterval(t);
  }, [processing, reload]);

  if (!Number.isInteger(id) || id <= 0) return <p>Invalid order id.</p>;

  return (
    <>
      <p>
        <Link to="/approvals">← Approvals</Link> · <Link to="/orders">Orders</Link>
      </p>
      {order.loading && !order.data && <Loading />}
      {order.error && <ErrorMessage error={order.error} onRetry={order.reload} />}
      {order.data && (
        <ApprovalScreen
          order={order.data}
          onDecide={(d) => setDispatch(d)}
          onShowSent={(result) => setDispatch({ action: 'approve', result })}
        />
      )}
      {dispatch && order.data && (
        <DispatchModal
          action={dispatch.action}
          channel={
            order.data.approval?.packet.customer.channel ?? order.data.customer?.channel ?? 'email'
          }
          customerName={order.data.customer?.name ?? 'the customer'}
          run={dispatch.run}
          result={dispatch.result}
          onClose={() => {
            setDispatch(undefined);
            order.reload();
          }}
        />
      )}
    </>
  );
}

function ApprovalScreen({
  order,
  onDecide,
  onShowSent,
}: {
  order: OrderDetailDto;
  onDecide: (d: Dispatch) => void;
  onShowSent: (result: DecisionResult) => void;
}) {
  const approval = order.approval;
  const packet = approval?.packet;
  const pending = approval?.status === 'pending';

  return (
    <>
      <div className="page-head">
        <h1>Order #{order.id}</h1>
        <StatusBadge status={order.status} />
      </div>

      {pending && packet && <Recommendation packet={packet} />}
      {approval && !pending && (
        <DecisionRecord order={order} approval={approval} onShowSent={onShowSent} />
      )}
      {!approval && (
        <p className="alert alert-info">
          No approval request for this order
          {order.stopReason === 'agent_error'
            ? ': the analysis failed. Retry it from the API.'
            : '.'}
        </p>
      )}

      <section className="card">
        <div className="page-head page-head-split">
          <h2>AI workflow</h2>
          <Link to={`/audit/${order.id}`}>Full audit log →</Link>
        </div>
        <WorkflowView order={order} />
      </section>

      {packet && (
        <div className="grid-2">
          <CustomerCard packet={packet} />
          <RequestCard packet={packet} />
          <PriceCard order={order} packet={packet} />
          <StockAndTimingCard packet={packet} />
        </div>
      )}

      {(order.status === 'needs_info' ||
        (order.status === 'needs_review' &&
          (order.stopReason === 'insufficient_inventory' ||
            order.stopReason === 'deadline_impossible'))) && <CustomerReply order={order} />}

      {pending && approval && (
        <DecisionPanel order={order} approval={approval} onDecide={onDecide} />
      )}

      <Conversation order={order} />
    </>
  );
}

function Recommendation({ packet }: { packet: ApprovalPacket }) {
  const order = { critical: 0, warning: 1, info: 2 } as const;
  const warnings = [...packet.warnings].sort((a, b) => order[a.severity] - order[b.severity]);
  return (
    <section className={`card recommend recommend-${packet.recommendedAction}`}>
      <h2>Recommended: {ACTION_LABEL[packet.recommendedAction]}</h2>
      <p>{packet.recommendationReason}</p>
      {packet.offers?.length > 0 && (
        <div className="offers">
          <div className="audit-section-title">Alternatives the agents offer the customer</div>
          <ul>
            {packet.offers.map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <ul className="warnings">
          {warnings.map((w) => (
            <li key={w.code + w.message} className={`warn warn-${w.severity}`}>
              <span className="warn-tag">{w.severity}</span> {w.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CustomerCard({ packet }: { packet: ApprovalPacket }) {
  const c = packet.customer;
  return (
    <section className="card">
      <h2>Customer</h2>
      <ul className="kv">
        <li>
          <span>Name</span> {c.name ?? '—'} {c.isNew && <em className="muted">(new)</em>}
        </li>
        <li>
          <span>Tier</span> {c.tier ?? '—'}
        </li>
        <li>
          <span>Channel</span> {c.channel}
        </li>
        <li>
          <span>Contact</span> {c.email ?? c.phone ?? '—'}
        </li>
      </ul>
    </section>
  );
}

function RequestCard({ packet }: { packet: ApprovalPacket }) {
  const r = packet.request;
  return (
    <section className="card">
      <h2>Request</h2>
      <blockquote className="quote">{r.message}</blockquote>
      <ul className="kv">
        <li>
          <span>Products</span> {r.items.map((i) => `${i.quantity} × ${i.name}`).join(', ') || '—'}
        </li>
        {r.unresolved.length > 0 && (
          <li>
            <span>Unclear</span>{' '}
            {r.unresolved.map((u) => `"${u.asked}" (${u.reason.replace('_', ' ')})`).join(', ')}
          </li>
        )}
        <li>
          <span>Deadline</span>{' '}
          {r.requestedDeadline ? formatDate(`${r.requestedDeadline}T12:00:00`) : 'none given'}
        </li>
        {r.customization && (
          <li>
            <span>Customization</span> {r.customization}
          </li>
        )}
        {r.otherRequests && (
          <li>
            <span>Other</span> {r.otherRequests}
          </li>
        )}
        <li>
          <span>Discount asked</span> {r.discountRequested ? 'yes' : 'no'}
        </li>
      </ul>
    </section>
  );
}

function PriceCard({ order, packet }: { order: OrderDetailDto; packet: ApprovalPacket }) {
  const p = packet.pricing;
  return (
    <section className="card">
      <h2>Price</h2>
      {!p ? (
        <p className="muted">Not priced: the workflow stopped before pricing.</p>
      ) : (
        <table>
          <tbody>
            {order.items.map((i) => (
              <tr key={i.id}>
                <td>
                  {i.quantity} × {i.productName}
                </td>
                <td className="num">{formatCents(i.lineTotalCents)}</td>
              </tr>
            ))}
            {p.discountCents > 0 && (
              <tr>
                <td>Discount ({p.appliedRules.filter((r) => r !== 'Rush order').join(', ')})</td>
                <td className="num">−{formatCents(p.discountCents)}</td>
              </tr>
            )}
            {p.surchargeCents > 0 && (
              <tr>
                <td>Rush surcharge</td>
                <td className="num">+{formatCents(p.surchargeCents)}</td>
              </tr>
            )}
            <tr className="total-row">
              <td>Total</td>
              <td className="num">{formatCents(p.totalCents)}</td>
            </tr>
          </tbody>
        </table>
      )}
      {p && <p className="muted small">{p.explanation}</p>}
    </section>
  );
}

function StockAndTimingCard({ packet }: { packet: ApprovalPacket }) {
  const inv = packet.inventory;
  const prod = packet.production;
  return (
    <section className="card">
      <h2>Inventory & production</h2>
      {!inv ? (
        <p className="muted">Not checked: the workflow stopped earlier.</p>
      ) : (
        <ul className="kv">
          {inv.lines.map((l) => (
            <li key={l.sku}>
              <span>{l.sku}</span> {l.fromStock} from stock
              {l.toProduce - l.unfulfillable > 0 && `, ${l.toProduce - l.unfulfillable} to produce`}
              {l.unfulfillable > 0 && (
                <b className="text-danger">, {l.unfulfillable} unavailable</b>
              )}
            </li>
          ))}
        </ul>
      )}
      {prod && (
        <ul className="kv">
          <li>
            <span>Ready</span>{' '}
            {prod.estimatedCompletionDate
              ? formatDate(`${prod.estimatedCompletionDate}T12:00:00`)
              : 'not within capacity'}
          </li>
          <li>
            <span>Deadline</span>{' '}
            {prod.meetsDeadline === null ? (
              'none'
            ) : prod.meetsDeadline ? (
              'met'
            ) : (
              <b className="text-danger">
                missed
                {prod.earliestPossibleDate &&
                  ` (earliest ${formatDate(`${prod.earliestPossibleDate}T12:00:00`)})`}
              </b>
            )}
          </li>
        </ul>
      )}
    </section>
  );
}

function DecisionPanel({
  order,
  approval,
  onDecide,
}: {
  order: OrderDetailDto;
  approval: ApprovalRequestDto;
  onDecide: (d: Dispatch) => void;
}) {
  const draft = approval.draftReply ?? '';
  const [reply, setReply] = useState(draft);
  const [name, setName] = useState(loadName);
  const [note, setNote] = useState('');
  const recommendsSending = ['reject', 'request_info'].includes(approval.recommendedAction);
  const [sendOnReject, setSendOnReject] = useState(recommendsSending);
  useEffect(() => setReply(draft), [draft]);

  const canApprove = APPROVABLE.includes(order.status) && reply.trim().length > 0;
  const canReject = REJECTABLE.includes(order.status);
  const body = () => {
    saveName(name.trim());
    return {
      decidedBy: name.trim() || undefined,
      note: note.trim() || undefined,
      reply: reply.trim() !== draft.trim() ? reply.trim() : undefined,
    };
  };

  return (
    <section className="card decision">
      <h2>Your decision</h2>
      <label htmlFor="reply">Reply to the customer</label>
      <textarea
        id="reply"
        rows={6}
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        aria-describedby="reply-help"
      />
      <p id="reply-help" className="muted small">
        Drafted by the Communication Agent from verified facts.
        {reply !== draft && (
          <>
            {' '}
            Edited.{' '}
            <button className="link-btn" onClick={() => setReply(draft)}>
              Reset to draft
            </button>
          </>
        )}
      </p>
      <div className="form-row">
        <div>
          <label htmlFor="decided-by">Your name</label>
          <input
            id="decided-by"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="shop owner"
          />
        </div>
        <div className="grow">
          <label htmlFor="note">Note (optional)</label>
          <input
            id="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why you decided this"
          />
        </div>
      </div>
      <div className="row decision-actions">
        <button
          className="btn btn-approve"
          disabled={!canApprove}
          onClick={() => onDecide({ action: 'approve', run: () => api.approve(order.id, body()) })}
        >
          APPROVE
        </button>
        <button
          className="btn btn-reject"
          disabled={!canReject}
          onClick={() =>
            onDecide({
              action: 'reject',
              run: () => api.reject(order.id, { ...body(), sendReply: sendOnReject }),
            })
          }
        >
          REJECT
        </button>
        <label className="check">
          <input
            type="checkbox"
            checked={sendOnReject}
            onChange={(e) => setSendOnReject(e.target.checked)}
          />{' '}
          Send this reply when rejecting
        </label>
      </div>
      {!APPROVABLE.includes(order.status) && (
        <p className="muted small">
          This order is waiting for information from the customer, so it can't be approved. Reject
          it with the reply, or wait for their answer.
        </p>
      )}
    </section>
  );
}

function DecisionRecord({
  order,
  approval,
  onShowSent,
}: {
  order: OrderDetailDto;
  approval: ApprovalRequestDto;
  onShowSent: (result: DecisionResult) => void;
}) {
  return (
    <section className={`card decided decided-${approval.status}`}>
      <h2>
        Decision: {approval.status}
        {approval.decidedBy && ` by ${approval.decidedBy}`}
      </h2>
      <ul className="kv">
        <li>
          <span>When</span> {formatDateTime(approval.decidedAt)}
        </li>
        {approval.decisionNote && (
          <li>
            <span>Note</span> {approval.decisionNote}
          </li>
        )}
        <li>
          <span>Recommended</span> {ACTION_LABEL[approval.recommendedAction]}
        </li>
        <li>
          <span>Reply</span>{' '}
          {approval.replySent
            ? approval.replyEdited
              ? 'sent (edited by a person)'
              : 'sent as drafted'
            : 'not sent'}
        </li>
      </ul>
      {approval.replySent && order.finalReply && (
        <button className="btn btn-ghost" onClick={() => onShowSent({ order, approval })}>
          View sent message
        </button>
      )}
    </section>
  );
}

function Conversation({ order }: { order: OrderDetailDto }) {
  if (order.messages.length === 0) return null;
  return (
    <section className="card">
      <h2>Messages</h2>
      <ul className="thread">
        {order.messages.map((m) => (
          <li key={m.id} className={`msg msg-${m.direction}`}>
            <div className="muted small">
              {m.direction === 'inbound' ? 'Customer' : 'Studio'} · {m.channel} ·{' '}
              {formatDateTime(m.createdAt)}
            </div>
            {m.body}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A paused order resumes when the customer answers the clarifying question. */
function CustomerReply({ order }: { order: OrderDetailDto }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.reply(order.id, text.trim());
      // The page polls while the order is processing, so the workflow view fills in.
      window.location.reload();
    } catch (err) {
      setError(err as Error);
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <h2>Workflow paused: waiting for the customer</h2>
      <p className="muted small">
        Paste the customer's answer to our question or offer. The agents re-read the whole
        conversation and continue from there.
      </p>
      <form onSubmit={submit}>
        <label htmlFor="customer-reply">Customer's reply</label>
        <textarea
          id="customer-reply"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. 10 packs please, artwork attached"
        />
        <div className="row">
          <button className="btn" disabled={!text.trim() || busy}>
            {busy ? 'Resuming…' : 'Continue workflow'}
          </button>
        </div>
      </form>
      {error && <ErrorMessage error={error} />}
    </section>
  );
}
