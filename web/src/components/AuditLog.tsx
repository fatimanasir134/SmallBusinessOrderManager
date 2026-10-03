/**
 * Visual audit log: every agent step of an order in sequence, with the tools it executed, timing,
 * its structured output, and the human approval gate that guards every database write that
 * matters (stock, production capacity, confirmation, the reply sent).
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AGENT_INFO, type AgentRunDto, type OrderDetailDto, type ToolInfoDto } from '@sbom/shared';
import { formatDateTime } from '../format';
import { isProcessing } from './WorkflowView';

const ANALYSIS_ORDER = ['understanding', 'pricing', 'inventory', 'production', 'communication'];

interface ToolCall {
  name: string;
  source?: 'model' | 'backend';
  args: unknown;
  ok: boolean;
  response: { result?: unknown; error?: { code?: string; message?: string } };
  durationMs: number;
}

const secs = (ms: number | null | undefined) =>
  ms == null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;

/** Minimal JSON syntax highlighting, built from React elements (no HTML injection). */
export function JsonView({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  const parts: ReactNode[] = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) parts.push(text.slice(last, m.index));
    const cls = m[1] ? (m[2] ? 'j-key' : 'j-str') : m[3] ? 'j-lit' : 'j-num';
    parts.push(
      <span key={m.index} className={cls}>
        {m[1] ?? m[0]}
      </span>,
    );
    if (m[2]) parts.push(m[2]);
    last = m.index! + m[0].length;
  }
  parts.push(text.slice(last));
  return <pre className="json">{parts}</pre>;
}

function AccessBadge({ access }: { access: 'read' | 'write' | undefined }) {
  if (!access) return null;
  return access === 'write' ? (
    <span className="badge-db badge-db-write">writes DB</span>
  ) : (
    <span className="badge-db badge-db-read">read-only</span>
  );
}

function ToolCalls({ run, tools }: { run: AgentRunDto; tools: Map<string, ToolInfoDto> }) {
  const calls = (run.toolCalls ?? []) as ToolCall[];
  const allowed = AGENT_INFO[run.agent].tools;
  if (calls.length === 0) {
    return (
      <p className="muted small">
        No tools executed: {allowed.length ? 'allowed ' + allowed.join(', ') : 'reasoning only'}.
        {run.agent === 'understanding' && ' The backend then matches products and dates.'}
        {run.agent === 'communication' && ' The backend checks every amount against the quote.'}
      </p>
    );
  }
  return (
    <ul className="tool-calls">
      {calls.map((c, i) => (
        <li key={i} className={c.ok ? '' : 'tool-failed'}>
          <div className="tool-head">
            <code className="tool-name">{c.name}()</code>
            <AccessBadge access={tools.get(c.name)?.access} />
            <span className="muted small">
              {c.source === 'backend' ? 'run by backend' : 'called by Gemini (function calling)'}
            </span>
            <span className={`chip ${c.ok ? 'chip-matched' : 'chip-action-reject'}`}>
              {c.ok ? 'ok' : (c.response.error?.code ?? 'failed')}
            </span>
            <span className="muted small">{secs(c.durationMs)}</span>
          </div>
          {!c.ok && c.response.error?.message && (
            <div className="text-danger small">{c.response.error.message}</div>
          )}
          <details>
            <summary>Arguments and result</summary>
            <div className="small muted">Arguments</div>
            <JsonView value={c.args} />
            <div className="small muted">Result</div>
            <JsonView value={c.ok ? c.response.result : c.response.error} />
          </details>
        </li>
      ))}
    </ul>
  );
}

