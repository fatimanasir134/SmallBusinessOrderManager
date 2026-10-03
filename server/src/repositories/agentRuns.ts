import type { AgentName, AgentRunDto, Verification } from '@sbom/shared';
import { type Db, query, queryOne } from '../db/client.js';

interface AgentRunRow {
  id: number;
  order_id: number;
  agent: AgentName;
  status: 'ok' | 'error';
  input: unknown;
  output: unknown;
  tool_calls: unknown[];
  error: string | null;
  duration_ms: number | null;
  run_id: string | null;
  decision: 'continue' | 'stop' | null;
  summary: string | null;
  next_step: string | null;
  model: string | null;
  verification: Verification | null;
  created_at: string;
}

const toDto = (r: AgentRunRow): AgentRunDto => ({
  id: r.id,
  orderId: r.order_id,
  agent: r.agent,
  status: r.status,
  input: r.input,
  output: r.output,
  toolCalls: r.tool_calls,
  error: r.error,
  durationMs: r.duration_ms,
  runId: r.run_id,
  decision: r.decision,
  summary: r.summary,
  nextStep: r.next_step,
  model: r.model,
  verification: r.verification,
  createdAt: r.created_at,
});

export interface NewAgentRun {
  orderId: number;
  agent: AgentName;
  status: 'ok' | 'error';
  input?: unknown;
  output?: unknown;
  toolCalls?: unknown[];
  error?: string | null;
  durationMs?: number | null;
  runId?: string | null;
  decision?: 'continue' | 'stop' | null;
  summary?: string | null;
  nextStep?: string | null;
  model?: string | null;
  verification?: Verification | null;
}

export async function recordAgentRun(run: NewAgentRun, db?: Db): Promise<AgentRunDto> {
  const row = await queryOne<AgentRunRow>(
    `INSERT INTO agent_runs (order_id, agent, status, input, output, tool_calls, error, duration_ms,
                             run_id, decision, summary, next_step, model, verification)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      run.orderId,
      run.agent,
      run.status,
      JSON.stringify(run.input ?? null),
      JSON.stringify(run.output ?? null),
      JSON.stringify(run.toolCalls ?? []),
      run.error ?? null,
      run.durationMs ?? null,
      run.runId ?? null,
      run.decision ?? null,
      run.summary ?? null,
      run.nextStep ?? null,
      run.model ?? null,
      run.verification ?? null,
    ],
    db,
  );
  return toDto(row!);
}

export async function listAgentRunsForOrder(orderId: number, db?: Db): Promise<AgentRunDto[]> {
  const rows = await query<AgentRunRow>(
    'SELECT * FROM agent_runs WHERE order_id = $1 ORDER BY created_at, id',
    [orderId],
    db,
  );
  return rows.map(toDto);
}

/** Steps of the most recent workflow run for an order. */
export async function listLatestRunSteps(orderId: number, db?: Db): Promise<AgentRunDto[]> {
  const rows = await query<AgentRunRow>(
    `SELECT * FROM agent_runs
     WHERE order_id = $1
       AND run_id = (SELECT run_id FROM agent_runs WHERE order_id = $1 AND run_id IS NOT NULL
                     ORDER BY created_at DESC, id DESC LIMIT 1)
     ORDER BY created_at, id`,
    [orderId],
    db,
  );
  return rows.map(toDto);
}
