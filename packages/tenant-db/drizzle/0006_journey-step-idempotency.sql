-- Deduplicate any existing (run_id, node_id) rows before adding the unique index.
-- Prefer delivered/completed rows, then the most recently executed.
DELETE FROM `journey_step_executions`
WHERE `rowid` NOT IN (
	SELECT `rowid`
	FROM (
		SELECT
			`rowid`,
			ROW_NUMBER() OVER (
				PARTITION BY `run_id`, `node_id`
				ORDER BY
					CASE `status`
						WHEN 'delivered' THEN 0
						WHEN 'completed' THEN 1
						WHEN 'processing' THEN 2
						ELSE 3
					END,
					COALESCE(`executed_at`, 0) DESC
			) AS `rn`
		FROM `journey_step_executions`
	) AS `ranked`
	WHERE `rn` = 1
);
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_journey_step_executions_run`;
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_journey_step_executions_run_node` ON `journey_step_executions` (`run_id`,`node_id`);