function AgentStep({
  run,
  step,
  tools,
  maxMs,
}: {
  run: AgentRunDto;
  step: number;
  tools: Map<string, ToolInfoDto>;
  maxMs: number;
}) {
  const info = AGENT_INFO[run.agent];
  const out = (run.output ?? {}) as {
    result?: unknown;
    discrepancies?: string[];
    reused?: boolean;
    route?: string;
    routeReason?: string;
  };
  const failed = run.status === 'error';
  return (
    <li className={`audit-step ${failed ? 'audit-step-failed' : ''}`}>
      <div className="audit-marker" aria-hidden="true">
        {step}
      </div>
      <div className="audit-card">
        <header className="audit-card-head">
          <div>
            <h3>{info.label}</h3>
            <div className="muted small">{info.role}</div>
          </div>
          <div className="audit-chips">
            <span className={`flow-state ${failed ? 'state-failed' : 'state-completed'}`}>
              {failed ? 'Failed' : 'Completed'}
            </span>
            {run.verification && run.verification !== 'not_applicable' && (
              <span className={`chip chip-${run.verification}`}>verified: {run.verification}</span>
            )}
            {out.reused && <span className="chip">reused from earlier run</span>}
          </div>
        </header>

        <div className="audit-meta">
          <span>
            <b>{secs(run.durationMs)}</b>
          </span>
          <span className="latency" aria-hidden="true">
            <span style={{ width: `${Math.max(4, ((run.durationMs ?? 0) / maxMs) * 100)}%` }} />
          </span>
          <span className="muted small">{run.model ?? 'rule-based (no AI call)'}</span>
          <span className="muted small">{formatDateTime(run.createdAt)}</span>
        </div>

        <p className="audit-summary">
          {run.summary}
          {run.nextStep && (
            <span className="muted">
              {' '}
              → {run.decision === 'stop' ? 'stop, then ' : ''}
              {run.nextStep.replace('_', ' ')}
            </span>
          )}
        </p>
        {run.error && <p className="text-danger small">{run.error}</p>}

        {out.route && (
          <div className={`routing ${run.decision === 'stop' ? 'routing-stop' : ''}`}>
            <div className="audit-section-title">Routing decision</div>
            <div>
              <b>{out.route.replace(/_/g, ' ')}</b>
              {run.nextStep && <> → next: {run.nextStep.replace(/_/g, ' ')}</>}
            </div>
            {out.routeReason && <div className="small">{out.routeReason}</div>}
          </div>
        )}

        {out.discrepancies && out.discrepancies.length > 0 && (
          <div className="alert alert-warn small">
            <b>Backend overruled the agent:</b>
            <ul>
              {out.discrepancies.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="audit-section-title">Business tools executed</div>
        <ToolCalls run={run} tools={tools} />

        {out.result !== undefined && (
          <details className="payload">
            <summary>Decision payload (structured output)</summary>
            <JsonView value={out.result} />
          </details>
        )}
        <details className="payload">
          <summary>Input</summary>
          <JsonView value={run.input} />
        </details>
      </div>
    </li>
  );
}

function ApprovalGate({ order }: { order: OrderDetailDto }) {
  const a = order.approval;
  const state =
    a?.status === 'approved'
      ? 'approved'
      : a?.status === 'rejected'
        ? 'rejected'
        : a?.status === 'pending'
          ? 'waiting'
          : 'not-reached';
  return (
    <li className={`gate gate-${state}`}>
      <div className="gate-icon" aria-hidden="true">
        {state === 'approved' ? '✓' : state === 'rejected' ? '✕' : '🔒'}
      </div>
      <div>
        <div className="gate-kicker">Human approval gate</div>
        {state === 'waiting' && (
          <>
            <h3>Waiting for a person: nothing has been committed</h3>
            <p>
              No stock reserved, no production booked, no order confirmed, and no reply sent. These
              database writes happen only after APPROVE.
            </p>
            <p className="small">
              Recommended: <b>{a!.recommendedAction.replace('_', ' ')}</b> · {a!.warningCount}{' '}
              warning(s) · <Link to={`/orders/${order.id}`}>Open the approval screen →</Link>
            </p>
          </>
        )}
        {state === 'approved' && (
          <>
            <h3>
              Approved by {a!.decidedBy} · {formatDateTime(a!.decidedAt)}
            </h3>
            {a!.decisionNote && <p>“{a!.decisionNote}”</p>}
            <p className="small">
              Reply {a!.replyEdited ? 'edited by the person, then sent' : 'sent as drafted'}.
            </p>
          </>
        )}
        {state === 'rejected' && (
          <>
            <h3>
              Rejected by {a!.decidedBy} · {formatDateTime(a!.decidedAt)}
            </h3>
            <p>No order confirmed; stock and production untouched.</p>
          </>
        )}
        {state === 'not-reached' && (
          <h3 className="muted">
            {order.stopReason === 'agent_error'
              ? 'Not reached: an agent failed. Nothing was committed.'
              : 'Not reached yet'}
          </h3>
        )}
      </div>
    </li>
  );
}

function CommittedWrites({ order, omRun }: { order: OrderDetailDto; omRun?: AgentRunDto }) {
  const call = ((omRun?.toolCalls ?? []) as ToolCall[]).find(
    (c) => c.name === 'updateOrderStatus' && c.ok,
  );
  const effects = (call?.response.result as { effects?: Record<string, unknown> } | undefined)
    ?.effects as
    | {
        reserved?: { productId: number; quantity: number }[];
        productionBooked?: { day: string; minutes: number }[];
        promisedDate?: string;
      }
    | undefined;
  const sku = (id: number) => order.items.find((i) => i.productId === id)?.sku ?? `#${id}`;
  const sent = order.messages.filter((m) => m.direction === 'outbound').at(-1);
  return (
    <li className="audit-step">
      <div className="audit-marker audit-marker-db" aria-hidden="true">
        DB
      </div>
      <div className="audit-card audit-card-db">
        <h3>Database writes committed after approval</h3>
        <ul className="kv">
          <li>
            <span>Order</span> status →{' '}
            <b>
              {order.history.some((h) => h.toStatus === 'confirmed') ? 'confirmed' : order.status}
            </b>
          </li>
          <li>
            <span>Stock</span>{' '}
            {effects?.reserved?.length
              ? effects.reserved
                  .map((r) => `${r.quantity} × ${sku(r.productId)} reserved`)
                  .join(', ')
              : 'nothing to reserve'}
          </li>
          <li>
            <span>Production</span>{' '}
            {effects?.productionBooked?.length
              ? effects.productionBooked.map((b) => `${b.minutes} min on ${b.day}`).join(', ')
              : 'none needed'}
          </li>
          <li>
            <span>Promised</span> {effects?.promisedDate ?? order.promisedDate ?? '—'}
          </li>
          <li>
            <span>Reply</span>{' '}
            {sent ? `logged as sent via ${sent.channel} (${formatDateTime(sent.createdAt)})` : '—'}
          </li>
        </ul>
      </div>
    </li>
  );
}

export function AuditLog({ order, tools }: { order: OrderDetailDto; tools: ToolInfoDto[] }) {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const analysis = order.agentRuns.filter((r) => r.agent !== 'order_management');
  const approvalRuns = order.agentRuns.filter((r) => r.agent === 'order_management');
  const runIds = [...new Set(analysis.map((r) => r.runId))];
  const maxMs = Math.max(1, ...order.agentRuns.map((r) => r.durationMs ?? 0));
  const inbound = order.messages.find((m) => m.direction === 'inbound');
  const processing = isProcessing(order);
  const latest = analysis.filter((r) => r.runId === runIds.at(-1));
  const nextAgent = processing ? (latest.at(-1)?.nextStep ?? 'understanding') : null;

  const totalMs = order.agentRuns.reduce((s, r) => s + (r.durationMs ?? 0), 0);
  const toolCount = order.agentRuns.reduce((s, r) => s + (r.toolCalls?.length ?? 0), 0);
  const overruled = order.agentRuns.filter(
    (r) => r.verification === 'corrected' || r.verification === 'recomputed',
  ).length;
  let step = 0;

  return (
    <>
      <section className="kpis audit-stats" aria-label="Run summary">
        <div className="kpi">
          <span className="kpi-value">{order.agentRuns.length}</span>
          <span className="kpi-label">agent steps</span>
        </div>
        <div className="kpi">
          <span className="kpi-value">{toolCount}</span>
          <span className="kpi-label">business tools executed</span>
        </div>
        <div className="kpi">
          <span className="kpi-value">{secs(totalMs)}</span>
          <span className="kpi-label">total agent time</span>
        </div>
        <div className={`kpi ${overruled ? 'kpi-warn' : ''}`}>
          <span className="kpi-value">{overruled}</span>
          <span className="kpi-label">agent outputs overruled</span>
        </div>
      </section>

      <ol className="audit">
        {inbound && (
          <li className="audit-step">
            <div className="audit-marker" aria-hidden="true">
              ✉
            </div>
            <div className="audit-card">
              <h3>Customer message received</h3>
              <div className="muted small">
                via {inbound.channel} · {formatDateTime(inbound.createdAt)}
              </div>
              <blockquote className="quote">{inbound.body}</blockquote>
            </div>
          </li>
        )}

        <li className="audit-phase">
          AI analysis · agents use read-only business tools; only the draft order (items, quote,
          draft reply) is saved
        </li>

        {runIds.map((runId, i) => (
          <RunGroup
            key={runId ?? i}
            label={runIds.length > 1 ? `Run ${i + 1} of ${runIds.length}` : null}
          >
            {analysis
              .filter((r) => r.runId === runId)
              .sort(
                (a, b) =>
                  ANALYSIS_ORDER.indexOf(a.agent) - ANALYSIS_ORDER.indexOf(b.agent) || a.id - b.id,
              )
              .map((r) => (
                <AgentStep key={r.id} run={r} step={++step} tools={toolMap} maxMs={maxMs} />
              ))}
          </RunGroup>
        ))}

        {nextAgent && AGENT_INFO[nextAgent as keyof typeof AGENT_INFO] && (
          <li className="audit-step">
            <div className="audit-marker audit-marker-running" aria-hidden="true" />
            <div className="audit-card audit-card-running">
              <h3>{AGENT_INFO[nextAgent as keyof typeof AGENT_INFO].label}: running…</h3>
              <div className="muted small">
                {AGENT_INFO[nextAgent as keyof typeof AGENT_INFO].role}
              </div>
            </div>
          </li>
        )}

        <ApprovalGate order={order} />

        {approvalRuns.length > 0 && (
          <li className="audit-phase audit-phase-write">
            After approval · the only steps allowed to write stock, capacity, and the order status
          </li>
        )}
        {approvalRuns.map((r) => (
          <AgentStep key={r.id} run={r} step={++step} tools={toolMap} maxMs={maxMs} />
        ))}
        {order.approval?.status === 'approved' && (
          <CommittedWrites
            order={order}
            omRun={approvalRuns.filter((r) => r.status === 'ok').at(-1)}
          />
        )}
      </ol>

      <section className="card">
        <h2>Status history</h2>
        <ol className="history">
          {order.history.map((h) => (
            <li key={h.id}>
              <span className={`actor actor-${h.actor}`}>{h.actor}</span>
              <span>
                {h.fromStatus ? `${h.fromStatus.replace(/_/g, ' ')} → ` : ''}
                <b>{h.toStatus.replace(/_/g, ' ')}</b>
                {h.note && <span className="muted"> · {h.note}</span>}
              </span>
              <span className="muted small">{formatDateTime(h.createdAt)}</span>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

function RunGroup({ label, children }: { label: string | null; children: ReactNode }) {
  return (
    <>
      {label && <li className="audit-run-label">{label}</li>}
      {children}
    </>
  );
}
