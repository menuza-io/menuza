CREATE TABLE `rsv_areas` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`name` text NOT NULL,
	`name_i18n` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`online_bookable` integer DEFAULT true NOT NULL,
	`guest_selectable` integer DEFAULT true NOT NULL,
	`canvas_w` integer DEFAULT 1200 NOT NULL,
	`canvas_h` integer DEFAULT 800 NOT NULL,
	`archived_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_areas_location_sort` ON `rsv_areas` (`location_id`,`sort`);--> statement-breakpoint
CREATE TABLE `rsv_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`location_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`changes` text
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_audit_log_location_at` ON `rsv_audit_log` (`location_id`,`at`);--> statement-breakpoint
CREATE TABLE `rsv_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`table_id` text,
	`area_id` text,
	`business_date` text NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`reason` text,
	`note` text,
	`created_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`table_id`) REFERENCES `rsv_tables`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`area_id`) REFERENCES `rsv_areas`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_rsv_blocks_target" CHECK((("rsv_blocks"."table_id" IS NOT NULL) + ("rsv_blocks"."area_id" IS NOT NULL)) = 1),
	CONSTRAINT "chk_rsv_blocks_time_range" CHECK("rsv_blocks"."end_at" > "rsv_blocks"."start_at")
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_blocks_location_date` ON `rsv_blocks` (`location_id`,`business_date`);--> statement-breakpoint
CREATE TABLE `rsv_day_versions` (
	`location_id` text NOT NULL,
	`business_date` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	PRIMARY KEY(`location_id`, `business_date`)
);
--> statement-breakpoint
CREATE TABLE `rsv_experience_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`experience_id` text NOT NULL,
	`from_date` text NOT NULL,
	`to_date` text NOT NULL,
	`days_mask` integer DEFAULT 127 NOT NULL,
	`seating_mins` text,
	`start_min` integer,
	`end_min` integer,
	`interval_min` integer,
	`turn_min` integer DEFAULT 90 NOT NULL,
	`covers_cap_per_seating` integer,
	`covers_cap_per_day` integer,
	`area_ids` text,
	`service_id` text,
	FOREIGN KEY (`experience_id`) REFERENCES `rsv_experiences`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `rsv_services`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_experience_schedules_experience` ON `rsv_experience_schedules` (`experience_id`);--> statement-breakpoint
CREATE TABLE `rsv_experiences` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`slug` text NOT NULL,
	`kind` text NOT NULL,
	`name_i18n` text DEFAULT '{}' NOT NULL,
	`description_i18n` text,
	`image_url` text,
	`price_minor` integer,
	`price_per_cover` integer DEFAULT true NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`policy_id` text,
	`party_min` integer DEFAULT 1 NOT NULL,
	`party_max` integer DEFAULT 8 NOT NULL,
	`uses_tables` integer DEFAULT true NOT NULL,
	`exclusive` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`policy_id`) REFERENCES `rsv_policies`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_rsv_experiences_location_slug` ON `rsv_experiences` (`location_id`,`slug`) WHERE "rsv_experiences"."status" <> 'archived';--> statement-breakpoint
CREATE INDEX `idx_rsv_experiences_location_status` ON `rsv_experiences` (`location_id`,`status`,`sort`);--> statement-breakpoint
CREATE TABLE `rsv_floor_elements` (
	`id` text PRIMARY KEY NOT NULL,
	`area_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text,
	`x` integer DEFAULT 0 NOT NULL,
	`y` integer DEFAULT 0 NOT NULL,
	`w` integer DEFAULT 60 NOT NULL,
	`h` integer DEFAULT 20 NOT NULL,
	`rotation` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`area_id`) REFERENCES `rsv_areas`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_floor_elements_area` ON `rsv_floor_elements` (`area_id`);--> statement-breakpoint
CREATE TABLE `rsv_guest_merges` (
	`id` text PRIMARY KEY NOT NULL,
	`kept_guest_id` text NOT NULL,
	`merged_guest_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`moved_counts` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`kept_guest_id`) REFERENCES `rsv_guests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merged_guest_id`) REFERENCES `rsv_guests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_guest_merges_kept` ON `rsv_guest_merges` (`kept_guest_id`,`at`);--> statement-breakpoint
