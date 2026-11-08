-- Rollout note: this migration deletes duplicate rows (journey runs of
-- once-per-customer triggers, broadcast messages) before it adds unique
-- indexes. Every removed row is copied first to `__archived_journey_runs_0018`,
-- `__archived_journey_step_executions_0018` or
-- `__archived_marketing_messages_0018` (with `archive_reason`), in the same
-- organization database. See docs/platform-marketing-email.md, "Migration
-- archives".
ALTER TABLE `shift_requests` ADD `shift_times` text;--> statement-breakpoint
ALTER TABLE `shifts` ADD `client_request_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_shifts_client_request` ON `shifts` (`created_by`,`client_request_id`) WHERE "shifts"."client_request_id" IS NOT NULL;--> statement-breakpoint
-- Duplicate journey runs: a customer enrolled more than once by a
-- once-per-customer trigger keeps its best run (completed, then running, then
-- failed, then cancelled; the oldest on a tie). The other runs, their step
-- executions and the links from their messages are copied to
-- `__archived_*_0018` tables first, so nothing is lost for good. Child rows are
-- handled here rather than left to ON DELETE actions, which depend on the
-- foreign_keys pragma: step executions are deleted (as the cascade would), and
-- messages keep their row with the step link set to NULL (as SET NULL would).
CREATE TABLE `__archived_journey_runs_0018` AS
SELECT * FROM `journey_runs`
WHERE `rowid` IN (
	SELECT `rowid` FROM (
		SELECT
			`rowid`,
			ROW_NUMBER() OVER (
				PARTITION BY `journey_id`, `customer_id`, `trigger_event`
				ORDER BY
					CASE `status`
						WHEN 'completed' THEN 0
						WHEN 'running' THEN 1
						WHEN 'failed' THEN 2
						WHEN 'cancelled' THEN 3
						ELSE 4
					END,
					COALESCE(`created_at`, 0),
					`rowid`
			) AS `rn`
		FROM `journey_runs`
		WHERE `trigger_event` IN ('phone_verified', 'profile_completed')
	) AS `ranked`
	WHERE `rn` > 1
);--> statement-breakpoint
CREATE TABLE `__archived_journey_step_executions_0018` AS
SELECT * FROM `journey_step_executions`
WHERE `run_id` IN (SELECT `id` FROM `__archived_journey_runs_0018`);--> statement-breakpoint
CREATE TABLE `__archived_marketing_messages_0018` AS
SELECT *, 'journey_step_unlinked' AS `archive_reason` FROM `marketing_messages`
WHERE `journey_step_execution_id` IN (
	SELECT `id` FROM `__archived_journey_step_executions_0018`
);--> statement-breakpoint
UPDATE `marketing_messages` SET `journey_step_execution_id` = NULL
WHERE `journey_step_execution_id` IN (
	SELECT `id` FROM `__archived_journey_step_executions_0018`
);--> statement-breakpoint
DELETE FROM `journey_step_executions`
WHERE `id` IN (SELECT `id` FROM `__archived_journey_step_executions_0018`);--> statement-breakpoint
DELETE FROM `journey_runs`
WHERE `id` IN (SELECT `id` FROM `__archived_journey_runs_0018`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_journey_runs_once_per_customer` ON `journey_runs` (`journey_id`,`customer_id`,`trigger_event`) WHERE "journey_runs"."trigger_event" IN ('phone_verified', 'profile_completed');--> statement-breakpoint
-- Duplicate broadcast messages: two dispatchers that both wrote a row for a
-- recipient. The most engaged row is kept (Clicked, Opened, Delivered/Sent,
-- an unknown outcome, then Failed; the oldest on a tie), and the others are
-- archived before they are deleted.
INSERT INTO `__archived_marketing_messages_0018`
SELECT *, 'duplicate_broadcast' FROM `marketing_messages`
WHERE `rowid` IN (
	SELECT `rowid` FROM (
		SELECT
			`rowid`,
			ROW_NUMBER() OVER (
				PARTITION BY `campaign_id`, `customer_id`
				ORDER BY
					CASE `status`
						WHEN 'Clicked' THEN 0
						WHEN 'Opened' THEN 1
						WHEN 'Delivered' THEN 2
						WHEN 'Sent' THEN 2
						WHEN 'Unknown' THEN 3
						WHEN 'Processing' THEN 3
						WHEN 'Failed' THEN 5
						ELSE 4
					END,
					COALESCE(`sent_at`, 0),
					`rowid`
			) AS `rn`
		FROM `marketing_messages`
		WHERE `campaign_id` IS NOT NULL
	) AS `ranked`
	WHERE `rn` > 1
);--> statement-breakpoint
DELETE FROM `marketing_messages`
WHERE `id` IN (
	SELECT `id` FROM `__archived_marketing_messages_0018`
	WHERE `archive_reason` = 'duplicate_broadcast'
);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_marketing_messages_campaign_customer` ON `marketing_messages` (`campaign_id`,`customer_id`) WHERE "marketing_messages"."campaign_id" IS NOT NULL;
