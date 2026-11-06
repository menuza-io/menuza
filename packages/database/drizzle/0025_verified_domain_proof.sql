ALTER TABLE `Organization` ADD `verifiedDomainProvedAt` integer;--> statement-breakpoint
ALTER TABLE `Organization` ADD `pendingVerifiedDomain` text;--> statement-breakpoint
ALTER TABLE `Organization` ADD `verifiedDomainToken` text;--> statement-breakpoint
-- One organization per verified domain. Where several organizations claimed the
-- same domain, the oldest claim stays and the later ones are cleared.
UPDATE `Organization` SET `verifiedDomain` = NULL
WHERE `verifiedDomain` IS NOT NULL
	AND EXISTS (
		SELECT 1 FROM `Organization` AS `earlier`
		WHERE `earlier`.`verifiedDomain` = `Organization`.`verifiedDomain`
			AND (`earlier`.`createdAt` < `Organization`.`createdAt`
				OR (`earlier`.`createdAt` = `Organization`.`createdAt` AND `earlier`.`id` < `Organization`.`id`))
	);--> statement-breakpoint
CREATE UNIQUE INDEX `Organization_verifiedDomain_key` ON `Organization` (`verifiedDomain`);