CREATE TABLE `rsv_guest_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`guest_id` text NOT NULL,
	`body` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`author_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`guest_id`) REFERENCES `rsv_guests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_guest_notes_guest` ON `rsv_guest_notes` (`guest_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `rsv_guest_tags` (
	`guest_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`guest_id`, `tag_id`),
	FOREIGN KEY (`guest_id`) REFERENCES `rsv_guests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `rsv_tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_guest_tags_tag` ON `rsv_guest_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `rsv_guests` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text,
	`marketing_customer_id` text,
	`first_name` text NOT NULL,
	`last_name` text DEFAULT '' NOT NULL,
	`phone_e164` text,
	`email_norm` text,
	`locale` text DEFAULT 'en' NOT NULL,
	`allergy_notes` text,
	`marketing_email_consent_at` integer,
	`marketing_sms_consent_at` integer,
	`consent_source` text,
	`consent_text_version` text,
	`visits` integer DEFAULT 0 NOT NULL,
	`covers` integer DEFAULT 0 NOT NULL,
	`no_shows` integer DEFAULT 0 NOT NULL,
	`late_cancels` integer DEFAULT 0 NOT NULL,
	`cancels` integer DEFAULT 0 NOT NULL,
	`first_visit_at` integer,
	`last_visit_at` integer,
	`merged_into_id` text,
	`erased_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`marketing_customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_rsv_guests_customer_id` ON `rsv_guests` (`customer_id`) WHERE "rsv_guests"."customer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_rsv_guests_phone` ON `rsv_guests` (`phone_e164`);--> statement-breakpoint
CREATE INDEX `idx_rsv_guests_email` ON `rsv_guests` (`email_norm`);--> statement-breakpoint
CREATE INDEX `idx_rsv_guests_last_name` ON `rsv_guests` (`last_name`);--> statement-breakpoint
CREATE INDEX `idx_rsv_guests_last_visit_at` ON `rsv_guests` (`last_visit_at`);--> statement-breakpoint
CREATE TABLE `rsv_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`business_date` text NOT NULL,
	`local_start_min` integer NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`party_size` integer NOT NULL,
	`service_id` text,
	`experience_id` text,
	`area_pref_id` text,
	`combo_id` text,
	`source` text DEFAULT 'web' NOT NULL,
	`voice_call_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` integer NOT NULL,
	`extended_for_payment` integer DEFAULT false NOT NULL,
	`ip_hash` text,
	`reservation_id` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `rsv_services`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`experience_id`) REFERENCES `rsv_experiences`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`area_pref_id`) REFERENCES `rsv_areas`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`combo_id`) REFERENCES `rsv_table_combos`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "chk_rsv_holds_time_range" CHECK("rsv_holds"."end_at" > "rsv_holds"."start_at"),
	CONSTRAINT "chk_rsv_holds_party_size" CHECK("rsv_holds"."party_size" BETWEEN 1 AND 99)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_rsv_holds_token_hash` ON `rsv_holds` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_rsv_holds_location_date_status_expires` ON `rsv_holds` (`location_id`,`business_date`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_rsv_holds_ip_created` ON `rsv_holds` (`ip_hash`,`created_at`);--> statement-breakpoint
