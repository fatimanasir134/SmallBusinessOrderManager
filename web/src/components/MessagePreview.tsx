import type { Channel, OrderDetailDto } from '@sbom/shared';
import { formatCents, formatDate } from '../format';

export const BUSINESS = { name: 'Petal & Ink Studio', email: 'hello@petalandink.example' };

export type PreviewFormat = 'whatsapp' | 'sms' | 'instagram' | 'email';

export const FORMAT_LABELS: Record<PreviewFormat, string> = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  instagram: 'Instagram DM',
  email: 'Email',
};

/** How a message on each channel is delivered (walk-in customers get an email receipt). */
export function formatForChannel(channel: Channel): PreviewFormat {
  if (channel === 'whatsapp' || channel === 'sms' || channel === 'instagram') return channel;
  return 'email';
}

const shortDate = (day: string | null) =>
  day
    ? new Date(`${day}T12:00:00`).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      })
    : null;

/** Order summary lines for chat channels. WhatsApp renders *text* as bold. */
function chatSummary(order: OrderDetailDto, bold: boolean): string | null {
  if (order.status !== 'confirmed' || order.items.length === 0) return null;
  const b = (t: string) => (bold ? `*${t}*` : t);
  const ready = shortDate(order.promisedDate ?? order.estimatedCompletion);
  return [
    `${b(`Order #${order.id} confirmed`)} ✅`,
    ...order.items.map((i) => `• ${i.quantity} × ${i.productName}`),
    `Total: ${b(formatCents(order.totalCents))}`,
    ...(ready ? [`Ready: ${ready}`] : []),
  ].join('\n');
}

/** Render WhatsApp-style *bold* and _italic_ markers. */
function WhatsAppText({ text }: { text: string }) {
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('*') && p.endsWith('*') && p.length > 2 ? (
          <strong key={i}>{p.slice(1, -1)}</strong>
        ) : p.startsWith('_') && p.endsWith('_') && p.length > 2 ? (
          <em key={i}>{p.slice(1, -1)}</em>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

interface PreviewProps {
  format: PreviewFormat;
  order: OrderDetailDto;
  reply: string;
  sentAt: Date;
}

export function MessagePreview(props: PreviewProps) {
  return props.format === 'email' ? <EmailPreview {...props} /> : <ChatPreview {...props} />;
}

function ChatPreview({ format, order, reply, sentAt }: PreviewProps) {
  const time = sentAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const summary = chatSummary(order, format === 'whatsapp');
  const customer = order.customer;
  const contact =
    format === 'instagram'
      ? `@${(customer?.name ?? 'customer').toLowerCase().replace(/[^a-z0-9]+/g, '.')}`
      : (customer?.phone ?? 'No phone on file');
  const bubbles = summary ? [reply, summary] : [reply];

  return (
    <div className={`chat chat-${format}`} aria-label={`${FORMAT_LABELS[format]} message preview`}>
      <div className="chat-header">
        <span className="chat-avatar" aria-hidden="true">
          {(customer?.name ?? '?').slice(0, 1)}
        </span>
        <div>
          <div className="chat-title">{customer?.name ?? 'Customer'}</div>
          <div className="chat-sub">{contact}</div>
        </div>
      </div>
      <div className="chat-body">
        <div className="chat-day">Today</div>
        {bubbles.map((text, i) => (
          <div key={i} className="bubble bubble-out">
            <div className="bubble-text">
              {format === 'whatsapp' ? <WhatsAppText text={text} /> : text}
            </div>
            <div className="bubble-meta">
              {time}
              {format === 'whatsapp' && (
                <span className="ticks" aria-label="Delivered">
                  {' '}
                  ✓✓
                </span>
              )}
            </div>
          </div>
        ))}
        {format === 'sms' && <div className="chat-status">Delivered</div>}
        {format === 'instagram' && <div className="chat-status">Seen just now</div>}
      </div>
    </div>
  );
}

function EmailPreview({ order, reply, sentAt }: PreviewProps) {
  const confirmed = order.status === 'confirmed';
  const customer = order.customer;
  const subject = confirmed
    ? `Your order #${order.id} is confirmed – ${BUSINESS.name}`
    : `About your order request – ${BUSINESS.name}`;
  const paragraphs = reply.split(/\n\s*\n|\n/).filter((p) => p.trim());
  // Exact amounts from the verified quote in the approval request.
  const pricing = order.approval?.packet.pricing;
  const ready = order.promisedDate ?? order.estimatedCompletion;

  return (
    <article className="email" aria-label="Email preview">
      <dl className="email-head">
        <dt>From</dt>
        <dd>
          {BUSINESS.name} &lt;{BUSINESS.email}&gt;
        </dd>
        <dt>To</dt>
        <dd>
          {customer?.name ?? 'Customer'}{' '}
          {customer?.email ? <>&lt;{customer.email}&gt;</> : <em>(no email on file)</em>}
        </dd>
        <dt>Subject</dt>
        <dd>
          <strong>{subject}</strong>
        </dd>
        <dt>Sent</dt>
        <dd>{sentAt.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</dd>
      </dl>
      <div className="email-body">
        <div className="email-brand">{BUSINESS.name}</div>
        {paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
        {confirmed && order.items.length > 0 && (
          <table className="email-summary">
            <caption>Order #{order.id} summary</caption>
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Qty</th>
                <th className="num">Price</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((i) => (
                <tr key={i.id}>
                  <td>{i.productName}</td>
                  <td className="num">{i.quantity}</td>
                  <td className="num">{formatCents(i.lineTotalCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              {pricing && pricing.discountCents > 0 && (
                <tr>
                  <td colSpan={2}>Discount</td>
                  <td className="num">−{formatCents(pricing.discountCents)}</td>
                </tr>
              )}
              {pricing && pricing.surchargeCents > 0 && (
                <tr>
                  <td colSpan={2}>Rush surcharge</td>
                  <td className="num">+{formatCents(pricing.surchargeCents)}</td>
                </tr>
              )}
              <tr className="email-total">
                <td colSpan={2}>Total</td>
                <td className="num">{formatCents(order.totalCents)}</td>
              </tr>
              {ready && (
                <tr>
                  <td colSpan={3} className="muted small">
                    Ready by {formatDate(`${ready}T12:00:00`)}
                  </td>
                </tr>
              )}
            </tfoot>
          </table>
        )}
        <p className="email-footer">
          {BUSINESS.name} · Handmade stickers & stationery · Reply to this email with any questions.
        </p>
      </div>
    </article>
  );
}
