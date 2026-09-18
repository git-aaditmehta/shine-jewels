PRAGMA foreign_keys = ON;

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  username TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','SALESPERSON')),
  password_hash TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, username)
);

CREATE TABLE device_sessions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  last_seen_at TEXT NOT NULL,
  offline_authorization_expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, device_id)
);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL COLLATE NOCASE,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, name)
);

CREATE TABLE subcategories (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  category_id TEXT NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL COLLATE NOCASE,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (category_id, name)
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  design_code TEXT NOT NULL COLLATE NOCASE,
  category_id TEXT NOT NULL REFERENCES categories(id),
  subcategory_id TEXT NOT NULL REFERENCES subcategories(id),
  weight_mg INTEGER NOT NULL CHECK (weight_mg > 0),
  grid_image_key TEXT NOT NULL,
  detail_image_key TEXT NOT NULL,
  grid_image_size_bytes INTEGER NOT NULL CHECK (grid_image_size_bytes >= 0),
  detail_image_size_bytes INTEGER NOT NULL CHECK (detail_image_size_bytes >= 0),
  grid_image_checksum TEXT NOT NULL,
  detail_image_checksum TEXT NOT NULL,
  image_version INTEGER NOT NULL DEFAULT 1 CHECK (image_version > 0),
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  UNIQUE (organization_id, design_code),
  UNIQUE (organization_id, grid_image_key),
  UNIQUE (organization_id, detail_image_key)
);

CREATE TRIGGER products_category_matches_subcategory_insert
BEFORE INSERT ON products FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM subcategories WHERE id = NEW.subcategory_id AND category_id = NEW.category_id AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'subcategory does not belong to category'); END;
CREATE TRIGGER products_category_matches_subcategory_update
BEFORE UPDATE OF category_id, subcategory_id ON products FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM subcategories WHERE id = NEW.subcategory_id AND category_id = NEW.category_id AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'subcategory does not belong to category'); END;

CREATE TABLE vendors (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  normalized_city TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('WHOLESALE','RETAIL','CORPORATE')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  UNIQUE (organization_id, normalized_name, normalized_city)
);

CREATE TABLE presentations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  order_number INTEGER,
  vendor_id TEXT REFERENCES vendors(id),
  salesperson_id TEXT NOT NULL REFERENCES users(id),
  vendor_name_snapshot TEXT NOT NULL,
  vendor_address_snapshot TEXT NOT NULL,
  vendor_city_snapshot TEXT NOT NULL,
  vendor_type_snapshot TEXT NOT NULL CHECK (vendor_type_snapshot IN ('WHOLESALE','RETAIL','CORPORATE')),
  status TEXT NOT NULL CHECK (status IN ('DRAFT','FINALIZED')),
  generated_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((status = 'DRAFT' AND order_number IS NULL) OR (status = 'FINALIZED' AND order_number IS NOT NULL)),
  UNIQUE (organization_id, order_number)
);

CREATE TABLE presentation_items (
  id TEXT PRIMARY KEY,
  presentation_id TEXT NOT NULL REFERENCES presentations(id),
  product_id TEXT REFERENCES products(id),
  serial_number INTEGER NOT NULL CHECK (serial_number > 0),
  design_code_snapshot TEXT NOT NULL,
  category_snapshot TEXT NOT NULL,
  subcategory_snapshot TEXT NOT NULL,
  weight_mg_snapshot INTEGER NOT NULL CHECK (weight_mg_snapshot > 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0 AND quantity = CAST(quantity AS INTEGER)),
  remark TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (presentation_id, serial_number)
);

CREATE TABLE sync_changes (
  sequence_number INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('CREATE','UPDATE','DELETE','ARCHIVE','FINALIZE')),
  version INTEGER NOT NULL CHECK (version > 0),
  payload TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, entity_type, entity_id, version)
);

CREATE INDEX products_catalogue_idx ON products(organization_id, deleted_at, category_id, subcategory_id, weight_mg, design_code);
CREATE INDEX vendors_active_idx ON vendors(organization_id, deleted_at, normalized_name, normalized_city);
CREATE INDEX presentations_history_idx ON presentations(organization_id, status, generated_at DESC);
CREATE INDEX sync_changes_incremental_idx ON sync_changes(organization_id, sequence_number);
