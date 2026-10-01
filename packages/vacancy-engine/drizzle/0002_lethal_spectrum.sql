CREATE TABLE `worldwide_sponsor_lookups` (
	`company_key` text PRIMARY KEY NOT NULL,
	`company_name` text NOT NULL,
	`kvk_number` text,
	`resolved_at` integer NOT NULL
);
