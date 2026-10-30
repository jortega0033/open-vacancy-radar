CREATE TABLE `application_action_prefs` (
	`application_id` text PRIMARY KEY NOT NULL,
	`suggestions_suppressed` integer DEFAULT false NOT NULL,
	`suppressed_at` integer,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `application_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`request_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`channel` text DEFAULT 'unspecified' NOT NULL,
	`contact_detail` text DEFAULT '' NOT NULL,
	`due_kind` text NOT NULL,
	`due_date` text,
	`due_local` text,
	`due_time_zone` text NOT NULL,
	`due_utc_offset_minutes` integer,
	`due_resolution` text,
	`due_at` integer NOT NULL,
	`first_due_at` integer NOT NULL,
	`reschedule_count` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`origin` text DEFAULT 'user' NOT NULL,
	`basis_class` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	`dismissed_at` integer,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `application_actions_request_idx` ON `application_actions` (`application_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `application_actions_application_idx` ON `application_actions` (`application_id`);--> statement-breakpoint
CREATE TABLE `application_follow_up_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`action_id` text,
	`request_id` text NOT NULL,
	`kind` text NOT NULL,
	`basis` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`generated_body` text NOT NULL,
	`body` text NOT NULL,
	`generated_hash` text NOT NULL,
	`body_hash` text NOT NULL,
	`status` text DEFAULT 'prepared' NOT NULL,
	`approved_at` integer,
	`send_state` text DEFAULT 'not_sent' NOT NULL,
	`sent_reported_at` integer,
	`sent_on` text,
	`provider` text NOT NULL,
	`usage` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`action_id`) REFERENCES `application_actions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `application_follow_up_drafts_request_idx` ON `application_follow_up_drafts` (`application_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `application_follow_up_drafts_application_idx` ON `application_follow_up_drafts` (`application_id`);