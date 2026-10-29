CREATE TABLE `application_brief_aliases` (
	`alias_key` text PRIMARY KEY NOT NULL,
	`brief_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`provider` text,
	`url` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`brief_id`) REFERENCES `application_briefs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `application_brief_aliases_brief_idx` ON `application_brief_aliases` (`brief_id`);--> statement-breakpoint
CREATE TABLE `application_brief_pins` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`snapshot` text NOT NULL,
	`pinned_at` integer NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `application_attempts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `application_briefs` (
	`id` text PRIMARY KEY NOT NULL,
	`identity_key` text NOT NULL,
	`identity_kind` text NOT NULL,
	`employer_key` text,
	`requisition_id` text,
	`company` text NOT NULL,
	`role` text NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`source_facts` text,
	`jd_text` text,
	`jd_hash` text,
	`jd_complete` integer DEFAULT true NOT NULL,
	`jd_captured_at` integer,
	`jd_changed_at` integer,
	`assessment` text,
	`notices` text DEFAULT '[]' NOT NULL,
	`facts_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `application_briefs_identity_idx` ON `application_briefs` (`identity_key`);