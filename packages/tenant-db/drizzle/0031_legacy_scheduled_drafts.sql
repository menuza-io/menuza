-- Before broadcasts had a dispatcher, a scheduled broadcast was saved as
-- `Draft` with `scheduled_at` set, and nothing ever sent it. The dispatcher
-- claims only `Scheduled` rows. A legacy draft whose time is still ahead
-- becomes `Scheduled`, so it goes out as the operator planned: this sends real
-- email and SMS at that time. One whose time has passed stays a `Draft`, which
-- is never sent, so the operator can reschedule it. `scheduled_at` is stored in
-- whole seconds; "ahead" is judged when this organization's database migrates.
UPDATE `marketing_campaigns`
SET `status` = 'Scheduled'
WHERE `status` = 'Draft'
	AND `scheduled_at` IS NOT NULL
	AND `scheduled_at` > CAST(strftime('%s', 'now') AS INTEGER);
