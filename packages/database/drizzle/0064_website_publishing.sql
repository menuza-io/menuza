CREATE TABLE `LegalAcceptance` (
	`id` text PRIMARY KEY NOT NULL,
	`agreementKey` text NOT NULL,
	`version` integer NOT NULL,
	`organizationId` text,
	`userId` text,
	`acceptedAt` integer NOT NULL,
	`ipHash` text,
	`source` text DEFAULT 'dialog' NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`agreementKey`,`version`) REFERENCES `LegalAgreement`(`key`,`version`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `LegalAcceptance_org_agreement_key` ON `LegalAcceptance` (`organizationId`,`agreementKey`,`version`) WHERE "LegalAcceptance"."organizationId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `LegalAcceptance_user_signup_key` ON `LegalAcceptance` (`userId`,`agreementKey`,`version`) WHERE "LegalAcceptance"."organizationId" IS NULL;--> statement-breakpoint
CREATE INDEX `LegalAcceptance_organizationId_idx` ON `LegalAcceptance` (`organizationId`);--> statement-breakpoint
CREATE INDEX `LegalAcceptance_agreementKey_version_idx` ON `LegalAcceptance` (`agreementKey`,`version`);--> statement-breakpoint
CREATE TABLE `LegalAgreement` (
	`key` text NOT NULL,
	`version` integer NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`summary` text,
	`scope` text DEFAULT 'always' NOT NULL,
	`publishedAt` integer NOT NULL,
	`requiredBy` integer,
	PRIMARY KEY(`key`, `version`)
);
--> statement-breakpoint
CREATE TABLE `WebsiteScheduledPublish` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`pageId` text,
	`scopeKey` text NOT NULL,
	`kind` text NOT NULL,
	`snapshot` text NOT NULL,
	`runAt` integer NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lastError` text,
	`createdById` text,
	`claimedAt` integer,
	`completedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`pageId`) REFERENCES `WebsitePage`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `WebsiteScheduledPublish_active_scope_key` ON `WebsiteScheduledPublish` (`organizationId`,`scopeKey`) WHERE "WebsiteScheduledPublish"."status" IN ('scheduled', 'running');--> statement-breakpoint
CREATE INDEX `WebsiteScheduledPublish_status_runAt_idx` ON `WebsiteScheduledPublish` (`status`,`runAt`);--> statement-breakpoint
CREATE INDEX `WebsiteScheduledPublish_organizationId_idx` ON `WebsiteScheduledPublish` (`organizationId`);--> statement-breakpoint
CREATE TABLE `WebsiteVersion` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`pageId` text,
	`kind` text NOT NULL,
	`title` text,
	`slug` text,
	`snapshot` text NOT NULL,
	`contentHash` text NOT NULL,
	`summary` text,
	`publishedById` text,
	`publishedAt` integer NOT NULL,
	`restoredFromId` text,
	`deletedAt` integer,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`publishedById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `WebsiteVersion_organizationId_pageId_publishedAt_idx` ON `WebsiteVersion` (`organizationId`,`pageId`,`publishedAt`);--> statement-breakpoint
CREATE INDEX `WebsiteVersion_organizationId_kind_publishedAt_idx` ON `WebsiteVersion` (`organizationId`,`kind`,`publishedAt`);--> statement-breakpoint
CREATE INDEX `WebsiteVersion_deletedAt_idx` ON `WebsiteVersion` (`deletedAt`);--> statement-breakpoint
ALTER TABLE `Organization` ADD `draftHeaderConfig` text;--> statement-breakpoint
ALTER TABLE `Organization` ADD `draftFooterConfig` text;--> statement-breakpoint
ALTER TABLE `Organization` ADD `draftSiteTheme` text;--> statement-breakpoint
ALTER TABLE `Organization` ADD `consentMode` text;--> statement-breakpoint
ALTER TABLE `Organization` ADD `legalContact` text;--> statement-breakpoint
ALTER TABLE `OrganizationAnnouncement` ADD `startsAt` integer;--> statement-breakpoint
ALTER TABLE `OrganizationAnnouncement` ADD `endsAt` integer;--> statement-breakpoint
ALTER TABLE `WebsitePage` ADD `legalKind` text;--> statement-breakpoint
ALTER TABLE `WebsitePage` ADD `legalTemplateVersion` integer;--> statement-breakpoint
ALTER TABLE `WebsitePage` ADD `legalGeneratedHash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `WebsitePage_organizationId_legalKind_key` ON `WebsitePage` (`organizationId`,`legalKind`) WHERE "WebsitePage"."legalKind" IS NOT NULL;
--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers or data): append this file's
-- content again after any `drizzle-kit generate` of this migration.