CREATE TABLE `rsv_idempotency_keys` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`request_hash` text NOT NULL,
	`status_code` integer NOT NULL,
	`response_json` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `key`)
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_idempotency_keys_expires` ON `rsv_idempotency_keys` (`expires_at`);--> statement-breakpoint
CREATE TABLE `rsv_journey_emissions` (
	`reservation_id` text NOT NULL,
	`event_type` text NOT NULL,
	`emitted_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	PRIMARY KEY(`reservation_id`, `event_type`),
	FOREIGN KEY (`reservation_id`) REFERENCES `rsv_reservations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `rsv_location_settings` (
	`location_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`online_enabled` integer DEFAULT false NOT NULL,
	`time_zone` text DEFAULT 'UTC' NOT NULL,
	`tz_synced_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`day_start_min` integer DEFAULT 240 NOT NULL,
	`interval_min` integer DEFAULT 15 NOT NULL,
	`horizon_days` integer DEFAULT 30 NOT NULL,
	`release_local_min` integer,
	`min_notice_min` integer DEFAULT 60 NOT NULL,
	`same_day_cutoff_min` integer,
	`online_party_min` integer DEFAULT 1 NOT NULL,
	`online_party_max` integer DEFAULT 8 NOT NULL,
	`party_max` integer DEFAULT 30 NOT NULL,
	`large_party_mode` text DEFAULT 'contact' NOT NULL,
	`large_party_note_i18n` text,
	`request_holds_capacity` integer DEFAULT true NOT NULL,
	`request_deadline_hours` integer DEFAULT 24 NOT NULL,
	`seating_pref_mode` text DEFAULT 'off' NOT NULL,
	`hold_minutes` integer DEFAULT 7 NOT NULL,
	`payment_hold_minutes` integer DEFAULT 20 NOT NULL,
	`voice_hold_minutes` integer DEFAULT 15 NOT NULL,
	`voice_mode` text DEFAULT 'hold_link' NOT NULL,
	`freeze_min` integer DEFAULT 30 NOT NULL,
	`late_grace_min` integer DEFAULT 15 NOT NULL,
	`auto_no_show_after_min` integer,
	`max_active_per_phone` integer DEFAULT 3 NOT NULL,
	`block_same_phone_overlap` integer DEFAULT true NOT NULL,
	`guest_modify_cutoff_min` integer DEFAULT 120 NOT NULL,
	`contact_statuses_enabled` integer DEFAULT true NOT NULL,
	`course_statuses_enabled` integer DEFAULT false NOT NULL,
	`default_policy_id` text,
	`waitlist_enabled` integer DEFAULT false NOT NULL,
	`waitlist_online` integer DEFAULT false NOT NULL,
	`notify_me_enabled` integer DEFAULT false NOT NULL,
	`waitlist_response_min` integer DEFAULT 10 NOT NULL,
	`waitlist_max_parties` integer,
	`messaging` text DEFAULT '{}' NOT NULL,
	`public_note_i18n` text,
	`contact_phone` text,
	`floor_plan_version` integer DEFAULT 1 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`default_policy_id`) REFERENCES `rsv_policies`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `rsv_message_texts` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text,
	`kind` text NOT NULL,
	`locale` text NOT NULL,
	`custom_note` text DEFAULT '' NOT NULL,
	`updated_by` text,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_rsv_message_texts_loc_kind_locale` ON `rsv_message_texts` (`location_id`,`kind`,`locale`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_rsv_message_texts_org_kind_locale` ON `rsv_message_texts` (`kind`,`locale`) WHERE "rsv_message_texts"."location_id" IS NULL;--> statement-breakpoint
CREATE TABLE `rsv_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`reservation_id` text,
	`waitlist_entry_id` text,
	`notify_request_id` text,
	`kind` text NOT NULL,
	`channel` text NOT NULL,
	`category` text DEFAULT 'transactional' NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`send_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`dedupe_key` text NOT NULL,
	`provider_message_id` text,
	`last_error_code` text,
	`sent_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`reservation_id`) REFERENCES `rsv_reservations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`waitlist_entry_id`) REFERENCES `rsv_waitlist_entries`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`notify_request_id`) REFERENCES `rsv_notify_requests`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_rsv_messages_dedupe_key` ON `rsv_messages` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_rsv_messages_status_next_attempt` ON `rsv_messages` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_rsv_messages_reservation` ON `rsv_messages` (`reservation_id`);--> statement-breakpoint
