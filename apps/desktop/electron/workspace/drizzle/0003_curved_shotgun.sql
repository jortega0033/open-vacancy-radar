ALTER TABLE `app_settings` ADD `agent_selected_session_id` text;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `agent_archived_session_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `agent_unread_counts` text DEFAULT '{}' NOT NULL;