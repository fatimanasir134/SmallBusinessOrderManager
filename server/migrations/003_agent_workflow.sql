-- Multi-agent workflow: final agent names, richer per-step logging, and workflow results on orders.

-- Agent names now match the agents in server/src/agents.
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_agent_check;
UPDATE agent_runs SET agent = 'understanding' WHERE agent = 'intake';
UPDATE agent_runs SET agent = 'communication' WHERE agent = 'response';
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_agent_check CHECK (
  agent IN ('understanding', 'pricing', 'inventory', 'production', 'communication', 'order_management')
);

-- What the dashboard shows per step: which run, what the agent decided, and what happened next.
ALTER TABLE agent_runs
  ADD COLUMN run_id     UUID,
  ADD COLUMN decision   TEXT CHECK (decision IN ('continue', 'stop')),
  ADD COLUMN summary    TEXT,
  ADD COLUMN next_step  TEXT,
  ADD COLUMN model      TEXT,
  -- How the backend checked the agent's claims against the tools: matched, corrected, recomputed.
  ADD COLUMN verification TEXT;
CREATE INDEX agent_runs_run_idx ON agent_runs (run_id);

ALTER TABLE orders
  -- Why the workflow stopped short of approval (missing_info, unknown_product, ...), if it did.
  ADD COLUMN stop_reason          TEXT,
  -- Customer's customization request (design, colours, personalisation).
  ADD COLUMN customization        TEXT,
  -- Production agent's estimate, before anything is booked.
  ADD COLUMN estimated_completion DATE;
