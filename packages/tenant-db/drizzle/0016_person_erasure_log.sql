CREATE TABLE `person_erasure_log` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`actor_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`counts` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_person_erasure_log_at` ON `person_erasure_log` (`at`);
