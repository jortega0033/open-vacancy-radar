ALTER TABLE `application_posting_verifications` ADD `held_checkpoint` text;--> statement-breakpoint
ALTER TABLE `application_posting_verifications` ADD `held_checkpoint_detail` text;--> statement-breakpoint
ALTER TABLE `application_posting_verifications` ADD `held_prepared_fields` text;--> statement-breakpoint
CREATE INDEX `application_posting_verifications_attempt_observed_idx` ON `application_posting_verifications` (`attempt_id`,`observed_at`);