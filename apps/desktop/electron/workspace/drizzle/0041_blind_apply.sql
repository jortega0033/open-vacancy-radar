CREATE TABLE `blind_apply_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`match_key` text NOT NULL,
	`label` text NOT NULL,
	`control_type` text NOT NULL,
	`answer` text NOT NULL,
	`option_set_hash` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blind_apply_answers_match_key_idx` ON `blind_apply_answers` (`match_key`);--> statement-breakpoint
CREATE TABLE `blind_apply_authorizations` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`role_families` text NOT NULL,
	`filters_snapshot` text NOT NULL,
	`filters_hash` text NOT NULL,
	`profile_version` text NOT NULL,
	`source_cv_id` text,
	`source_cv_content_hash` text NOT NULL,
	`use_saved_answers` integer NOT NULL,
	`policy_ids` text NOT NULL,
	`confirm_text_hash` text NOT NULL,
	`stopped_at` integer,
	`stop_reason` text
);
--> statement-breakpoint
CREATE TABLE `blind_apply_events` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`at` integer NOT NULL,
	`from_state` text,
	`to_state` text NOT NULL,
	`kind` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`cv_artifact_hash` text,
	`letter_artifact_hash` text,
	`answers` text,
	`receipt_id` text,
	`posting_verification_id` text,
	FOREIGN KEY (`item_id`) REFERENCES `blind_apply_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `blind_apply_events_item_idx` ON `blind_apply_events` (`item_id`,`at`);--> statement-breakpoint
CREATE TABLE `blind_apply_items` (
	`id` text PRIMARY KEY NOT NULL,
	`authorization_id` text NOT NULL,
	`vacancy_key` text NOT NULL,
	`identity_key` text NOT NULL,
	`company` text NOT NULL,
	`role` text NOT NULL,
	`apply_url` text NOT NULL,
	`policy_id` text,
	`attempt_id` text,
	`state` text NOT NULL,
	`state_detail` text DEFAULT '' NOT NULL,
	`skip_reason` text,
	`intervention` text,
	`missing_fields` text,
	`gate_evidence` text NOT NULL,
	`prep_retries` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`authorization_id`) REFERENCES `blind_apply_authorizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `application_attempts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blind_apply_items_auth_vacancy_idx` ON `blind_apply_items` (`authorization_id`,`vacancy_key`);--> statement-breakpoint
CREATE INDEX `blind_apply_items_identity_idx` ON `blind_apply_items` (`identity_key`);--> statement-breakpoint
CREATE INDEX `blind_apply_items_state_idx` ON `blind_apply_items` (`state`);