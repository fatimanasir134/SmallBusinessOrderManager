-- Track what each approved order holds, so cancelling it releases exactly that.

-- Units of each line taken from stock (the rest is produced).
ALTER TABLE order_items
  ADD COLUMN reserved_quantity INTEGER NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
  ADD CONSTRAINT order_items_reserved_within_quantity CHECK (reserved_quantity <= quantity);

-- Production minutes booked per day for an order.
CREATE TABLE production_bookings (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  day         DATE NOT NULL REFERENCES production_capacity(day),
  minutes     INTEGER NOT NULL CHECK (minutes > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX production_bookings_order_idx ON production_bookings (order_id);
