-- Rollout note: impersonation sessions are short-lived (15 minutes). Any
-- admin with more than one row keeps only the newest before the unique index.
DELETE FROM `ImpersonationSession` WHERE `rowid` NOT IN (SELECT MAX(`rowid`) FROM `ImpersonationSession` GROUP BY `adminUserId`);--> statement-breakpoint
DROP INDEX `ImpersonationSession_adminUserId_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `ImpersonationSession_adminUserId_key` ON `ImpersonationSession` (`adminUserId`);
