-- Rebuilding a table is the only way SQLite changes a foreign key. Migrations
-- run in a transaction (D1 and the LibSQL migrator), where foreign_keys cannot
-- be turned off, so checks are deferred to the commit instead (as in 0027).
-- No table references OrganizationInvitation, SSOSession or SSOIdentity, so
-- dropping them cascades nothing.
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
-- OrganizationInvitation.organizationRoleId: RESTRICT -> CASCADE, so deleting
-- an organization (which cascades to its custom roles) is not blocked by a
-- pending invitation on one of them. Deleting a role that still has
-- invitations is refused in code instead.
CREATE TABLE `__new_OrganizationInvitation` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`organizationRoleId` text NOT NULL,
	`token` text NOT NULL,
	`expiresAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`organizationId` text NOT NULL,
	`inviterId` text,
	`staffMemberId` text,
	FOREIGN KEY (`organizationRoleId`) REFERENCES `OrganizationRole`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`inviterId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_OrganizationInvitation`("id", "email", "organizationRoleId", "token", "expiresAt", "createdAt", "updatedAt", "organizationId", "inviterId", "staffMemberId") SELECT "id", "email", "organizationRoleId", "token", "expiresAt", "createdAt", "updatedAt", "organizationId", "inviterId", "staffMemberId" FROM `OrganizationInvitation`;--> statement-breakpoint
DROP TABLE `OrganizationInvitation`;--> statement-breakpoint
ALTER TABLE `__new_OrganizationInvitation` RENAME TO `OrganizationInvitation`;--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationInvitation_email_organizationId_key` ON `OrganizationInvitation` (`email`,`organizationId`);--> statement-breakpoint
CREATE INDEX `OrganizationInvitation_organizationRoleId_idx` ON `OrganizationInvitation` (`organizationRoleId`);--> statement-breakpoint
CREATE INDEX `OrganizationInvitation_organizationId_idx` ON `OrganizationInvitation` (`organizationId`);--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationInvitation_token_key` ON `OrganizationInvitation` (`token`);--> statement-breakpoint
-- Dropping the table dropped its triggers (from 0012); recreate them.
CREATE TRIGGER `OrganizationInvitation_organizationRole_same_organization_insert`
BEFORE INSERT ON `OrganizationInvitation`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1
	FROM `OrganizationRole`
	WHERE `id` = NEW.`organizationRoleId`
		AND `organizationId` IS NOT NULL
		AND `organizationId` <> NEW.`organizationId`
)
BEGIN
	SELECT RAISE(ABORT, 'Organization role belongs to a different organization');
END;--> statement-breakpoint
CREATE TRIGGER `OrganizationInvitation_organizationRole_same_organization_update`
BEFORE UPDATE OF `organizationRoleId`, `organizationId` ON `OrganizationInvitation`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1
	FROM `OrganizationRole`
	WHERE `id` = NEW.`organizationRoleId`
		AND `organizationId` IS NOT NULL
		AND `organizationId` <> NEW.`organizationId`
)
BEGIN
	SELECT RAISE(ABORT, 'Organization role belongs to a different organization');
END;--> statement-breakpoint
-- SSOSession.ssoConfigId: RESTRICT -> CASCADE, so deleting an organization
-- (which cascades to its SSO configuration) is not blocked by a live SSO
-- session. The Session row itself is not touched.
CREATE TABLE `__new_SSOSession` (
	`id` text PRIMARY KEY NOT NULL,
	`sessionId` text NOT NULL,
	`ssoConfigId` text NOT NULL,
	`providerUserId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`tokenExpiresAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`ssoConfigId`) REFERENCES `SSOConfiguration`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_SSOSession`("id", "sessionId", "ssoConfigId", "providerUserId", "accessToken", "refreshToken", "tokenExpiresAt", "createdAt", "updatedAt") SELECT "id", "sessionId", "ssoConfigId", "providerUserId", "accessToken", "refreshToken", "tokenExpiresAt", "createdAt", "updatedAt" FROM `SSOSession`;--> statement-breakpoint
DROP TABLE `SSOSession`;--> statement-breakpoint
ALTER TABLE `__new_SSOSession` RENAME TO `SSOSession`;--> statement-breakpoint
CREATE INDEX `SSOSession_providerUserId_idx` ON `SSOSession` (`providerUserId`);--> statement-breakpoint
CREATE INDEX `SSOSession_ssoConfigId_idx` ON `SSOSession` (`ssoConfigId`);--> statement-breakpoint
CREATE UNIQUE INDEX `SSOSession_sessionId_key` ON `SSOSession` (`sessionId`);--> statement-breakpoint
-- SSOIdentity is scoped to one SSO configuration instead of the issuer: IdPs
-- such as Entra ID send a pairwise `sub` per application (client id). A link
-- made under an issuer is kept for each configuration with that issuer whose
-- organization the user belongs to; any other link is dropped and is made
-- again on the user's next SSO sign-in.
CREATE TABLE `__new_SSOIdentity` (
	`id` text PRIMARY KEY NOT NULL,
	`ssoConfigId` text NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`userId` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`ssoConfigId`) REFERENCES `SSOConfiguration`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_SSOIdentity`("id", "ssoConfigId", "issuer", "subject", "userId", "createdAt")
SELECT lower(hex(randomblob(16))), `c`.`id`, `i`.`issuer`, `i`.`subject`, `i`.`userId`, `i`.`createdAt`
FROM `SSOIdentity` AS `i`
INNER JOIN `SSOConfiguration` AS `c`
	ON rtrim(trim(`c`.`issuerUrl`), '/') = `i`.`issuer`
WHERE EXISTS (
	SELECT 1 FROM `UserOrganization` AS `uo`
	WHERE `uo`.`userId` = `i`.`userId`
		AND `uo`.`organizationId` = `c`.`organizationId`
);--> statement-breakpoint
DROP TABLE `SSOIdentity`;--> statement-breakpoint
ALTER TABLE `__new_SSOIdentity` RENAME TO `SSOIdentity`;--> statement-breakpoint
CREATE UNIQUE INDEX `SSOIdentity_ssoConfigId_subject_key` ON `SSOIdentity` (`ssoConfigId`,`subject`);--> statement-breakpoint
CREATE UNIQUE INDEX `SSOIdentity_ssoConfigId_userId_key` ON `SSOIdentity` (`ssoConfigId`,`userId`);--> statement-breakpoint
CREATE INDEX `SSOIdentity_userId_idx` ON `SSOIdentity` (`userId`);--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;--> statement-breakpoint
-- Records which successor a rotated refresh token was replaced by, so a
-- rotation can be told apart from a sign-out and a retried rotation can find
-- its successor.
ALTER TABLE `RefreshToken` ADD `replacedById` text;--> statement-breakpoint
-- A new client id or issuer is a different IdP application: its subjects are
-- not the old ones, so the old links stop applying. This runs on every write
-- path (App and Admin) in the same statement as the update. Users are linked
-- again by email (on an allowed domain) on their next SSO sign-in.
CREATE TRIGGER `SSOConfiguration_reset_identities_on_client_change`
AFTER UPDATE OF `clientId`, `issuerUrl` ON `SSOConfiguration`
FOR EACH ROW
WHEN OLD.`clientId` IS NOT NEW.`clientId`
	OR rtrim(trim(OLD.`issuerUrl`), '/') IS NOT rtrim(trim(NEW.`issuerUrl`), '/')
BEGIN
	DELETE FROM `SSOIdentity` WHERE `ssoConfigId` = NEW.`id`;
END;
