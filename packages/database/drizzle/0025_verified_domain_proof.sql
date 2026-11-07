ALTER TABLE `Organization` ADD `verifiedDomainProvedAt` integer;--> statement-breakpoint
ALTER TABLE `Organization` ADD `pendingVerifiedDomain` text;--> statement-breakpoint
ALTER TABLE `Organization` ADD `verifiedDomainToken` text;--> statement-breakpoint
-- Every existing verifiedDomain was saved before DNS proof existed, so none is
-- proven: anyone could have typed a domain they do not control. Each becomes a
-- pending claim with a fresh token (shown as a DNS record in organization
-- settings) and stops auto-joining sign-ups until it is proven. Clearing them
-- also leaves no duplicates for the unique index below.
UPDATE `Organization`
SET `pendingVerifiedDomain` = `verifiedDomain`,
	`verifiedDomainToken` = lower(hex(randomblob(18))),
	`verifiedDomain` = NULL
WHERE `verifiedDomain` IS NOT NULL
	AND `verifiedDomainProvedAt` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `Organization_verifiedDomain_key` ON `Organization` (`verifiedDomain`);