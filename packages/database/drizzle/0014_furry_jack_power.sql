CREATE TABLE `OrganizationMediaAsset` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`objectKey` text NOT NULL,
	`storageScope` text DEFAULT 'organization' NOT NULL,
	`mimeType` text NOT NULL,
	`fileName` text,
	`fileSize` integer,
	`width` integer,
	`height` integer,
	`altText` text,
	`caption` text,
	`source` text DEFAULT 'library' NOT NULL,
	`createdById` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationMediaAsset_organizationId_objectKey_key` ON `OrganizationMediaAsset` (`organizationId`,`objectKey`);--> statement-breakpoint
CREATE INDEX `OrganizationMediaAsset_organizationId_createdAt_idx` ON `OrganizationMediaAsset` (`organizationId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `OrganizationMediaAsset_organizationId_mimeType_idx` ON `OrganizationMediaAsset` (`organizationId`,`mimeType`);--> statement-breakpoint
CREATE INDEX `OrganizationMediaAsset_createdById_idx` ON `OrganizationMediaAsset` (`createdById`);--> statement-breakpoint
INSERT OR IGNORE INTO `OrganizationMediaAsset` (
	`id`, `organizationId`, `objectKey`, `storageScope`, `mimeType`,
	`fileSize`, `altText`, `source`, `createdById`, `createdAt`, `updatedAt`
)
SELECT
	lower(hex(randomblob(12))), note.`organizationId`, upload.`objectKey`,
	'organization', COALESCE(upload.`mimeType`, 'application/octet-stream'), upload.`fileSize`,
	upload.`altText`, 'note', note.`createdById`, upload.`createdAt`, upload.`updatedAt`
FROM `OrganizationNoteUpload` AS upload
INNER JOIN `OrganizationNote` AS note ON note.`id` = upload.`noteId`
WHERE upload.`type` = 'image';--> statement-breakpoint
INSERT OR IGNORE INTO `OrganizationMediaAsset` (
	`id`, `organizationId`, `objectKey`, `storageScope`, `mimeType`,
	`altText`, `source`, `createdById`, `createdAt`, `updatedAt`
)
SELECT
	lower(hex(randomblob(12))), note.`organizationId`, image.`objectKey`,
	'organization', 'application/octet-stream', image.`altText`, 'comment', comment.`userId`,
	image.`createdAt`, image.`updatedAt`
FROM `NoteCommentImage` AS image
INNER JOIN `NoteComment` AS comment ON comment.`id` = image.`commentId`
INNER JOIN `OrganizationNote` AS note ON note.`id` = comment.`noteId`;--> statement-breakpoint
INSERT OR IGNORE INTO `OrganizationMediaAsset` (
	`id`, `organizationId`, `objectKey`, `storageScope`, `mimeType`,
	`altText`, `source`, `createdAt`, `updatedAt`
)
SELECT
	lower(hex(randomblob(12))), image.`organizationId`, image.`objectKey`,
	'platform', 'application/octet-stream', image.`altText`, 'organization-logo',
	image.`createdAt`, image.`updatedAt`
FROM `OrganizationImage` AS image;--> statement-breakpoint
INSERT OR IGNORE INTO `OrganizationMediaAsset` (
	`id`, `organizationId`, `objectKey`, `storageScope`, `mimeType`,
	`source`, `createdAt`, `updatedAt`
)
SELECT
	lower(hex(randomblob(12))), organization.`id`, organization.`siteIconKey`,
	'platform', 'image/png', 'site-icon', organization.`createdAt`, organization.`updatedAt`
FROM `Organization` AS organization
WHERE organization.`siteIconKey` IS NOT NULL AND organization.`siteIconKey` <> '';
