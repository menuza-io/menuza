CREATE TABLE `pos_hosts` (
	`staff_id` text PRIMARY KEY NOT NULL,
	`guest_details` integer DEFAULT false NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE cascade
);
