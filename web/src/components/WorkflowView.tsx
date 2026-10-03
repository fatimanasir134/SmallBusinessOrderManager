/**
 * The AI workflow, drawn as a pipeline: Customer Message → five agents → Human Approval.
 * Each node's state comes from the order's logged agent runs, so it updates live while the
 * workflow runs (the parent polls the order).
 */
import type { AgentName, AgentRunDto, OrderDetailDto } from '@sbom/shared';

type NodeState =
  'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting' | 'approved' | 'rejected';

const STATE_LABEL: Record<NodeState, string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  skipped: 'Skipped',
  waiting: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Rejected',
};

const PIPELINE: { agent: AgentName; label: string; role: string }[] = [
  { agent: 'understanding', label: 'Order Understanding Agent', role: 'Reads the message' },
  { agent: 'pricing', label: 'Pricing Agent', role: 'Prices it with the pricing rules' },
  { agent: 'inventory', label: 'Inventory Agent', role: 'Checks real stock' },
  { agent: 'production', label: 'Production Agent', role: 'Checks capacity and deadline' },
  { agent: 'communication', label: 'Communication Agent', role: 'Drafts the reply' },
];

interface Node {
  key: string;
  label: string;
  role: string;
  state: NodeState;
  detail?: string;
  meta?: string;
  /** The route the agent chose, and the tool evidence for it. */
  route?: { name: string; reason: string; stop: boolean };
}

const routeOf = (run: AgentRunDto | undefined) => {
  const out = (run?.output ?? {}) as { route?: string; routeReason?: string };
  return out.route
    ? { name: out.route, reason: out.routeReason ?? '', stop: run!.decision === 'stop' }
    : undefined;
};

const AGENT_LABEL: Record<string, string> = Object.fromEntries(
  PIPELINE.map((p) => [p.agent, p.label.replace(' Agent', '')]),
);

export const isProcessing = (o: OrderDetailDto) =>
  o.status === 'processing' || o.status === 'received';

/** Runs of the latest analysis (approval-time runs are shown on the approval node instead). */
function latestRun(runs: AgentRunDto[]): AgentRunDto[] {
  const analysis = runs.filter((r) => r.agent !== 'order_management');
  const runId = analysis.at(-1)?.runId;
  return analysis.filter((r) => r.runId === runId);
}

export function workflowNodes(order: OrderDetailDto): Node[] {
  const runs = latestRun(order.agentRuns);
  const processing = isProcessing(order);
  const expected = processing ? (runs.at(-1)?.nextStep ?? 'understanding') : null;
  const expectedIndex = PIPELINE.findIndex((p) => p.agent === expected);
  const inbound = order.messages.find((m) => m.direction === 'inbound');

  const nodes: Node[] = [
    {
      key: 'message',
      label: 'Customer Message',
      role: inbound ? `via ${inbound.channel}` : '',
      state: 'completed',
      detail: inbound ? `“${inbound.body}”` : undefined,
    },
  ];

  // The step that routed past the skipped agents, to explain why they were skipped.
  const stopper = runs.find((r) => r.decision === 'stop' && r.agent !== 'communication');

  PIPELINE.forEach((p, i) => {
    const run = runs.find((r) => r.agent === p.agent);
    let state: NodeState;
    if (run) state = run.status === 'error' ? 'failed' : 'completed';
    else if (processing && i === expectedIndex) state = 'running';
    else if (processing && i < expectedIndex) state = 'skipped';
    else if (processing) state = 'pending';
    else state = runs.some((r) => r.status === 'error') ? 'pending' : 'skipped';

    nodes.push({
      key: p.agent,
      label: p.label,
      role: p.role,
      state,
      detail:
        run?.summary ??
        (state === 'skipped' && stopper
          ? `Skipped: ${AGENT_LABEL[stopper.agent]} routed to ${routeOf(stopper)?.name.replace(/_/g, ' ') ?? 'stop'}.`
          : undefined),
      route: routeOf(run),
      meta: run
        ? [
            run.model ?? 'rule-based',
            run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : null,
            run.verification && run.verification !== 'not_applicable' ? run.verification : null,
          ]
            .filter(Boolean)
            .join(' · ')
        : undefined,
    });
  });

  const a = order.approval;
  const approvalState: NodeState =
    a?.status === 'approved'
      ? 'approved'
      : a?.status === 'rejected'
        ? 'rejected'
        : a?.status === 'pending'
          ? 'waiting'
          : 'pending';
  nodes.push({
    key: 'approval',
    label: 'Human Approval',
    role: 'The owner approves or rejects',
    state: approvalState,
    detail:
      a?.status === 'pending'
        ? `Recommended: ${a.recommendedAction.replace('_', ' ')}. ${a.recommendationReason}`
        : a?.decidedBy
          ? `${a.status === 'approved' ? 'Approved' : 'Rejected'} by ${a.decidedBy}`
          : order.stopReason === 'agent_error'
            ? 'Not reached: an agent failed.'
            : undefined,
  });
  return nodes;
}

export function WorkflowView({ order }: { order: OrderDetailDto }) {
  const nodes = workflowNodes(order);
  return (
    <ol className="flow" aria-label="AI workflow" aria-live="polite">
      {nodes.map((n) => (
        <li key={n.key} className={`flow-node flow-${n.state}`}>
          <span className="flow-dot" aria-hidden="true">
            {n.state === 'completed' || n.state === 'approved'
              ? '✓'
              : n.state === 'failed' || n.state === 'rejected'
                ? '✕'
                : n.state === 'waiting'
                  ? '…'
                  : ''}
          </span>
          <div className="flow-body">
            <div className="flow-head">
              <b>{n.label}</b>
              <span className={`flow-state state-${n.state}`}>{STATE_LABEL[n.state]}</span>
            </div>
            {n.role && <div className="muted small">{n.role}</div>}
            {n.detail && <div className="flow-detail">{n.detail}</div>}
            {n.route && n.route.name !== 'continue' && (
              <div className={`route ${n.route.stop ? 'route-stop' : ''}`}>
                <span className="route-name">↳ route: {n.route.name.replace(/_/g, ' ')}</span>{' '}
                <span className="route-reason">{n.route.reason}</span>
              </div>
            )}
            {n.route && n.route.name === 'continue' && n.route.reason && (
              <div className="route">
                <span className="route-reason">{n.route.reason}</span>
              </div>
            )}
            {n.meta && <div className="muted small">{n.meta}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
