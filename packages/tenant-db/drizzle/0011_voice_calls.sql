CREATE TABLE `voice_call_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`call_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`caller_name` text,
	`caller_phone` text,
	`details` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	`updated_at` integer DEFAULT (strftime('%s', 'now')),
	FOREIGN KEY (`call_id`) REFERENCES `voice_calls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_voice_call_requests_status` ON `voice_call_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_voice_call_requests_call` ON `voice_call_requests` (`call_id`);--> statement-breakpoint
CREATE INDEX `idx_voice_call_requests_caller_phone` ON `voice_call_requests` (`caller_phone`);--> statement-breakpoint
CREATE TABLE `voice_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`scope_id` text,
	`flow_version_id` text,
	`room_name` text NOT NULL,
	`caller_phone` text,
	`customer_id` text,
	`purpose` text,
	`outcome` text,
	`summary` text,
	`transcript` text DEFAULT '[]' NOT NULL,
	`recording_key` text,
	`recording_expires_at` integer,
	`recording_swept_at` integer,
	`transcript_expires_at` integer,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`duration_seconds` integer,
	`follow_up_status` text DEFAULT 'resolved' NOT NULL,
	`follow_up_resolved_at` integer,
	`auto_resolve_at` integer,
	`tags` text DEFAULT '[]' NOT NULL,
	`rating` integer,
	`sentiment` text,
	`transfer_result` text DEFAULT 'none' NOT NULL,
	`transfer_contact_id` text,
	`voicemail` integer DEFAULT false NOT NULL,
	`called_while_open` integer,
	`link_sent` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_voice_calls_started` ON `voice_calls` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_voice_calls_purpose` ON `voice_calls` (`purpose`);--> statement-breakpoint
CREATE INDEX `idx_voice_calls_follow_up` ON `voice_calls` (`follow_up_status`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_voice_calls_auto_resolve` ON `voice_calls` (`auto_resolve_at`);--> statement-breakpoint
CREATE INDEX `idx_voice_calls_caller_phone` ON `voice_calls` (`caller_phone`);--> statement-breakpoint
CREATE INDEX `idx_voice_calls_customer` ON `voice_calls` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_voice_calls_recording_expires` ON `voice_calls` (`recording_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_voice_calls_transcript_expires` ON `voice_calls` (`transcript_expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `voice_calls_room_name_unique` ON `voice_calls` (`room_name`);--> statement-breakpoint
CREATE TABLE `voice_line_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`to_phone` text NOT NULL,
	`method` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_voice_line_verifications_created` ON `voice_line_verifications` (`created_at`);--> statement-breakpoint
CREATE TABLE `voice_link_handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`call_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`scope_id` text,
	`path` text NOT NULL,
	`payload` text NOT NULL,
	`sent_to_phone` text,
	`sms_sent_at` integer,
	`expires_at` integer NOT NULL,
	`opened_at` integer,
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	FOREIGN KEY (`call_id`) REFERENCES `voice_calls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `voice_link_handoffs_token_hash_unique` ON `voice_link_handoffs` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_voice_link_handoffs_call` ON `voice_link_handoffs` (`call_id`);--> statement-breakpoint
CREATE TABLE `voice_recording_deletions` (
	`recording_key` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `voice_sms_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`call_id` text NOT NULL,
	`kind` text NOT NULL,
	`to_phone` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	FOREIGN KEY (`call_id`) REFERENCES `voice_calls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_voice_sms_sends_created` ON `voice_sms_sends` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_voice_sms_sends_call` ON `voice_sms_sends` (`call_id`);--> statement-breakpoint
CREATE INDEX `idx_voice_sms_sends_to_phone` ON `voice_sms_sends` (`to_phone`);