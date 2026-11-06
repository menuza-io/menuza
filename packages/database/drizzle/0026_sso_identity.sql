CREATE TABLE `SSOIdentity` (
	`id` text PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`userId` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `SSOIdentity_issuer_subject_key` ON `SSOIdentity` (`issuer`,`subject`);--> statement-breakpoint
CREATE UNIQUE INDEX `SSOIdentity_issuer_userId_key` ON `SSOIdentity` (`issuer`,`userId`);--> statement-breakpoint
-- SSO now needs allowed email domains. Configurations without any get the
-- organization's verified domain when it has one; the rest refuse sign-in
-- until a platform admin adds domains in Admin, Organizations, SSO.
UPDATE `SSOConfiguration` SET `allowedEmailDomains` = (
	SELECT `Organization`.`verifiedDomain` FROM `Organization`
	WHERE `Organization`.`id` = `SSOConfiguration`.`organizationId`
)
WHERE (`allowedEmailDomains` IS NULL OR trim(`allowedEmailDomains`) = '')
	AND EXISTS (
		SELECT 1 FROM `Organization`
		WHERE `Organization`.`id` = `SSOConfiguration`.`organizationId`
			AND `Organization`.`verifiedDomain` IS NOT NULL
	);
