CREATE TABLE `audio_blobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`mime` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`blob` blob NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `messages` ADD `audio_id` text REFERENCES audio_blobs(id);