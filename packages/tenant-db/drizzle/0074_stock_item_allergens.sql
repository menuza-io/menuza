ALTER TABLE `inv_items` ADD `allergens` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `inv_items` ADD `allergens_confirmed` integer DEFAULT false NOT NULL;