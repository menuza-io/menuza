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
CREATE UNIQUE INDEX `SSOIdentity_issuer_userId_key` ON `SSOIdentity` (`issuer`,`userId`);
