CREATE TABLE `application_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`normalized_key` text NOT NULL,
	`label` text NOT NULL,
	`control_type` text NOT NULL,
	`answer` text NOT NULL,
	`origin_company` text DEFAULT '' NOT NULL,
	`origin_role` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_confirmed_at` integer NOT NULL
);
