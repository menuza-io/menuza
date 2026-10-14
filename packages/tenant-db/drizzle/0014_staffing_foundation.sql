CREATE TABLE `hiring_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`posting_id` text NOT NULL,
	`posting_slug` text NOT NULL,
	`posting_title` text NOT NULL,
	`position_name` text,
	`scope_id` text,
	`source` text DEFAULT 'careers_page' NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`email` text,
	`phone` text,
	`email_hash` text,
	`phone_hash` text,
	`locale` text DEFAULT 'en' NOT NULL,
	`answers` text DEFAULT '[]' NOT NULL,
	`screener_score` integer,
	`screener_flags` text DEFAULT '[]' NOT NULL,
	`stage` text DEFAULT 'new' NOT NULL,
	`stage_changed_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`declined_reason` text,
	`declined_at` integer,
	`consent_at` integer NOT NULL,
	`consent_version` text NOT NULL,
	`retention_expires_at` integer,
	`hired_staff_id` text,
	`hired_at` integer,
	`ip_hash` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`hired_staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_hiring_applications_email` ON `hiring_applications` (`posting_id`,`email_hash`) WHERE "hiring_applications"."email_hash" is not null and "hiring_applications"."stage" <> 'declined';--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_hiring_applications_phone` ON `hiring_applications` (`posting_id`,`phone_hash`) WHERE "hiring_applications"."phone_hash" is not null and "hiring_applications"."stage" <> 'declined';--> statement-breakpoint
CREATE INDEX `idx_hiring_applications_stage` ON `hiring_applications` (`stage`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_hiring_applications_posting` ON `hiring_applications` (`posting_id`);--> statement-breakpoint
CREATE INDEX `idx_hiring_applications_scope` ON `hiring_applications` (`scope_id`);--> statement-breakpoint
CREATE INDEX `idx_hiring_applications_retention` ON `hiring_applications` (`retention_expires_at`) WHERE "hiring_applications"."retention_expires_at" is not null;--> statement-breakpoint
CREATE INDEX `idx_hiring_applications_ip` ON `hiring_applications` (`ip_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_hiring_applications_hired_staff` ON `hiring_applications` (`hired_staff_id`) WHERE "hiring_applications"."hired_staff_id" is not null;--> statement-breakpoint
CREATE TABLE `hiring_events` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor_id` text,
	`from_stage` text,
	`to_stage` text,
	`detail` text,
	`at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `hiring_applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hiring_events_application` ON `hiring_events` (`application_id`,`at`);--> statement-breakpoint
CREATE TABLE `hiring_interviews` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`scope_id` text,
	`scheduled_at` integer NOT NULL,
	`duration_minutes` integer DEFAULT 30 NOT NULL,
	`mode` text DEFAULT 'in_person' NOT NULL,
	`details` text,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`outcome` text,
	`invite_status` text DEFAULT 'not_sent' NOT NULL,
	`invite_sent_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `hiring_applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hiring_interviews_application` ON `hiring_interviews` (`application_id`,`scheduled_at`);--> statement-breakpoint
CREATE TABLE `hiring_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`deleted_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `hiring_applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hiring_notes_application` ON `hiring_notes` (`application_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `kiosk_attempts` (
	`device_id` text PRIMARY KEY NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_failure_at` integer,
	`blocked_until` integer,
	`hour_started_at` integer,
	`hour_failures` integer DEFAULT 0 NOT NULL,
	`hour_alerted_at` integer,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `kiosk_devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `kiosk_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`name` text NOT NULL,
	`secret_hash` text NOT NULL,
	`identify_mode` text DEFAULT 'pin' NOT NULL,
	`show_next_shifts` integer DEFAULT false NOT NULL,
	`time_zone` text,
	`scope_name` text,
	`paired_by` text NOT NULL,
	`paired_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`last_seen_at` integer,
	`last_seen_ip_hash` text,
	`revoked_at` integer,
	`revoked_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_kiosk_devices_secret_hash` ON `kiosk_devices` (`secret_hash`);--> statement-breakpoint
CREATE INDEX `idx_kiosk_devices_scope` ON `kiosk_devices` (`scope_id`);--> statement-breakpoint
CREATE TABLE `kiosk_pairing_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`scope_id` text NOT NULL,
	`device_name` text NOT NULL,
	`identify_mode` text DEFAULT 'pin' NOT NULL,
	`show_next_shifts` integer DEFAULT false NOT NULL,
	`time_zone` text,
	`scope_name` text,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`device_id` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_kiosk_pairing_codes_hash` ON `kiosk_pairing_codes` (`code_hash`);--> statement-breakpoint
CREATE INDEX `idx_kiosk_pairing_codes_scope` ON `kiosk_pairing_codes` (`scope_id`);--> statement-breakpoint
CREATE TABLE `labor_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text,
	`scope_key` text NOT NULL,
	`time_tracking_enabled` integer DEFAULT true NOT NULL,
	`time_zone` text,
	`week_starts_on` integer DEFAULT 1 NOT NULL,
	`workday_start_minute` integer DEFAULT 0 NOT NULL,
	`late_grace_minutes` integer DEFAULT 5 NOT NULL,
	`prevent_early_minutes` integer,
	`allow_unscheduled` integer DEFAULT true NOT NULL,
	`missed_clock_out_reminder_minutes` integer,
	`auto_clock_out_minutes` integer,
	`no_clock_in_alert_minutes` integer DEFAULT 15,
	`pre_shift_reminder_minutes` integer DEFAULT 240,
	`overtime_alert_minutes` integer DEFAULT 60,
	`rounding_mode` text DEFAULT 'none' NOT NULL,
	`rounding_increment_minutes` integer DEFAULT 1 NOT NULL,
	`daily_overtime_minutes` integer,
	`daily_overtime_bp` integer DEFAULT 15000 NOT NULL,
	`daily_double_time_minutes` integer,
	`daily_double_time_bp` integer DEFAULT 20000 NOT NULL,
	`weekly_overtime_minutes` integer,
	`weekly_overtime_bp` integer DEFAULT 15000 NOT NULL,
	`holiday_multiplier_bp` integer DEFAULT 10000 NOT NULL,
	`holiday_dates` text DEFAULT '[]' NOT NULL,
	`break_rules` text DEFAULT '{"rules":[],"autoDeduction":null}' NOT NULL,
	`long_shift_minutes` integer DEFAULT 960 NOT NULL,
	`geofence_mode` text DEFAULT 'off' NOT NULL,
	`geofence_radius_meters` integer,
	`require_photo` integer DEFAULT false NOT NULL,
	`timesheet_approval_mode` text DEFAULT 'none' NOT NULL,
	`schedule_visibility` text DEFAULT 'own' NOT NULL,
	`publish_lead_hours` integer DEFAULT 0 NOT NULL,
	`time_off_max_per_day` integer,
	`labor_target_bp` integer,
	`aggregate_overtime_across_scopes` integer,
	`rule_pack` text DEFAULT 'generic' NOT NULL,
	`rule_pack_version` integer DEFAULT 1 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_labor_policies_scope` ON `labor_policies` (`scope_key`);--> statement-breakpoint
CREATE TABLE `labor_scope_settings` (
	`scope_id` text PRIMARY KEY NOT NULL,
	`sales_source` text DEFAULT 'manual' NOT NULL,
	`orders_per_labor_hour` text DEFAULT '{}' NOT NULL,
	`updated_by` text,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`staff_id` text NOT NULL,
	`scope_id` text,
	`dedupe_key` text NOT NULL,
	`payload` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`last_error` text,
	`sent_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_notification_outbox_dedupe` ON `notification_outbox` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_notification_outbox_due` ON `notification_outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_notification_outbox_staff` ON `notification_outbox` (`staff_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `onboarding_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`task_key` text,
	`title` text,
	`type` text DEFAULT 'custom' NOT NULL,
	`instructions` text,
	`link_url` text,
	`assignee` text DEFAULT 'manager' NOT NULL,
	`assignee_user_id` text,
	`template_id` text,
	`status` text DEFAULT 'todo' NOT NULL,
	`due_date` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`source` text DEFAULT 'hire' NOT NULL,
	`reminded_stage` integer DEFAULT 0 NOT NULL,
	`completed_at` integer,
	`completed_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`) REFERENCES `onboarding_templates`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_onboarding_tasks_staff` ON `onboarding_tasks` (`staff_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_onboarding_tasks_open` ON `onboarding_tasks` (`status`,`due_date`) WHERE "onboarding_tasks"."status" = 'todo';--> statement-breakpoint
CREATE TABLE `onboarding_template_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`type` text DEFAULT 'custom' NOT NULL,
	`title` text NOT NULL,
	`instructions` text,
	`link_url` text,
	`due_in_days` integer DEFAULT 3 NOT NULL,
	`assignee` text DEFAULT 'manager' NOT NULL,
	`assignee_user_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `onboarding_templates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_onboarding_template_tasks_template` ON `onboarding_template_tasks` (`template_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `onboarding_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	`created_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_onboarding_templates_default` ON `onboarding_templates` (`is_default`) WHERE "onboarding_templates"."is_default" = 1 AND "onboarding_templates"."archived_at" IS NULL;--> statement-breakpoint
CREATE TABLE `sales_manual_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`business_date` text NOT NULL,
	`net_sales_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`note` text,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sales_manual_entries_day` ON `sales_manual_entries` (`scope_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `idx_sales_manual_entries_date` ON `sales_manual_entries` (`business_date`);--> statement-breakpoint
CREATE TABLE `schedule_links` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`revoked_by` text,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_schedule_links_token_hash` ON `schedule_links` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_schedule_links_live` ON `schedule_links` (`staff_id`) WHERE "schedule_links"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX `idx_schedule_links_staff` ON `schedule_links` (`staff_id`);--> statement-breakpoint
CREATE TABLE `schedule_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`week_start_date` text NOT NULL,
	`version` integer NOT NULL,
	`notify_mode` text DEFAULT 'changed' NOT NULL,
	`summary` text NOT NULL,
	`changes` text DEFAULT '[]' NOT NULL,
	`notification` text,
	`published_by` text NOT NULL,
	`published_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_schedule_publications_version` ON `schedule_publications` (`scope_id`,`week_start_date`,`version`);--> statement-breakpoint
CREATE INDEX `idx_schedule_publications_scope` ON `schedule_publications` (`scope_id`,`published_at`);--> statement-breakpoint
CREATE TABLE `schedule_settings` (
	`id` text PRIMARY KEY DEFAULT 'org' NOT NULL,
	`min_rest_minutes` integer DEFAULT 480 NOT NULL,
	`time_off_min_notice_days` integer DEFAULT 0 NOT NULL,
	`updated_by` text,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `schedule_weeks` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`week_start_date` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`last_published_at` integer,
	`last_published_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_schedule_weeks_scope_week` ON `schedule_weeks` (`scope_id`,`week_start_date`);--> statement-breakpoint
CREATE TABLE `shift_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`shift_id` text NOT NULL,
	`requester_staff_id` text NOT NULL,
	`target_staff_id` text,
	`target_shift_id` text,
	`note` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`source` text DEFAULT 'manager' NOT NULL,
	`requested_by` text,
	`decided_by` text,
	`decided_at` integer,
	`decision_note` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`shift_id`) REFERENCES `shifts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requester_staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_shift_id`) REFERENCES `shifts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_shift_requests_pending_shift` ON `shift_requests` (`shift_id`) WHERE "shift_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `idx_shift_requests_status` ON `shift_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_shift_requests_requester` ON `shift_requests` (`requester_staff_id`);--> statement-breakpoint
CREATE TABLE `shift_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`name` text NOT NULL,
	`slots` text NOT NULL,
	`slot_count` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_shift_templates_scope_name` ON `shift_templates` (`scope_id`,lower("name"));--> statement-breakpoint
CREATE TABLE `shifts` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`staff_id` text,
	`position_id` text,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`local_date` text NOT NULL,
	`time_zone` text NOT NULL,
	`unpaid_break_minutes` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`draft_patch` text,
	`published_at` integer,
	`published_version` integer,
	`cancelled_at` integer,
	`created_by` text,
	`updated_by` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`position_id`) REFERENCES `staff_positions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_shifts_scope_date` ON `shifts` (`scope_id`,`local_date`);--> statement-breakpoint
CREATE INDEX `idx_shifts_staff_start` ON `shifts` (`staff_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `idx_shifts_range` ON `shifts` (`starts_at`,`ends_at`);--> statement-breakpoint
CREATE INDEX `idx_shifts_status` ON `shifts` (`status`);--> statement-breakpoint
CREATE TABLE `staff_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`actor_kind` text DEFAULT 'operator' NOT NULL,
	`actor_id` text NOT NULL,
	`impersonated` integer DEFAULT false NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`staff_id` text,
	`scope_id` text,
	`sensitivity` text DEFAULT 'standard' NOT NULL,
	`changes` text,
	`ip_hash` text
);
--> statement-breakpoint
CREATE INDEX `idx_staff_audit_log_at` ON `staff_audit_log` (`at`);--> statement-breakpoint
CREATE INDEX `idx_staff_audit_log_staff` ON `staff_audit_log` (`staff_id`,`at`);--> statement-breakpoint
CREATE TABLE `staff_availability` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`kind` text NOT NULL,
	`weekday` integer,
	`date` text,
	`availability` text DEFAULT 'unavailable' NOT NULL,
	`all_day` integer DEFAULT true NOT NULL,
	`start_minute` integer,
	`end_minute` integer,
	`effective_from` text,
	`effective_to` text,
	`note` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`source` text DEFAULT 'manager' NOT NULL,
	`requested_by` text,
	`decided_by` text,
	`decided_at` integer,
	`decision_note` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_staff_availability_staff` ON `staff_availability` (`staff_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_staff_availability_status` ON `staff_availability` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `staff_certificates` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text,
	`issued_on` text,
	`expires_on` text,
	`note` text,
	`alert_stage` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_staff_certificates_staff` ON `staff_certificates` (`staff_id`);--> statement-breakpoint
CREATE INDEX `idx_staff_certificates_expiry` ON `staff_certificates` (`expires_on`) WHERE "staff_certificates"."expires_on" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `staff_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`scope_id` text NOT NULL,
	`position_id` text NOT NULL,
	`pay_type` text DEFAULT 'hourly' NOT NULL,
	`rate_minor` integer,
	`annual_salary_minor` integer,
	`currency` text NOT NULL,
	`overtime_exempt` integer DEFAULT false NOT NULL,
	`tip_eligible` integer DEFAULT false NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`change_reason` text,
	`created_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`position_id`) REFERENCES `staff_positions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_staff_jobs_open_position` ON `staff_jobs` (`staff_id`,`scope_id`,`position_id`) WHERE "staff_jobs"."effective_to" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_staff_jobs_open_primary` ON `staff_jobs` (`staff_id`,`scope_id`) WHERE "staff_jobs"."is_primary" = 1 and "staff_jobs"."effective_to" is null;--> statement-breakpoint
CREATE INDEX `idx_staff_jobs_staff` ON `staff_jobs` (`staff_id`,`effective_from`);--> statement-breakpoint
CREATE INDEX `idx_staff_jobs_scope` ON `staff_jobs` (`scope_id`);--> statement-breakpoint
CREATE TABLE `staff_members` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`worker_type` text DEFAULT 'employee' NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`first_name_ar` text,
	`last_name_ar` text,
	`email` text,
	`phone` text,
	`user_id` text,
	`employee_number` text,
	`locale` text DEFAULT 'en' NOT NULL,
	`hired_date` text,
	`terminated_at` integer,
	`termination_reason` text,
	`eligible_for_rehire` integer,
	`primary_scope_id` text,
	`created_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_staff_members_user_id` ON `staff_members` (`user_id`) WHERE "staff_members"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_staff_members_employee_number` ON `staff_members` (`employee_number`) WHERE "staff_members"."employee_number" is not null;--> statement-breakpoint
CREATE INDEX `idx_staff_members_status` ON `staff_members` (`status`);--> statement-breakpoint
CREATE INDEX `idx_staff_members_name` ON `staff_members` (`last_name`,`first_name`);--> statement-breakpoint
CREATE TABLE `staff_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`deleted_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_staff_notes_staff` ON `staff_notes` (`staff_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `staff_positions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_ar` text,
	`area` text,
	`color_key` text DEFAULT 'neutral' NOT NULL,
	`default_rate_minor` integer,
	`currency` text,
	`tip_eligible` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	`created_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_staff_positions_active_name` ON `staff_positions` (lower("name")) WHERE "staff_positions"."archived_at" is null;--> statement-breakpoint
CREATE TABLE `staff_private` (
	`staff_id` text PRIMARY KEY NOT NULL,
	`date_of_birth` text,
	`address_line1` text,
	`address_line2` text,
	`city` text,
	`region` text,
	`postal_code` text,
	`country` text,
	`emergency_contact_name` text,
	`emergency_contact_phone` text,
	`emergency_contact_relation` text,
	`updated_by` text,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `staff_scope_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`scope_id` text NOT NULL,
	`pin_lookup` text,
	`pin_set_at` integer,
	`pin_failed_count` integer DEFAULT 0 NOT NULL,
	`pin_locked_until` integer,
	`is_primary` integer DEFAULT false NOT NULL,
	`show_in_schedule` integer DEFAULT true NOT NULL,
	`eligible_open_shifts` integer DEFAULT true NOT NULL,
	`include_in_clock_errors` integer DEFAULT true NOT NULL,
	`can_waive_breaks` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_staff_assignments_staff_scope` ON `staff_scope_assignments` (`staff_id`,`scope_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_staff_assignments_scope_pin` ON `staff_scope_assignments` (`scope_id`,`pin_lookup`) WHERE "staff_scope_assignments"."pin_lookup" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_staff_assignments_primary` ON `staff_scope_assignments` (`staff_id`) WHERE "staff_scope_assignments"."is_primary" = 1;--> statement-breakpoint
CREATE INDEX `idx_staff_assignments_scope` ON `staff_scope_assignments` (`scope_id`,`active`);--> statement-breakpoint
CREATE TABLE `staffing_settings` (
	`id` text PRIMARY KEY DEFAULT 'org' NOT NULL,
	`pin_length` integer DEFAULT 4 NOT NULL,
	`pay_period` text DEFAULT 'weekly' NOT NULL,
	`pay_period_anchor` text,
	`contact_level` text DEFAULT 'full' NOT NULL,
	`retention_days_punch_coordinates` integer,
	`retention_days_declined_applicants` integer,
	`updated_by` text,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `time_breaks` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`kind` text DEFAULT 'meal' NOT NULL,
	`paid` integer DEFAULT false NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer,
	`start_punch_id` text,
	`end_punch_id` text,
	`voided_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `time_entries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_time_breaks_entry` ON `time_breaks` (`entry_id`,`start_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_time_breaks_open_entry` ON `time_breaks` (`entry_id`) WHERE "time_breaks"."end_at" is null and "time_breaks"."voided_at" is null;--> statement-breakpoint
CREATE TABLE `time_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`scope_id` text NOT NULL,
	`job_id` text,
	`position_id` text,
	`shift_id` text,
	`clock_in_at` integer NOT NULL,
	`clock_out_at` integer,
	`time_zone` text NOT NULL,
	`local_date` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`issues` text DEFAULT '[]' NOT NULL,
	`rate_minor` integer,
	`currency` text,
	`overtime_exempt` integer DEFAULT false NOT NULL,
	`break_waived` integer DEFAULT false NOT NULL,
	`regular_minutes` integer DEFAULT 0 NOT NULL,
	`overtime_minutes` integer DEFAULT 0 NOT NULL,
	`double_time_minutes` integer DEFAULT 0 NOT NULL,
	`holiday_minutes` integer DEFAULT 0 NOT NULL,
	`paid_minutes` integer DEFAULT 0 NOT NULL,
	`unpaid_break_minutes` integer DEFAULT 0 NOT NULL,
	`cash_tips_minor` integer DEFAULT 0 NOT NULL,
	`credit_tips_minor` integer DEFAULT 0 NOT NULL,
	`clock_out_kind` text,
	`approved_by` text,
	`approved_at` integer,
	`locked_by` text,
	`locked_at` integer,
	`reviewed_by` text,
	`reviewed_at` integer,
	`manager_note` text,
	`voided_at` integer,
	`voided_by` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_time_entries_open_staff` ON `time_entries` (`staff_id`) WHERE "time_entries"."clock_out_at" is null and "time_entries"."voided_at" is null;--> statement-breakpoint
CREATE INDEX `idx_time_entries_staff_in` ON `time_entries` (`staff_id`,`clock_in_at`);--> statement-breakpoint
CREATE INDEX `idx_time_entries_scope_date` ON `time_entries` (`scope_id`,`local_date`);--> statement-breakpoint
CREATE INDEX `idx_time_entries_status` ON `time_entries` (`status`);--> statement-breakpoint
CREATE INDEX `idx_time_entries_local_date` ON `time_entries` (`local_date`);--> statement-breakpoint
CREATE TABLE `time_entry_edits` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`staff_id` text NOT NULL,
	`scope_id` text NOT NULL,
	`editor_id` text NOT NULL,
	`via` text NOT NULL,
	`action` text NOT NULL,
	`reason` text NOT NULL,
	`before` text,
	`after` text,
	`hours_delta_minutes` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `time_entries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_time_entry_edits_entry` ON `time_entry_edits` (`entry_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_time_entry_edits_staff` ON `time_entry_edits` (`staff_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `time_off_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`category` text DEFAULT 'unpaid' NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`all_day` integer DEFAULT true NOT NULL,
	`start_minute` integer,
	`end_minute` integer,
	`note` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`source` text DEFAULT 'manager' NOT NULL,
	`requested_by` text,
	`decided_by` text,
	`decided_at` integer,
	`decision_note` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_time_off_staff` ON `time_off_requests` (`staff_id`,`start_date`);--> statement-breakpoint
CREATE INDEX `idx_time_off_status` ON `time_off_requests` (`status`,`start_date`);--> statement-breakpoint
CREATE TABLE `time_punches` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`scope_id` text NOT NULL,
	`entry_id` text,
	`kind` text NOT NULL,
	`client_at` integer NOT NULL,
	`server_at` integer NOT NULL,
	`effective_at` integer,
	`source` text NOT NULL,
	`device_id` text,
	`outcome` text NOT NULL,
	`reject_code` text,
	`flags` text DEFAULT '[]' NOT NULL,
	`position_id` text,
	`time_zone` text NOT NULL,
	`local_date` text NOT NULL,
	`latitude` real,
	`longitude` real,
	`accuracy_meters` real,
	`geofence_result` text,
	`ip_hash` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_time_punches_staff` ON `time_punches` (`staff_id`,`server_at`);--> statement-breakpoint
CREATE INDEX `idx_time_punches_entry` ON `time_punches` (`entry_id`);--> statement-breakpoint
CREATE INDEX `idx_time_punches_scope` ON `time_punches` (`scope_id`,`server_at`);--> statement-breakpoint
CREATE INDEX `idx_time_punches_device` ON `time_punches` (`device_id`,`server_at`);--> statement-breakpoint
CREATE TABLE `timesheet_periods` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text,
	`scope_key` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`closed_at` integer,
	`closed_by` text,
	`locked_at` integer,
	`locked_by` text,
	`created_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_timesheet_periods_range` ON `timesheet_periods` (`scope_key`,`start_date`,`end_date`);--> statement-breakpoint
CREATE TABLE `tip_pool_settings` (
	`scope_id` text PRIMARY KEY NOT NULL,
	`split_basis` text DEFAULT 'hours' NOT NULL,
	`cadence` text DEFAULT 'period' NOT NULL,
	`card_fee_bp` integer DEFAULT 0 NOT NULL,
	`fulfillment` text DEFAULT '["pickup"]' NOT NULL,
	`position_percent_bp` text DEFAULT '{}' NOT NULL,
	`updated_by` text,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
-- Append-only and integrity triggers. drizzle-kit does not model triggers, so they
-- are part of this migration by hand; the schema tests assert each one.
CREATE TRIGGER `staff_audit_log_no_delete` BEFORE DELETE ON `staff_audit_log`
BEGIN
	SELECT RAISE(ABORT, 'staff_audit_log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `staff_jobs_no_delete` BEFORE DELETE ON `staff_jobs`
BEGIN
	SELECT RAISE(ABORT, 'staff_jobs is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `staff_jobs_close_only` BEFORE UPDATE ON `staff_jobs`
WHEN NOT (
	OLD.`effective_to` IS NULL
	AND NEW.`effective_to` IS NOT NULL
	AND NEW.`id` IS OLD.`id`
	AND NEW.`staff_id` IS OLD.`staff_id`
	AND NEW.`scope_id` IS OLD.`scope_id`
	AND NEW.`position_id` IS OLD.`position_id`
	AND NEW.`pay_type` IS OLD.`pay_type`
	AND NEW.`rate_minor` IS OLD.`rate_minor`
	AND NEW.`annual_salary_minor` IS OLD.`annual_salary_minor`
	AND NEW.`currency` IS OLD.`currency`
	AND NEW.`overtime_exempt` IS OLD.`overtime_exempt`
	AND NEW.`tip_eligible` IS OLD.`tip_eligible`
	AND NEW.`is_primary` IS OLD.`is_primary`
	AND NEW.`effective_from` IS OLD.`effective_from`
	AND NEW.`change_reason` IS OLD.`change_reason`
	AND NEW.`created_by` IS OLD.`created_by`
	AND NEW.`created_at` IS OLD.`created_at`
)
BEGIN
	SELECT RAISE(ABORT, 'staff_jobs rows can only be closed, not edited');
END;
--> statement-breakpoint
CREATE TRIGGER `staff_audit_log_no_update` BEFORE UPDATE ON `staff_audit_log`
WHEN NOT (
	NEW.`changes` IS '{"redacted":true}'
	AND NEW.`id` IS OLD.`id`
	AND NEW.`at` IS OLD.`at`
	AND NEW.`actor_kind` IS OLD.`actor_kind`
	AND NEW.`actor_id` IS OLD.`actor_id`
	AND NEW.`impersonated` IS OLD.`impersonated`
	AND NEW.`action` IS OLD.`action`
	AND NEW.`entity_type` IS OLD.`entity_type`
	AND NEW.`entity_id` IS OLD.`entity_id`
	AND NEW.`staff_id` IS OLD.`staff_id`
	AND NEW.`scope_id` IS OLD.`scope_id`
	AND NEW.`sensitivity` IS OLD.`sensitivity`
	AND NEW.`ip_hash` IS OLD.`ip_hash`
)
BEGIN
	SELECT RAISE(ABORT, 'staff_audit_log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `time_punches_no_update` BEFORE UPDATE ON `time_punches`
BEGIN
	SELECT RAISE(ABORT, 'time_punches is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `time_punches_no_delete` BEFORE DELETE ON `time_punches`
BEGIN
	SELECT RAISE(ABORT, 'time_punches is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `time_entry_edits_no_update` BEFORE UPDATE ON `time_entry_edits`
BEGIN
	SELECT RAISE(ABORT, 'time_entry_edits is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `time_entry_edits_no_delete` BEFORE DELETE ON `time_entry_edits`
BEGIN
	SELECT RAISE(ABORT, 'time_entry_edits is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `time_entry_edits_reason_required` BEFORE INSERT ON `time_entry_edits`
WHEN length(trim(NEW.`reason`, ' ' || char(9) || char(10) || char(13))) = 0
BEGIN
	SELECT RAISE(ABORT, 'time_entry_edits requires a reason');
END;
--> statement-breakpoint
CREATE TRIGGER `time_entries_no_delete` BEFORE DELETE ON `time_entries`
BEGIN
	SELECT RAISE(ABORT, 'time_entries cannot be deleted; void them');
END;
--> statement-breakpoint
CREATE TRIGGER `time_entries_order_insert` BEFORE INSERT ON `time_entries`
WHEN NEW.`clock_out_at` IS NOT NULL AND NEW.`clock_out_at` < NEW.`clock_in_at`
BEGIN
	SELECT RAISE(ABORT, 'time entry ends before it starts');
END;
--> statement-breakpoint
CREATE TRIGGER `time_entries_order_update` BEFORE UPDATE ON `time_entries`
WHEN NEW.`clock_out_at` IS NOT NULL AND NEW.`clock_out_at` < NEW.`clock_in_at`
BEGIN
	SELECT RAISE(ABORT, 'time entry ends before it starts');
END;
--> statement-breakpoint
CREATE TRIGGER `time_breaks_no_delete` BEFORE DELETE ON `time_breaks`
BEGIN
	SELECT RAISE(ABORT, 'time_breaks cannot be deleted; void them');
END;
--> statement-breakpoint
CREATE TRIGGER `time_breaks_order_insert` BEFORE INSERT ON `time_breaks`
WHEN NEW.`end_at` IS NOT NULL AND NEW.`end_at` < NEW.`start_at`
BEGIN
	SELECT RAISE(ABORT, 'time break ends before it starts');
END;
--> statement-breakpoint
CREATE TRIGGER `time_breaks_order_update` BEFORE UPDATE ON `time_breaks`
WHEN NEW.`end_at` IS NOT NULL AND NEW.`end_at` < NEW.`start_at`
BEGIN
	SELECT RAISE(ABORT, 'time break ends before it starts');
END;
--> statement-breakpoint
CREATE TRIGGER `time_breaks_locked_insert` BEFORE INSERT ON `time_breaks`
WHEN (SELECT `status` FROM `time_entries` WHERE `id` = NEW.`entry_id`) = 'locked'
BEGIN
	SELECT RAISE(ABORT, 'time entry is locked');
END;
--> statement-breakpoint
CREATE TRIGGER `time_breaks_locked_update` BEFORE UPDATE ON `time_breaks`
WHEN (SELECT `status` FROM `time_entries` WHERE `id` = OLD.`entry_id`) = 'locked'
BEGIN
	SELECT RAISE(ABORT, 'time entry is locked');
END;
--> statement-breakpoint
CREATE TRIGGER `kiosk_devices_binding_immutable` BEFORE UPDATE ON `kiosk_devices`
WHEN NEW.`scope_id` IS NOT OLD.`scope_id`
	OR NEW.`secret_hash` IS NOT OLD.`secret_hash`
	OR NEW.`id` IS NOT OLD.`id`
	OR (OLD.`revoked_at` IS NOT NULL AND NEW.`revoked_at` IS NOT OLD.`revoked_at`)
BEGIN
	SELECT RAISE(ABORT, 'kiosk device binding is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `kiosk_pairing_codes_single_use` BEFORE UPDATE ON `kiosk_pairing_codes`
WHEN OLD.`used_at` IS NOT NULL
	OR NEW.`code_hash` IS NOT OLD.`code_hash`
	OR NEW.`scope_id` IS NOT OLD.`scope_id`
	OR NEW.`expires_at` IS NOT OLD.`expires_at`
BEGIN
	SELECT RAISE(ABORT, 'kiosk pairing code is single use');
END;
--> statement-breakpoint
CREATE TRIGGER `time_entries_locked_immutable` BEFORE UPDATE ON `time_entries`
WHEN OLD.`status` = 'locked' AND NOT (
	NEW.`status` = 'approved'
	AND NEW.`locked_at` IS NULL
	AND NEW.`locked_by` IS NULL
	AND NEW.`id` IS OLD.`id`
	AND NEW.`staff_id` IS OLD.`staff_id`
	AND NEW.`scope_id` IS OLD.`scope_id`
	AND NEW.`job_id` IS OLD.`job_id`
	AND NEW.`position_id` IS OLD.`position_id`
	AND NEW.`shift_id` IS OLD.`shift_id`
	AND NEW.`clock_in_at` IS OLD.`clock_in_at`
	AND NEW.`clock_out_at` IS OLD.`clock_out_at`
	AND NEW.`time_zone` IS OLD.`time_zone`
	AND NEW.`local_date` IS OLD.`local_date`
	AND NEW.`issues` IS OLD.`issues`
	AND NEW.`rate_minor` IS OLD.`rate_minor`
	AND NEW.`currency` IS OLD.`currency`
	AND NEW.`overtime_exempt` IS OLD.`overtime_exempt`
	AND NEW.`break_waived` IS OLD.`break_waived`
	AND NEW.`regular_minutes` IS OLD.`regular_minutes`
	AND NEW.`overtime_minutes` IS OLD.`overtime_minutes`
	AND NEW.`double_time_minutes` IS OLD.`double_time_minutes`
	AND NEW.`holiday_minutes` IS OLD.`holiday_minutes`
	AND NEW.`paid_minutes` IS OLD.`paid_minutes`
	AND NEW.`unpaid_break_minutes` IS OLD.`unpaid_break_minutes`
	AND NEW.`cash_tips_minor` IS OLD.`cash_tips_minor`
	AND NEW.`credit_tips_minor` IS OLD.`credit_tips_minor`
	AND NEW.`clock_out_kind` IS OLD.`clock_out_kind`
	AND NEW.`approved_by` IS OLD.`approved_by`
	AND NEW.`approved_at` IS OLD.`approved_at`
	AND NEW.`voided_at` IS OLD.`voided_at`
	AND NEW.`voided_by` IS OLD.`voided_by`
	AND NEW.`created_at` IS OLD.`created_at`
	AND NEW.`reviewed_by` IS OLD.`reviewed_by`
	AND NEW.`reviewed_at` IS OLD.`reviewed_at`
	AND NEW.`manager_note` IS OLD.`manager_note`
)
BEGIN
	SELECT RAISE(ABORT, 'time entry is locked');
END;
--> statement-breakpoint
CREATE TRIGGER `time_entries_no_overlap_insert` BEFORE INSERT ON `time_entries`
WHEN NEW.`voided_at` IS NULL AND EXISTS (
	SELECT 1 FROM `time_entries` AS `other`
	WHERE `other`.`staff_id` = NEW.`staff_id`
		AND `other`.`id` <> NEW.`id`
		AND `other`.`voided_at` IS NULL
		AND `other`.`clock_in_at` < COALESCE(NEW.`clock_out_at`, 9007199254740991)
		AND COALESCE(`other`.`clock_out_at`, 9007199254740991) > NEW.`clock_in_at`
		AND NOT (NEW.`clock_out_at` IS NULL AND `other`.`clock_out_at` IS NULL)
)
BEGIN
	SELECT RAISE(ABORT, 'time entries overlap');
END;
--> statement-breakpoint
CREATE TRIGGER `time_entries_no_overlap_update` BEFORE UPDATE OF `clock_in_at`, `clock_out_at`, `voided_at`, `staff_id` ON `time_entries`
WHEN NEW.`voided_at` IS NULL AND EXISTS (
	SELECT 1 FROM `time_entries` AS `other`
	WHERE `other`.`staff_id` = NEW.`staff_id`
		AND `other`.`id` <> NEW.`id`
		AND `other`.`voided_at` IS NULL
		AND `other`.`clock_in_at` < COALESCE(NEW.`clock_out_at`, 9007199254740991)
		AND COALESCE(`other`.`clock_out_at`, 9007199254740991) > NEW.`clock_in_at`
		AND NOT (NEW.`clock_out_at` IS NULL AND `other`.`clock_out_at` IS NULL)
)
BEGIN
	SELECT RAISE(ABORT, 'time entries overlap');
END;
--> statement-breakpoint
CREATE TRIGGER `shifts_range_insert` BEFORE INSERT ON `shifts`
WHEN NEW.`ends_at` <= NEW.`starts_at`
BEGIN
	SELECT RAISE(ABORT, 'shift must end after it starts');
END;
--> statement-breakpoint
CREATE TRIGGER `shifts_range_update` BEFORE UPDATE OF `starts_at`, `ends_at` ON `shifts`
WHEN NEW.`ends_at` <= NEW.`starts_at`
BEGIN
	SELECT RAISE(ABORT, 'shift must end after it starts');
END;
--> statement-breakpoint
CREATE TRIGGER `shifts_cancelled_frozen` BEFORE UPDATE ON `shifts`
WHEN OLD.`status` = 'cancelled'
BEGIN
	SELECT RAISE(ABORT, 'a cancelled shift cannot change');
END;
--> statement-breakpoint
CREATE TRIGGER `schedule_publications_no_update` BEFORE UPDATE ON `schedule_publications`
BEGIN
	SELECT RAISE(ABORT, 'schedule_publications is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `schedule_publications_no_delete` BEFORE DELETE ON `schedule_publications`
BEGIN
	SELECT RAISE(ABORT, 'schedule_publications is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `time_off_range_insert` BEFORE INSERT ON `time_off_requests`
WHEN NEW.`end_date` < NEW.`start_date`
BEGIN
	SELECT RAISE(ABORT, 'time off must not end before it starts');
END;
--> statement-breakpoint
CREATE TRIGGER `time_off_range_update` BEFORE UPDATE OF `start_date`, `end_date` ON `time_off_requests`
WHEN NEW.`end_date` < NEW.`start_date`
BEGIN
	SELECT RAISE(ABORT, 'time off must not end before it starts');
END;
