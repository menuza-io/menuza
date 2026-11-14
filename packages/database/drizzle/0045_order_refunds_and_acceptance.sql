ALTER TABLE `OrganizationLocation` ADD `guestCancelMinutes` integer;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `guestCancelScheduledLeadMinutes` integer;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `orderAcceptanceMode` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `orderAcceptanceTimeoutMinutes` integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `orderAcceptanceMinTotalCents` integer;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `orderAcceptanceScheduledOnly` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Refunding an online order through its payment provider (Orders, order
-- detail). Built-in admins (the owner's preset) receive it. Plain members,
-- viewers and existing custom roles are deliberately NOT granted it; it can be
-- given to a custom role in the role editor. Never usable while impersonating.
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('org_perm_update_order_refund_any', 'update', 'order_refund', 'any', 'organization', 'Refund online orders through the payment provider', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_admin', 'org_perm_update_order_refund_any');