CREATE TABLE `rsv_notify_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`business_date` text NOT NULL,
	`party_size` integer NOT NULL,
	`from_local_min` integer NOT NULL,
	`to_local_min` integer NOT NULL,
	`area_pref_id` text,
	`experience_id` text,
	`contact_phone_e164` text,
	`contact_email_norm` text,
	`guest_id` text,
	`locale` text DEFAULT 'en' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`notified_count` integer DEFAULT 0 NOT NULL,
	`last_notified_at` integer,
	`expires_at` integer NOT NULL,
	`token_version` integer DEFAULT 1 NOT NULL,
	`ip_hash` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`area_pref_id`) REFERENCES `rsv_areas`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`experience_id`) REFERENCES `rsv_experiences`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`guest_id`) REFERENCES `rsv_guests`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "chk_rsv_notify_requests_party_size" CHECK("rsv_notify_requests"."party_size" BETWEEN 1 AND 99)
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_notify_requests_loc_date_status` ON `rsv_notify_requests` (`location_id`,`business_date`,`status`);--> statement-breakpoint
CREATE TABLE `rsv_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`payload` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`delivered_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_rsv_outbox_dedupe_key` ON `rsv_outbox` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_rsv_outbox_pending` ON `rsv_outbox` (`delivered_at`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `rsv_pacing_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`from_min` integer,
	`to_min` integer,
	`bucket_min` integer DEFAULT 15 NOT NULL,
	`max_covers` integer,
	`max_parties` integer,
	`rolling_min` integer,
	`rolling_max_covers` integer,
	`channel` text DEFAULT 'all' NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `rsv_services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_pacing_rules_service` ON `rsv_pacing_rules` (`service_id`);--> statement-breakpoint
CREATE TABLE `rsv_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`reservation_id` text NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`amount_minor` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`platform_fee_minor` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`provider_ref` text,
	`payment_method_ref` text,
	`customer_ref` text,
	`card_brand` text,
	`card_last4` text,
	`idempotency_key` text NOT NULL,
	`failure_code` text,
	`failure_message` text,
	`created_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`reservation_id`) REFERENCES `rsv_reservations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_rsv_payments_idempotency_key` ON `rsv_payments` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_rsv_payments_provider_ref` ON `rsv_payments` (`provider`,`provider_ref`) WHERE "rsv_payments"."provider_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_rsv_payments_reservation` ON `rsv_payments` (`reservation_id`);--> statement-breakpoint
CREATE TABLE `rsv_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'none' NOT NULL,
	`amount_minor` integer DEFAULT 0 NOT NULL,
	`per_cover` integer DEFAULT false NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`free_cancel_until_min` integer DEFAULT 0 NOT NULL,
	`late_cancel_fee_minor` integer DEFAULT 0 NOT NULL,
	`no_show_fee_minor` integer DEFAULT 0 NOT NULL,
	`fee_per_cover` integer DEFAULT false NOT NULL,
	`fee_cap_minor` integer,
	`refund_rule` text DEFAULT 'full_before_window' NOT NULL,
	`partial_refund_bp` integer,
	`applies_party_min` integer,
	`terms_i18n` text,
	`terms_version` integer DEFAULT 1 NOT NULL,
	`archived_at` integer,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_policies_location` ON `rsv_policies` (`location_id`);--> statement-breakpoint
CREATE TABLE `rsv_rate_counters` (
	`bucket` text NOT NULL,
	`subject_hash` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`bucket`, `subject_hash`, `window_start`)
);
--> statement-breakpoint
CREATE TABLE `rsv_reservation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`reservation_id` text NOT NULL,
	`at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`type` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`data` text,
	FOREIGN KEY (`reservation_id`) REFERENCES `rsv_reservations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_reservation_events_reservation_at` ON `rsv_reservation_events` (`reservation_id`,`at`);--> statement-breakpoint
