-- Inventory permissions, org_role_admin grants, and system-level false feature flags
-- (inventory.enabled, inventory.purchasing, inventory.recipes, inventory.prep, inventory.transfers).
-- Existing custom roles and org_role_member are deliberately NOT granted anything;
-- every inventory surface is also behind the org-level inventory.* feature flags.
-- All stock, counts, waste, deliveries and suppliers live in the regional tenant
-- database; the control plane keeps only these flags and permissions.
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('org_perm_read_inventory_any', 'read', 'inventory', 'any', 'organization', 'View stock, counts, waste, and deliveries (quantities only)', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_inventory_any', 'update', 'inventory', 'any', 'organization', 'Edit items and storage areas, count stock, log waste, and record deliveries', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_read_inventory_cost_any', 'read', 'inventory_cost', 'any', 'organization', 'View inventory costs, stock value, food cost, and waste cost', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_inventory_purchasing_any', 'update', 'inventory_purchasing', 'any', 'organization', 'Manage suppliers, prices, and orders, and mark deliveries paid', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_inventory_recipe_any', 'update', 'inventory_recipe', 'any', 'organization', 'Edit dish recipes, typed costs, and sold out settings', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_admin', 'org_perm_read_inventory_any'),
	('org_role_admin', 'org_perm_update_inventory_any'),
	('org_role_admin', 'org_perm_read_inventory_cost_any'),
	('org_role_admin', 'org_perm_update_inventory_purchasing_any'),
	('org_role_admin', 'org_perm_update_inventory_recipe_any');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'inventory.enabled', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'inventory.enabled' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'inventory.purchasing', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'inventory.purchasing' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'inventory.recipes', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'inventory.recipes' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'inventory.prep', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'inventory.prep' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'inventory.transfers', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'inventory.transfers' AND "level" = 'system');
