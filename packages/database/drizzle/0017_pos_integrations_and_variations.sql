CREATE TABLE `OrganizationMenuPosLink` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`integrationId` text NOT NULL,
	`providerName` text NOT NULL,
	`entityType` text NOT NULL,
	`remoteId` text NOT NULL,
	`localId` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`integrationId`) REFERENCES `Integration`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationMenuPosLink_organizationId_idx` ON `OrganizationMenuPosLink` (`organizationId`);--> statement-breakpoint
CREATE INDEX `OrganizationMenuPosLink_integrationId_idx` ON `OrganizationMenuPosLink` (`integrationId`);--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationMenuPosLink_integration_entity_remote_key` ON `OrganizationMenuPosLink` (`integrationId`,`entityType`,`remoteId`);
--> statement-breakpoint
ALTER TABLE `OrganizationMenuItem` ADD `variations` text DEFAULT '{"groups":[],"variants":[]}' NOT NULL;
--> statement-breakpoint
CREATE TABLE `IntegrationOAuthNonce` (
	`nonce` text PRIMARY KEY NOT NULL,
	`expiresAt` integer NOT NULL,
	`consumedAt` integer
);
--> statement-breakpoint
ALTER TABLE `Integration` ADD `externalStoreId` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `Integration_provider_external_store_key` ON `Integration` (`providerName`,`externalStoreId`);
--> statement-breakpoint
ALTER TABLE `Integration` ADD `organizationLocationId` text REFERENCES `OrganizationLocation`(`id`) ON UPDATE cascade ON DELETE cascade;
--> statement-breakpoint
DROP INDEX `Integration_organizationId_providerName_key`;
--> statement-breakpoint
CREATE INDEX `Integration_organizationLocationId_idx` ON `Integration` (`organizationLocationId`);
--> statement-breakpoint
CREATE UNIQUE INDEX `Integration_org_provider_orgwide_key` ON `Integration` (`organizationId`,`providerName`) WHERE `organizationLocationId` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `Integration_location_provider_key` ON `Integration` (`organizationLocationId`,`providerName`) WHERE `organizationLocationId` IS NOT NULL;
--> statement-breakpoint
UPDATE `Integration`
SET `organizationLocationId` = (
	SELECT `ol`.`id`
	FROM `OrganizationLocation` `ol`
	WHERE `ol`.`organizationId` = `Integration`.`organizationId`
	ORDER BY `ol`.`isDefault` DESC, `ol`.`createdAt` ASC
	LIMIT 1
)
WHERE `organizationLocationId` IS NULL
	AND (
		`providerName` IN ('clover', 'square', 'toast', 'ubereats', 'doordash')
		OR `providerName` = 'google-business-profile'
	);