CREATE TABLE `rsv_reservation_tags` (
	`reservation_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`reservation_id`, `tag_id`),
	FOREIGN KEY (`reservation_id`) REFERENCES `rsv_reservations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `rsv_tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_reservation_tags_tag` ON `rsv_reservation_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `rsv_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`guest_id` text NOT NULL,
	`customer_id` text,
	`confirmation_code` text NOT NULL,
	`business_date` text NOT NULL,
	`local_start_min` integer NOT NULL,
	`time_zone` text NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`duration_min` integer NOT NULL,
	`service_id` text,
	`experience_id` text,
	`party_size` integer NOT NULL,
	`arrived_covers` integer,
	`seated_covers` integer,
	`status` text DEFAULT 'booked' NOT NULL,
	`contact_status` text,
	`running_late_min` integer,
	`course_status` text,
	`channel` text DEFAULT 'online' NOT NULL,
	`client` text,
	`assignment` text DEFAULT 'soft' NOT NULL,
	`combo_id` text,
	`overbooked` integer DEFAULT false NOT NULL,
	`area_pref_id` text,
	`area_pref_strict` integer DEFAULT false NOT NULL,
	`occasion_tag_id` text,
	`guest_requests` text,
	`dietary_notes` text,
	`staff_notes` text,
	`policy_snapshot` text,
	`policy_accepted_at` integer,
	`policy_text_hash` text,
	`payment_status` text DEFAULT 'none' NOT NULL,
	`payment_expires_at` integer,
	`request_deadline_at` integer,
	`late_cancel` integer DEFAULT false NOT NULL,
	`hold_id` text,
	`voice_call_id` text,
	`manage_token_version` integer DEFAULT 1 NOT NULL,
	`sms_opt_in` integer DEFAULT false NOT NULL,
	`guest_locale` text DEFAULT 'en' NOT NULL,
	`schedule_version` integer DEFAULT 1 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`arrived_at` integer,
	`seated_at` integer,
	`finished_at` integer,
	`cancelled_at` integer,
	`no_show_at` integer,
	`cancelled_by` text,
	`cancel_reason` text,
	`created_by_kind` text DEFAULT 'guest' NOT NULL,
	`created_by_id` text,
	`ip_hash` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`guest_id`) REFERENCES `rsv_guests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`service_id`) REFERENCES `rsv_services`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`experience_id`) REFERENCES `rsv_experiences`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`combo_id`) REFERENCES `rsv_table_combos`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`area_pref_id`) REFERENCES `rsv_areas`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`occasion_tag_id`) REFERENCES `rsv_tags`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "chk_rsv_reservations_time_range" CHECK("rsv_reservations"."end_at" > "rsv_reservations"."start_at"),
	CONSTRAINT "chk_rsv_reservations_party_size" CHECK("rsv_reservations"."party_size" BETWEEN 1 AND 99)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_rsv_reservations_confirmation_code` ON `rsv_reservations` (`confirmation_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_rsv_reservations_hold_id` ON `rsv_reservations` (`hold_id`);--> statement-breakpoint
CREATE INDEX `idx_rsv_reservations_location_date_status` ON `rsv_reservations` (`location_id`,`business_date`,`status`);--> statement-breakpoint
CREATE INDEX `idx_rsv_reservations_location_start` ON `rsv_reservations` (`location_id`,`start_at`);--> statement-breakpoint
CREATE INDEX `idx_rsv_reservations_guest_start` ON `rsv_reservations` (`guest_id`,`start_at`);--> statement-breakpoint
CREATE INDEX `idx_rsv_reservations_status_start` ON `rsv_reservations` (`status`,`start_at`);--> statement-breakpoint
CREATE INDEX `idx_rsv_reservations_customer_start` ON `rsv_reservations` (`customer_id`,`start_at`);--> statement-breakpoint
CREATE TABLE `rsv_section_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`business_date` text NOT NULL,
	`service_id` text NOT NULL,
	`section_id` text NOT NULL,
	`staff_id` text,
	`server_label` text,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`section_id`) REFERENCES `rsv_sections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_rsv_section_assignments_day_service_section` ON `rsv_section_assignments` (`business_date`,`service_id`,`section_id`);--> statement-breakpoint
CREATE INDEX `idx_rsv_section_assignments_location_date` ON `rsv_section_assignments` (`location_id`,`business_date`);--> statement-breakpoint
CREATE TABLE `rsv_section_layouts` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`name` text NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_section_layouts_location` ON `rsv_section_layouts` (`location_id`);--> statement-breakpoint
CREATE TABLE `rsv_section_tables` (
	`section_id` text NOT NULL,
	`table_id` text NOT NULL,
	`layout_id` text NOT NULL,
	PRIMARY KEY(`section_id`, `table_id`),
	FOREIGN KEY (`section_id`) REFERENCES `rsv_sections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`table_id`) REFERENCES `rsv_tables`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`layout_id`) REFERENCES `rsv_section_layouts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_rsv_section_tables_layout_table` ON `rsv_section_tables` (`layout_id`,`table_id`);--> statement-breakpoint
CREATE TABLE `rsv_sections` (
	`id` text PRIMARY KEY NOT NULL,
	`layout_id` text NOT NULL,
	`name` text NOT NULL,
	`color_token` text DEFAULT 'neutral' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`layout_id`) REFERENCES `rsv_section_layouts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_sections_layout_sort` ON `rsv_sections` (`layout_id`,`sort`);--> statement-breakpoint
CREATE TABLE `rsv_service_availability` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`area_id` text,
	`table_id` text,
	`combo_id` text,
	`mode` text NOT NULL,
	`from_min` integer,
	`to_min` integer,
	FOREIGN KEY (`service_id`) REFERENCES `rsv_services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`area_id`) REFERENCES `rsv_areas`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`table_id`) REFERENCES `rsv_tables`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`combo_id`) REFERENCES `rsv_table_combos`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_rsv_service_availability_target" CHECK((("rsv_service_availability"."area_id" IS NOT NULL) + ("rsv_service_availability"."table_id" IS NOT NULL) + ("rsv_service_availability"."combo_id" IS NOT NULL)) = 1)
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_service_availability_service` ON `rsv_service_availability` (`service_id`);--> statement-breakpoint
CREATE TABLE `rsv_service_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`business_date` text NOT NULL,
	`service_id` text,
	`body` text DEFAULT '' NOT NULL,
	`updated_by` text,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `rsv_services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_rsv_service_notes_loc_date_service` ON `rsv_service_notes` (`location_id`,`business_date`,`service_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_rsv_service_notes_loc_date_day` ON `rsv_service_notes` (`location_id`,`business_date`) WHERE "rsv_service_notes"."service_id" IS NULL;--> statement-breakpoint
CREATE TABLE `rsv_services` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`name` text NOT NULL,
	`name_i18n` text,
	`days_mask` integer DEFAULT 127 NOT NULL,
	`first_seating_min` integer NOT NULL,
	`last_seating_min` integer NOT NULL,
	`end_min` integer NOT NULL,
	`interval_min` integer,
	`effective_from` text,
	`effective_to` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`special_day_id` text,
	`online_enabled` integer DEFAULT true NOT NULL,
	`online_from_min` integer,
	`online_to_min` integer,
	`max_party` integer,
	`online_party_max` integer,
	`online_cap_per_interval` integer,
	`concurrent_covers_cap` integer,
	`policy_id` text,
	`section_layout_id` text,
	`allow_overrun_past_end` integer DEFAULT true NOT NULL,
	`color_token` text DEFAULT 'neutral' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`special_day_id`) REFERENCES `rsv_special_days`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`policy_id`) REFERENCES `rsv_policies`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`section_layout_id`) REFERENCES `rsv_section_layouts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "chk_rsv_services_seating_order" CHECK("rsv_services"."first_seating_min" <= "rsv_services"."last_seating_min" AND "rsv_services"."last_seating_min" <= "rsv_services"."end_min"),
	CONSTRAINT "chk_rsv_services_max_span" CHECK("rsv_services"."end_min" - "rsv_services"."first_seating_min" <= 1440)
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_services_location_archived` ON `rsv_services` (`location_id`,`archived_at`);--> statement-breakpoint
CREATE TABLE `rsv_special_days` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`from_date` text NOT NULL,
	`to_date` text NOT NULL,
	`kind` text NOT NULL,
	`service_id` text,
	`patch` text,
	`name` text,
	`public_note_i18n` text,
	`created_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `rsv_services`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_special_days_location_dates` ON `rsv_special_days` (`location_id`,`from_date`,`to_date`);--> statement-breakpoint