-- LegalAcceptance is append-only (#194). The delete trigger lets the cascade of
-- a deleted organization through: the parent row is already gone when the
-- cascade runs, and no row of an existing organization can be removed.
CREATE TRIGGER `LegalAcceptance_no_update`
BEFORE UPDATE ON `LegalAcceptance`
BEGIN
	SELECT RAISE(ABORT, 'LegalAcceptance is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `LegalAcceptance_no_delete`
BEFORE DELETE ON `LegalAcceptance`
WHEN OLD.`organizationId` IS NULL OR EXISTS (SELECT 1 FROM `Organization` WHERE `id` = OLD.`organizationId`)
BEGIN
	SELECT RAISE(ABORT, 'LegalAcceptance is append-only');
END;
--> statement-breakpoint
-- The first version of each Menuza agreement. The URLs point at the marketing
-- site; a new version published in Admin can change them.
INSERT INTO `LegalAgreement` (`key`, `version`, `title`, `url`, `summary`, `scope`, `publishedAt`, `requiredBy`) VALUES
	('terms', 1, '{"en":"Terms of Service","ar":"شروط الخدمة"}', '/tos', '{"en":"The terms that govern your use of the platform.","ar":"الشروط التي تحكم استخدامك للمنصة."}', 'always', CAST(strftime('%s', 'now') AS integer) * 1000, NULL),
	('privacy', 1, '{"en":"Privacy Policy","ar":"سياسة الخصوصية"}', '/privacy', '{"en":"How we collect and use your information.","ar":"كيف نجمع معلوماتك ونستخدمها."}', 'always', CAST(strftime('%s', 'now') AS integer) * 1000, NULL),
	('dpa', 1, '{"en":"Data Processing Agreement","ar":"اتفاقية معالجة البيانات"}', '/privacy#data-processing', '{"en":"How we process your guests'' data on your behalf.","ar":"كيف نعالج بيانات ضيوفك نيابة عنك."}', 'always', CAST(strftime('%s', 'now') AS integer) * 1000, NULL),
	('payments', 1, '{"en":"Payment Terms","ar":"شروط الدفع"}', '/tos#payments', '{"en":"The terms for taking online payments through the platform.","ar":"شروط قبول المدفوعات عبر الإنترنت من خلال المنصة."}', 'module', CAST(strftime('%s', 'now') AS integer) * 1000, NULL),
	('text_marketing', 1, '{"en":"Text Marketing Terms","ar":"شروط التسويق عبر الرسائل النصية"}', '/tos#text-marketing', '{"en":"The rules for sending marketing text messages to your guests.","ar":"قواعد إرسال الرسائل التسويقية النصية إلى ضيوفك."}', 'module', CAST(strftime('%s', 'now') AS integer) * 1000, NULL);
--> statement-breakpoint
-- Existing organizations accepted the Terms and Privacy Policy at sign-up
-- (version 1), with the organization's creation date. Acceptor: its oldest admin.
INSERT INTO `LegalAcceptance` (`id`, `agreementKey`, `version`, `organizationId`, `userId`, `acceptedAt`, `ipHash`, `source`)
SELECT lower(hex(randomblob(12))), `a`.`key`, 1, `o`.`id`,
	(SELECT `uo`.`userId` FROM `UserOrganization` `uo` JOIN `OrganizationRole` `r` ON `r`.`id` = `uo`.`organizationRoleId` WHERE `uo`.`organizationId` = `o`.`id` AND `r`.`name` = 'admin' ORDER BY `uo`.`createdAt` ASC LIMIT 1),
	`o`.`createdAt`, NULL, 'backfill'
FROM `Organization` `o`
CROSS JOIN (SELECT 'terms' AS `key` UNION ALL SELECT 'privacy') `a`;
--> statement-breakpoint
-- A first version of what is live today, so History starts with the live
-- content (#85): one per page that has a published snapshot, one for the site
-- header and footer and one for the theme.
INSERT INTO `WebsiteVersion` (`id`, `organizationId`, `pageId`, `kind`, `title`, `slug`, `snapshot`, `contentHash`, `summary`, `publishedById`, `publishedAt`)
SELECT lower(hex(randomblob(12))), `p`.`organizationId`, `p`.`id`, 'page', `p`.`title`, `p`.`slug`, `p`.`publishedData`, 'legacy', NULL, `p`.`createdById`, `p`.`updatedAt`
FROM `WebsitePage` `p` WHERE `p`.`publishedData` IS NOT NULL;
--> statement-breakpoint
INSERT INTO `WebsiteVersion` (`id`, `organizationId`, `pageId`, `kind`, `title`, `slug`, `snapshot`, `contentHash`, `summary`, `publishedById`, `publishedAt`)
SELECT lower(hex(randomblob(12))), `o`.`id`, NULL, 'chrome', NULL, NULL, json_object('header', `o`.`siteHeaderConfig`, 'footer', `o`.`siteFooterConfig`), 'legacy', NULL, NULL, `o`.`updatedAt`
FROM `Organization` `o` WHERE `o`.`siteHeaderConfig` IS NOT NULL OR `o`.`siteFooterConfig` IS NOT NULL;
--> statement-breakpoint
INSERT INTO `WebsiteVersion` (`id`, `organizationId`, `pageId`, `kind`, `title`, `slug`, `snapshot`, `contentHash`, `summary`, `publishedById`, `publishedAt`)
SELECT lower(hex(randomblob(12))), `o`.`id`, NULL, 'theme', NULL, NULL, `o`.`siteTheme`, 'legacy', NULL, NULL, `o`.`updatedAt`
FROM `Organization` `o` WHERE `o`.`siteTheme` IS NOT NULL;
