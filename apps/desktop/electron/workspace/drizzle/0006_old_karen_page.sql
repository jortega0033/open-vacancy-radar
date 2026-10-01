ALTER TABLE `app_settings` DROP COLUMN `default_market`;--> statement-breakpoint
ALTER TABLE `app_settings` DROP COLUMN `sponsor_only_default`;--> statement-breakpoint
ALTER TABLE `app_settings` DROP COLUMN `ind_verification_enabled`;--> statement-breakpoint
ALTER TABLE `applications` DROP COLUMN `market`;--> statement-breakpoint
ALTER TABLE `saved_jobs` DROP COLUMN `market`;