CREATE TABLE `rsv_table_combo_members` (
	`combo_id` text NOT NULL,
	`table_id` text NOT NULL,
	PRIMARY KEY(`combo_id`, `table_id`),
	FOREIGN KEY (`combo_id`) REFERENCES `rsv_table_combos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`table_id`) REFERENCES `rsv_tables`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_table_combo_members_table` ON `rsv_table_combo_members` (`table_id`);--> statement-breakpoint
CREATE TABLE `rsv_table_combos` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`label` text NOT NULL,
	`min_covers` integer NOT NULL,
	`max_covers` integer NOT NULL,
	`online_bookable` integer DEFAULT true NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	CONSTRAINT "chk_rsv_table_combos_covers" CHECK("rsv_table_combos"."min_covers" >= 1 AND "rsv_table_combos"."min_covers" <= "rsv_table_combos"."max_covers" AND "rsv_table_combos"."max_covers" <= 99)
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_table_combos_location` ON `rsv_table_combos` (`location_id`);--> statement-breakpoint
CREATE TABLE `rsv_table_occupancies` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`table_id` text NOT NULL,
	`kind` text NOT NULL,
	`reservation_id` text,
	`hold_id` text,
	`block_id` text,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`overbook` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`table_id`) REFERENCES `rsv_tables`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reservation_id`) REFERENCES `rsv_reservations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`hold_id`) REFERENCES `rsv_holds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`block_id`) REFERENCES `rsv_blocks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_rsv_table_occupancies_owner" CHECK((("rsv_table_occupancies"."kind" = 'reservation' AND "rsv_table_occupancies"."reservation_id" IS NOT NULL AND "rsv_table_occupancies"."hold_id" IS NULL AND "rsv_table_occupancies"."block_id" IS NULL) OR ("rsv_table_occupancies"."kind" = 'hold' AND "rsv_table_occupancies"."hold_id" IS NOT NULL AND "rsv_table_occupancies"."reservation_id" IS NULL AND "rsv_table_occupancies"."block_id" IS NULL) OR ("rsv_table_occupancies"."kind" = 'block' AND "rsv_table_occupancies"."block_id" IS NOT NULL AND "rsv_table_occupancies"."reservation_id" IS NULL AND "rsv_table_occupancies"."hold_id" IS NULL))),
	CONSTRAINT "chk_rsv_table_occupancies_time_range" CHECK("rsv_table_occupancies"."end_at" > "rsv_table_occupancies"."start_at")
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_table_occupancies_table_active_start` ON `rsv_table_occupancies` (`table_id`,`active`,`start_at`);--> statement-breakpoint
CREATE INDEX `idx_rsv_table_occupancies_reservation` ON `rsv_table_occupancies` (`reservation_id`);--> statement-breakpoint
CREATE INDEX `idx_rsv_table_occupancies_hold` ON `rsv_table_occupancies` (`hold_id`);--> statement-breakpoint
CREATE INDEX `idx_rsv_table_occupancies_block` ON `rsv_table_occupancies` (`block_id`);--> statement-breakpoint
CREATE TABLE `rsv_tables` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`area_id` text NOT NULL,
	`label` text NOT NULL,
	`min_covers` integer DEFAULT 1 NOT NULL,
	`max_covers` integer DEFAULT 2 NOT NULL,
	`online_bookable` integer DEFAULT true NOT NULL,
	`combinable` integer DEFAULT false NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`reset_buffer_min` integer DEFAULT 0 NOT NULL,
	`shape` text DEFAULT 'square' NOT NULL,
	`x` integer DEFAULT 0 NOT NULL,
	`y` integer DEFAULT 0 NOT NULL,
	`w` integer DEFAULT 60 NOT NULL,
	`h` integer DEFAULT 60 NOT NULL,
	`rotation` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`area_id`) REFERENCES `rsv_areas`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_rsv_tables_covers" CHECK("rsv_tables"."min_covers" >= 1 AND "rsv_tables"."min_covers" <= "rsv_tables"."max_covers" AND "rsv_tables"."max_covers" <= 99),
	CONSTRAINT "chk_rsv_tables_reset_buffer" CHECK("rsv_tables"."reset_buffer_min" BETWEEN 0 AND 120)
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_tables_location_area` ON `rsv_tables` (`location_id`,`area_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_rsv_tables_location_label` ON `rsv_tables` (`location_id`,`label`) WHERE "rsv_tables"."archived_at" IS NULL;--> statement-breakpoint
CREATE TABLE `rsv_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`category` text NOT NULL,
	`name` text NOT NULL,
	`name_i18n` text,
	`color_token` text DEFAULT 'neutral' NOT NULL,
	`sensitive` integer DEFAULT false NOT NULL,
	`system_key` text,
	`guest_selectable` integer DEFAULT false NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_rsv_tags_system_key` ON `rsv_tags` (`system_key`) WHERE "rsv_tags"."system_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_rsv_tags_scope_category` ON `rsv_tags` (`scope`,`category`);--> statement-breakpoint
