DROP INDEX `OrganizationRole_name_key`;--> statement-breakpoint
ALTER TABLE `OrganizationRole` ADD `organizationId` text REFERENCES Organization(id) ON UPDATE cascade ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `OrganizationRole_organizationId_idx` ON `OrganizationRole` (`organizationId`);--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationRole_shared_name_key` ON `OrganizationRole` (lower("name")) WHERE "OrganizationRole"."organizationId" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationRole_organizationId_name_key` ON `OrganizationRole` (`organizationId`,lower("name")) WHERE "OrganizationRole"."organizationId" IS NOT NULL;--> statement-breakpoint
CREATE TRIGGER `UserOrganization_organizationRole_same_organization_insert`
BEFORE INSERT ON `UserOrganization`
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
CREATE TRIGGER `UserOrganization_organizationRole_same_organization_update`
BEFORE UPDATE OF `organizationRoleId`, `organizationId` ON `UserOrganization`
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
CREATE TRIGGER `OrganizationInviteLink_organizationRole_same_organization_insert`
BEFORE INSERT ON `OrganizationInviteLink`
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
CREATE TRIGGER `OrganizationInviteLink_organizationRole_same_organization_update`
BEFORE UPDATE OF `organizationRoleId`, `organizationId` ON `OrganizationInviteLink`
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
END;
