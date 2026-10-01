PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_app_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`launch_at_login` integer DEFAULT false NOT NULL,
	`start_page` text DEFAULT 'search' NOT NULL,
	`theme` text DEFAULT 'system' NOT NULL,
	`density` text DEFAULT 'comfortable' NOT NULL,
	`sidebar_start` text DEFAULT 'remember_last' NOT NULL,
	`sidebar_collapsed` integer DEFAULT false NOT NULL,
	`last_opened_page` text DEFAULT 'search' NOT NULL,
	`default_market` text DEFAULT 'worldwide' NOT NULL,
	`default_location` text DEFAULT '' NOT NULL,
	`sponsor_only_default` integer DEFAULT false NOT NULL,
	`ind_verification_enabled` integer DEFAULT false NOT NULL,
	`default_cv_id` text,
	`default_letter_type` text DEFAULT 'motivation_letter' NOT NULL,
	`default_letter_tone` text DEFAULT 'natural' NOT NULL,
	`default_letter_length` text DEFAULT 'standard' NOT NULL,
	`default_application_status` text DEFAULT 'preparing' NOT NULL,
	`confirm_application_delete` integer DEFAULT true NOT NULL,
	`auto_archive_rejected` integer DEFAULT false NOT NULL,
	`default_provider` text DEFAULT 'claude' NOT NULL,
	`agent_selected_session_id` text,
	`agent_archived_session_ids` text DEFAULT '[]' NOT NULL,
	`agent_unread_counts` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`default_cv_id`) REFERENCES `cv_documents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_app_settings`("id", "launch_at_login", "start_page", "theme", "density", "sidebar_start", "sidebar_collapsed", "last_opened_page", "default_market", "default_location", "sponsor_only_default", "ind_verification_enabled", "default_cv_id", "default_letter_type", "default_letter_tone", "default_letter_length", "default_application_status", "confirm_application_delete", "auto_archive_rejected", "default_provider", "agent_selected_session_id", "agent_archived_session_ids", "agent_unread_counts") SELECT "id", "launch_at_login", "start_page", "theme", "density", "sidebar_start", "sidebar_collapsed", "last_opened_page", "default_market", "default_location", "sponsor_only_default", "ind_verification_enabled", "default_cv_id", "default_letter_type", "default_letter_tone", "default_letter_length", "default_application_status", "confirm_application_delete", "auto_archive_rejected", "default_provider", "agent_selected_session_id", "agent_archived_session_ids", "agent_unread_counts" FROM `app_settings`;--> statement-breakpoint
DROP TABLE `app_settings`;--> statement-breakpoint
ALTER TABLE `__new_app_settings` RENAME TO `app_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;