-- Initial schema for the Small Business Order Manager.
-- Conventions: money is stored in integer cents, percentages as NUMERIC(5,2),
-- business dates (deadlines, capacity days) as DATE, and audit timestamps as TIMESTAMPTZ.

-- ---------- Customers ----------
CREATE TABLE customers (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  -- Where this customer usually messages from.
  channel     TEXT NOT NULL DEFAULT 'email'
              CHECK (channel IN ('email', 'instagram', 'whatsapp', 'sms', 'walk_in')),
  -- Drives tier-based pricing rules.
  tier        TEXT NOT NULL DEFAULT 'standard'
              CHECK (tier IN ('standard', 'loyal', 'wholesale')),
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Emails are unique regardless of case (Ayesha@x.com = ayesha@x.com).
CREATE UNIQUE INDEX customers_email_lower_idx ON customers (lower(email));

-- ---------- Products and inventory ----------
CREATE TABLE products (
  id                           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku                          TEXT NOT NULL UNIQUE,
  name                         TEXT NOT NULL,
  description                  TEXT NOT NULL DEFAULT '',
  category                     TEXT NOT NULL DEFAULT 'general',
  unit_price_cents             INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  -- Minutes of studio time needed to make one unit when stock runs short.
  production_minutes_per_unit  INTEGER NOT NULL DEFAULT 0 CHECK (production_minutes_per_unit >= 0),
  -- Made-to-order products are never stocked; every unit goes through production.
  made_to_order                BOOLEAN NOT NULL DEFAULT false,
  active                       BOOLEAN NOT NULL DEFAULT true,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per product. Stock is reserved when an order is approved and
-- deducted from on_hand when the order is completed.
CREATE TABLE inventory (
  product_id     INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  on_hand        INTEGER NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved       INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  available      INTEGER GENERATED ALWAYS AS (on_hand - reserved) STORED,
  reorder_point  INTEGER NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inventory_reserved_within_on_hand CHECK (reserved <= on_hand)
);

-- ---------- Pricing ----------
-- volume_discount         percent off when an order line (or the whole order, if product_id is null)
--                         reaches min_quantity units
-- customer_tier_discount  percent off for customers in customer_tier
-- rush_surcharge          percent added when the deadline is within max_days_until_deadline days
-- max_discount            cap on the combined discount percent
CREATE TABLE pricing_rules (
  id                       INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                     TEXT NOT NULL,
  description              TEXT NOT NULL DEFAULT '',
  rule_type                TEXT NOT NULL
                           CHECK (rule_type IN ('volume_discount', 'customer_tier_discount',
                                                'rush_surcharge', 'max_discount')),
  product_id               INTEGER REFERENCES products(id) ON DELETE CASCADE,
  customer_tier            TEXT CHECK (customer_tier IN ('standard', 'loyal', 'wholesale')),
  min_quantity             INTEGER CHECK (min_quantity > 0),
  max_days_until_deadline  INTEGER CHECK (max_days_until_deadline >= 0),
  percent                  NUMERIC(5, 2) NOT NULL CHECK (percent BETWEEN 0 AND 100),
  active                   BOOLEAN NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pricing_rules_fields_match_type CHECK (
    (rule_type <> 'volume_discount'        OR min_quantity IS NOT NULL) AND
    (rule_type <> 'customer_tier_discount' OR customer_tier IS NOT NULL) AND
    (rule_type <> 'rush_surcharge'         OR max_days_until_deadline IS NOT NULL)
  )
);

-- ---------- Production capacity ----------
CREATE TABLE production_capacity (
  day               DATE PRIMARY KEY,
  capacity_minutes  INTEGER NOT NULL CHECK (capacity_minutes >= 0),
  booked_minutes    INTEGER NOT NULL DEFAULT 0 CHECK (booked_minutes >= 0),
  CONSTRAINT production_capacity_not_overbooked CHECK (booked_minutes <= capacity_minutes)
);

-- ---------- Orders ----------
CREATE TABLE orders (
  id                  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id         INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'received'
                      CHECK (status IN ('received', 'processing', 'needs_info', 'needs_review',
                                        'awaiting_approval', 'confirmed', 'rejected',
                                        'in_production', 'ready', 'completed', 'cancelled')),
  -- What the customer asked for, and what we committed to.
  requested_deadline  DATE,
  promised_date       DATE,
  subtotal_cents      INTEGER CHECK (subtotal_cents >= 0),
  discount_percent    NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  surcharge_percent   NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (surcharge_percent BETWEEN 0 AND 100),
  total_cents         INTEGER CHECK (total_cents >= 0),
  draft_reply         TEXT,
  final_reply         TEXT,
  notes               TEXT NOT NULL DEFAULT '',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_status_idx ON orders (status);
CREATE INDEX orders_customer_idx ON orders (customer_id);

CREATE TABLE order_items (
  id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id          INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id        INTEGER NOT NULL REFERENCES products(id),
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  -- Price is copied at order time so later catalogue changes don't rewrite history.
  unit_price_cents  INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents  INTEGER GENERATED ALWAYS AS (quantity * unit_price_cents) STORED,
  UNIQUE (order_id, product_id)
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

-- Audit trail: one row per status change, including the initial 'received'.
CREATE TABLE order_status_history (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  actor        TEXT NOT NULL CHECK (actor IN ('system', 'agent', 'human')),
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_status_history_order_idx ON order_status_history (order_id, created_at);

-- ---------- Messages and AI trace ----------
CREATE TABLE messages (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id  INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  order_id     INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  channel      TEXT NOT NULL DEFAULT 'email'
               CHECK (channel IN ('email', 'instagram', 'whatsapp', 'sms', 'walk_in')),
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX messages_order_idx ON messages (order_id);

-- One row per agent step, so the UI can show how the AI reached its result.
CREATE TABLE agent_runs (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  agent        TEXT NOT NULL CHECK (agent IN ('intake', 'pricing', 'inventory', 'production', 'response')),
  status       TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  input        JSONB,
  output       JSONB,
  tool_calls   JSONB NOT NULL DEFAULT '[]',
  error        TEXT,
  duration_ms  INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_runs_order_idx ON agent_runs (order_id, created_at);
