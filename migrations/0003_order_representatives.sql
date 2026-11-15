-- Vendor representatives (name + phone) typed on an order, kept with the order so every device and every PDF shows them.
-- JSON array of {"name","phone"}; NULL for orders made before this column existed.
ALTER TABLE presentations ADD COLUMN representatives_json TEXT;