CREATE TABLE `rsv_turn_times` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`service_id` text,
	`party_min` integer NOT NULL,
	`party_max` integer NOT NULL,
	`minutes` integer NOT NULL,
	`days_mask` integer,
	FOREIGN KEY (`service_id`) REFERENCES `rsv_services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_rsv_turn_times_bucket` ON `rsv_turn_times` (`location_id`,`service_id`,`party_min`,`days_mask`);--> statement-breakpoint
CREATE TABLE `rsv_waitlist_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`business_date` text NOT NULL,
	`guest_id` text,
	`display_name` text NOT NULL,
	`phone_e164` text,
	`email_norm` text,
	`party_size` integer NOT NULL,
	`area_pref_id` text,
	`channel` text DEFAULT 'walk_in' NOT NULL,
	`joined_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`quoted_min` integer,
	`quoted_ready_at` integer,
	`status` text DEFAULT 'waiting' NOT NULL,
	`notified_at` integer,
	`response_deadline_at` integer,
	`reservation_id` text,
	`status_token_version` integer DEFAULT 1 NOT NULL,
	`sort_key` real DEFAULT 0 NOT NULL,
	`notes` text,
	`sms_opt_in` integer DEFAULT false NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`ip_hash` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`guest_id`) REFERENCES `rsv_guests`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`area_pref_id`) REFERENCES `rsv_areas`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reservation_id`) REFERENCES `rsv_reservations`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "chk_rsv_waitlist_entries_party_size" CHECK("rsv_waitlist_entries"."party_size" BETWEEN 1 AND 99)
);
--> statement-breakpoint
CREATE INDEX `idx_rsv_waitlist_entries_loc_date_status_sort` ON `rsv_waitlist_entries` (`location_id`,`business_date`,`status`,`sort_key`);--> statement-breakpoint
CREATE INDEX `idx_rsv_waitlist_entries_loc_date_phone` ON `rsv_waitlist_entries` (`location_id`,`business_date`,`phone_e164`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_rsv_turn_times_bucket_nullsafe` ON `rsv_turn_times` (`location_id`, coalesce(`service_id`, ''), `party_min`, coalesce(`days_mask`, -1));--> statement-breakpoint
CREATE TRIGGER rsv_occupancy_no_overlap_insert
BEFORE INSERT ON rsv_table_occupancies
WHEN NEW.active = 1 AND NEW.overbook = 0
BEGIN
  SELECT RAISE(ABORT, 'table_overlap')
  WHERE EXISTS (
    SELECT 1 FROM rsv_table_occupancies o
    WHERE o.table_id = NEW.table_id
      AND o.active = 1
      AND o.start_at < NEW.end_at
      AND o.end_at > NEW.start_at
  );
