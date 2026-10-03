-- Restocking: every delivery of stock received by a person, for the audit trail.
CREATE TABLE stock_receipts (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  -- Stock level right after this receipt, so the history reads without recomputing.
  on_hand_after  INTEGER NOT NULL CHECK (on_hand_after >= 0),
  received_by    TEXT NOT NULL,
  note           TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stock_receipts_recent_idx ON stock_receipts (created_at DESC);
