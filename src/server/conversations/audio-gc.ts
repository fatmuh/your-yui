import { sql } from "drizzle-orm";
import type { YuiDatabase } from "../db/index.ts";

// Orphaned audio-blob sweep (epic-voice, AD-5): an upload and a turn are two
// separate requests, so a blob can be stored and then never attached to any
// message (abandoned recording, failed send). Those orphans are deleted by a
// ONE-SHOT sweep at server boot — no timer/interval — because the entire state
// is a single SQLite file (AD-2) and boot is the natural choke point. The
// sweep is idempotent: running it again finds nothing new.

/**
 * Grace window before an orphan may be swept: upload → send is a two-request
 * flow, so a fresh orphan gets a day before it counts as abandoned.
 */
export const ORPHAN_AUDIO_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Delete audio blobs that are older than the grace window AND not referenced
 * by any message. Returns the number of rows deleted. Referenced blobs are
 * never touched — the NOT EXISTS guard is what keeps the sweep from ever
 * tripping the messages.audio_id FK or unlinking a playable note.
 */
export function sweepOrphanAudioBlobs(db: YuiDatabase, nowMs: number): number {
  const cutoff = nowMs - ORPHAN_AUDIO_GRACE_MS;
  const swept = db.run(sql`
    DELETE FROM audio_blobs
    WHERE created_at < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.audio_id = audio_blobs.id)
  `);
  return swept.changes;
}