END;--> statement-breakpoint
CREATE TRIGGER rsv_occupancy_no_overlap_update
BEFORE UPDATE ON rsv_table_occupancies
WHEN NEW.active = 1 AND NEW.overbook = 0
BEGIN
  SELECT RAISE(ABORT, 'table_overlap')
  WHERE EXISTS (
    SELECT 1 FROM rsv_table_occupancies o
    WHERE o.table_id = NEW.table_id
      AND o.id <> NEW.id
      AND o.active = 1
      AND o.start_at < NEW.end_at
      AND o.end_at > NEW.start_at
  );
END;--> statement-breakpoint
CREATE TRIGGER rsv_holds_single_conversion
BEFORE UPDATE ON rsv_holds
WHEN OLD.status = 'converted' AND NEW.status = 'converted'
BEGIN
  SELECT RAISE(ABORT, 'hold_already_converted');
END;--> statement-breakpoint
CREATE TRIGGER rsv_reservation_events_no_delete
BEFORE DELETE ON rsv_reservation_events BEGIN SELECT RAISE(ABORT, 'append_only'); END;--> statement-breakpoint
CREATE TRIGGER rsv_reservation_events_no_update
BEFORE UPDATE ON rsv_reservation_events
WHEN NOT (
  NEW.data = '{"redacted":true}'
  AND NEW.id = OLD.id
  AND NEW.reservation_id = OLD.reservation_id
  AND NEW.type = OLD.type
)
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;--> statement-breakpoint
CREATE TRIGGER rsv_audit_log_no_delete
BEFORE DELETE ON rsv_audit_log BEGIN SELECT RAISE(ABORT, 'append_only'); END;--> statement-breakpoint
CREATE TRIGGER rsv_audit_log_no_update
BEFORE UPDATE ON rsv_audit_log
WHEN NOT (
  NEW.changes = '{"redacted":true}'
  AND NEW.id = OLD.id
  AND NEW.entity_id = OLD.entity_id
  AND NEW.action = OLD.action
)
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;--> statement-breakpoint
CREATE TRIGGER rsv_guest_merges_no_delete
BEFORE DELETE ON rsv_guest_merges BEGIN SELECT RAISE(ABORT, 'append_only'); END;--> statement-breakpoint
CREATE TRIGGER rsv_guest_merges_no_update
BEFORE UPDATE ON rsv_guest_merges BEGIN SELECT RAISE(ABORT, 'append_only'); END;