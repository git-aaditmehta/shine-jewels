CREATE TABLE order_counters (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
  next_order_number INTEGER NOT NULL DEFAULT 1 CHECK (next_order_number > 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
