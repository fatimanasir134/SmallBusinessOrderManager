-- Human-in-the-loop approval: one record per analysis handed to a person, and their decision.
-- This is the audit trail for "who approved/rejected what, when, why, and what was sent".

CREATE TABLE approval_requests (
  id                     INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id               INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- Workflow run that produced this analysis (agent_runs.run_id).
  run_id                 UUID,
  status                 TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  -- Everything the person saw: customer, items, price, stock, timing, reply, warnings.
  packet                 JSONB NOT NULL,
  recommended_action     TEXT NOT NULL
                         CHECK (recommended_action IN ('approve', 'review', 'reject', 'request_info')),
  recommendation_reason  TEXT NOT NULL,
  warning_count          INTEGER NOT NULL DEFAULT 0,
  draft_reply            TEXT,
  -- The decision.
  decided_by             TEXT,
  decided_at             TIMESTAMPTZ,
  decision_note          TEXT,
  final_reply            TEXT,
  reply_sent             BOOLEAN,
  -- True when the person changed the AI's draft before sending.
  reply_edited           BOOLEAN,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT approval_requests_decision_recorded CHECK (
    (status IN ('approved', 'rejected')) = (decided_at IS NOT NULL AND decided_by IS NOT NULL)
  )
);

-- At most one open request per order.
CREATE UNIQUE INDEX approval_requests_one_pending ON approval_requests (order_id)
  WHERE status = 'pending';
CREATE INDEX approval_requests_queue_idx ON approval_requests (status, created_at);
