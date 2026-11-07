import { sql } from "drizzle-orm";
import type { YuiDatabase } from "../db/index.ts";

// Orphaned image-blob sweep (bot-tool-calling, mirror of the audio sweep in
// ../conversations/audio-gc.ts): an upload and a turn are two separate
// requests, so a blob can be stored and then never attached to any message
// (abandoned attachment, failed send). Those orphans are deleted by a ONE-SHOT
// sweep at server boot — no timer/interval — because the entire state is a
// single SQLite file (AD-2) and boot is the natural choke point. The sweep is
// idempotent: running it again finds nothing new.

/**
 * Grace window before an orphan may be swept: upload → send is a two-request
 * flow, so a fresh orphan gets a day before it counts as abandoned.
 */
export const ORPHAN_IMAGE_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Delete image blobs that are older than the grace window AND not referenced
 * by any message. Returns the number of rows deleted. Referenced blobs are
 * never touched. `messages.image_ids` is a JSON TEXT column (no FK), so the
 * NOT-referenced guard unpacks it with json_each — guarded for NULL rows,
 * which have no references by definition.
 */
export function sweepOrphanImageBlobs(db: YuiDatabase, nowMs: number): number {
  const cutoff = nowMs - ORPHAN_IMAGE_GRACE_MS;
  const swept = db.run(sql`
    DELETE FROM image_blobs
    WHERE created_at < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM messages, json_each(messages.image_ids)
        WHERE messages.image_ids IS NOT NULL AND value = image_blobs.id
      )
  `);
  return swept.changes;
}
