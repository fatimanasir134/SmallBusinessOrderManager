-- Duplicate-order protection: a client-supplied key makes "submit" safe to retry or double-click.
ALTER TABLE orders ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX orders_idempotency_key_idx ON orders (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
