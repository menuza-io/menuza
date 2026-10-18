-- Reservations platform fee default: 250 basis points (2.50%), stored as a JSON integer.
-- The mission docs said 0; the product owner decided on 250. Idempotent via NOT EXISTS.
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'reservations.platform_fee_bp', '250', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'reservations.platform_fee_bp' AND "level" = 'system');
