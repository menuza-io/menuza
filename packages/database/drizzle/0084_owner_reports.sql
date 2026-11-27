CREATE TABLE `AccountingExport` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`locationId` text NOT NULL,
	`businessDate` text NOT NULL,
	`currency` text NOT NULL,
	`sequence` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'final' NOT NULL,
	`totalsHash` text NOT NULL,
	`lines` text NOT NULL,
	`exportedById` text,
	`exportedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`exportedById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `AccountingExport_day_sequence_key` ON `AccountingExport` (`organizationId`,`locationId`,`businessDate`,`currency`,`sequence`);--> statement-breakpoint
CREATE INDEX `AccountingExport_org_date_idx` ON `AccountingExport` (`organizationId`,`businessDate`);--> statement-breakpoint
CREATE TABLE `AccountingMapping` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`lineKey` text NOT NULL,
	`accountCode` text DEFAULT '' NOT NULL,
	`accountName` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `AccountingMapping_org_lineKey_key` ON `AccountingMapping` (`organizationId`,`lineKey`);--> statement-breakpoint
CREATE TABLE `AccountingSettings` (
	`organizationId` text PRIMARY KEY NOT NULL,
	`layout` text DEFAULT 'generic' NOT NULL,
	`bookkeeperEmail` text,
	`weeklyEmail` integer DEFAULT false NOT NULL,
	`lastWeeklyKey` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `MonthlyResultsDelivery` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`userId` text NOT NULL,
	`month` text NOT NULL,
	`sentAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `MonthlyResultsDelivery_org_user_month_key` ON `MonthlyResultsDelivery` (`organizationId`,`userId`,`month`);--> statement-breakpoint
CREATE TABLE `ReportSchedule` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`savedReportId` text,
	`builtIn` text,
	`cadence` text NOT NULL,
	`weekday` integer,
	`hour` integer NOT NULL,
	`timeZone` text NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`createdById` text NOT NULL,
	`pausedAt` integer,
	`pausedReason` text,
	`lastRunKey` text,
	`lastSentAt` integer,
	`lastError` text,
	`failureDays` integer DEFAULT 0 NOT NULL,
	`retryCount` integer DEFAULT 0 NOT NULL,
	`nextAttemptAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`savedReportId`) REFERENCES `SavedReport`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ReportSchedule_organizationId_idx` ON `ReportSchedule` (`organizationId`);--> statement-breakpoint
CREATE INDEX `ReportSchedule_savedReportId_idx` ON `ReportSchedule` (`savedReportId`);--> statement-breakpoint
CREATE INDEX `ReportSchedule_pausedAt_idx` ON `ReportSchedule` (`pausedAt`);--> statement-breakpoint
CREATE TABLE `ReportScheduleRecipient` (
	`scheduleId` text NOT NULL,
	`userId` text NOT NULL,
	`unsubscribedAt` integer,
	`lastStatus` text,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`scheduleId`, `userId`),
	FOREIGN KEY (`scheduleId`) REFERENCES `ReportSchedule`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ReportScheduleRecipient_userId_idx` ON `ReportScheduleRecipient` (`userId`);--> statement-breakpoint
ALTER TABLE `Organization` ADD `deliveryCommissionBp` integer DEFAULT 2500 NOT NULL;--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'reports.schedules', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'reports.schedules' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'reports.accounting', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'reports.accounting' AND "level" = 'system');
