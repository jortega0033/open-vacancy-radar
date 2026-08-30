CREATE TABLE `app_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`launch_at_login` integer DEFAULT false NOT NULL,
	`start_page` text DEFAULT 'search' NOT NULL,
	`theme` text DEFAULT 'system' NOT NULL,
	`density` text DEFAULT 'comfortable' NOT NULL,
	`sidebar_start` text DEFAULT 'remember_last' NOT NULL,
	`sidebar_collapsed` integer DEFAULT false NOT NULL,
	`last_opened_page` text DEFAULT 'search' NOT NULL,
	`default_market` text DEFAULT 'netherlands' NOT NULL,
	`default_location` text DEFAULT '' NOT NULL,
	`sponsor_only_default` integer DEFAULT true NOT NULL,
	`ind_verification_enabled` integer DEFAULT true NOT NULL,
	`default_cv_id` text,
	`default_letter_type` text DEFAULT 'motivation_letter' NOT NULL,
	`default_letter_tone` text DEFAULT 'natural' NOT NULL,
	`default_letter_length` text DEFAULT 'standard' NOT NULL,
	`default_application_status` text DEFAULT 'preparing' NOT NULL,
	`confirm_application_delete` integer DEFAULT true NOT NULL,
	`auto_archive_rejected` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`default_cv_id`) REFERENCES `cv_documents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `applications` (
	`id` text PRIMARY KEY NOT NULL,
	`saved_job_id` text,
	`role` text NOT NULL,
	`company` text NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`market` text NOT NULL,
	`verification` text,
	`status` text DEFAULT 'preparing' NOT NULL,
	`applied_at` integer,
	`next_step` text DEFAULT '' NOT NULL,
	`contact` text DEFAULT '' NOT NULL,
	`cv_id` text,
	`letter_id` text,
	`notes` text DEFAULT '' NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`saved_job_id`) REFERENCES `saved_jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`cv_id`) REFERENCES `cv_documents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`letter_id`) REFERENCES `letters`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `cv_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`target_role` text DEFAULT '' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`profile` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`uploaded_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `letters` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`company` text NOT NULL,
	`role` text NOT NULL,
	`type` text NOT NULL,
	`tone` text NOT NULL,
	`length` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`vacancy_key` text,
	`cv_id` text,
	`body` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`cv_id`) REFERENCES `cv_documents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `saved_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`vacancy_key` text,
	`role` text NOT NULL,
	`company` text NOT NULL,
	`market` text NOT NULL,
	`location` text NOT NULL,
	`salary` text,
	`arrangement` text,
	`verification` text,
	`match_percent` integer,
	`source_url` text,
	`notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'considering' NOT NULL,
	`saved_at` integer NOT NULL
);
