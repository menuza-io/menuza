CREATE TABLE `OrganizationInvitationLocation` (
	`invitationId` text NOT NULL,
	`locationId` text NOT NULL,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`invitationId`, `locationId`),
	FOREIGN KEY (`invitationId`) REFERENCES `OrganizationInvitation`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`locationId`) REFERENCES `OrganizationLocation`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationInvitationLocation_locationId_idx` ON `OrganizationInvitationLocation` (`locationId`);--> statement-breakpoint
ALTER TABLE `OrganizationInvitation` ADD `locationScope` text DEFAULT 'all' NOT NULL;--> statement-breakpoint
-- Location managers (#126): one permission, no flag. It is granted to the
-- built-in admin role here; a "General manager" role is made from the preset in
-- Settings, Roles. A role carrying it can invite, change and remove members
-- whose locations lie inside the holder's own.
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('org_perm_update_member_own_locations', 'update', 'member', 'own_locations', 'organization', 'Invite, change and remove team members at your own locations only', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_admin', 'org_perm_update_member_own_locations');
