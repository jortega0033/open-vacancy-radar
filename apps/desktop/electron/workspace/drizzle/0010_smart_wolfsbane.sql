CREATE TABLE `automation_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
ALTER TABLE `application_attempts` ADD `form_structure_hash` text;--> statement-breakpoint
ALTER TABLE `application_attempts` ADD `scheduled_automatic_submit_at` integer;