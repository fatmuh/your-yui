CREATE TABLE `bots` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`persona` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `bots_user_id_created_at_index` ON `bots` (`user_id`,`created_at`);--> statement-breakpoint
-- Hand-edited after `npm run db:generate`: drizzle-kit omits the FK action on
-- ALTER TABLE ADD COLUMN, but the schema declares threads.bot_id with
-- onDelete cascade (deleting a bot removes its threads; messages follow via
-- the threads→messages cascade).
ALTER TABLE `threads` ADD `bot_id` text REFERENCES bots(id) ON UPDATE no action ON DELETE cascade;--> statement-breakpoint
-- Backfill (plan: backfill, never orphan — live user data in data/yui.db must
-- keep reading): every user who already has threads gets one "Yui" bot with
-- the default personal-assistant persona, and all of their existing threads
-- are bound to it. The id is deterministic ('backfill-yui-' || user id) so
-- the UPDATE below can find it without subquery gymnastics; it cannot collide
-- with ULIDs minted by the app (those are uppercase Crockford base32).
-- created_at/updated_at take the user's oldest thread timestamp so the
-- backfilled bot sorts ahead of any bot created later. The persona text is
-- DEFAULT_BOT_PERSONA from src/shared/app.ts, verbatim (English, frozen by the
-- plan's Design Notes) — escaping is trivial because it contains no single
-- quotes.
INSERT INTO `bots` (`id`, `user_id`, `name`, `persona`, `created_at`, `updated_at`)
SELECT
	'backfill-yui-' || `u`.`id`,
	`u`.`id`,
	'Yui',
	'You are a personal assistant. Help with everyday tasks: answering questions, planning, drafting, summarizing, research, and casual conversation. Be warm, direct, and concise. You are not a coding agent — do not assume software tasks unless explicitly asked.',
	COALESCE(MIN(`t`.`created_at`), CAST(strftime('%s', 'now') AS INTEGER) * 1000),
	COALESCE(MIN(`t`.`created_at`), CAST(strftime('%s', 'now') AS INTEGER) * 1000)
FROM `users` `u`
INNER JOIN `threads` `t` ON `t`.`user_id` = `u`.`id`
GROUP BY `u`.`id`;--> statement-breakpoint
UPDATE `threads`
SET `bot_id` = 'backfill-yui-' || `user_id`
WHERE `bot_id` IS NULL;
