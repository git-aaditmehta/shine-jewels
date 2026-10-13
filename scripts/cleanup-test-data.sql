-- Shine Jewels: Production Database Reset for Client Handover
-- Preserves: organizations, admin users, categories, subcategories, and vendors
-- Cleans: test products, test orders, order items, sync changes, test staff, device sessions

PRAGMA foreign_keys = OFF;

DELETE FROM presentation_items;
DELETE FROM presentations;

UPDATE order_counters SET next_order_number = 1, updated_at = CURRENT_TIMESTAMP;

DELETE FROM sync_changes;
DELETE FROM device_sessions;
DELETE FROM products;
DELETE FROM users WHERE role = 'SALESPERSON';

PRAGMA foreign_keys = ON;
