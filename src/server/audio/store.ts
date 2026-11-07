import { and, eq } from "drizzle-orm";
import { ulid } from "ulidx";
import { audioBlobs, type AudioBlob } from "../db/schema.ts";
import type { YuiDatabase } from "../db/index.ts";

// Pure-DB audio blob store (epic-voice, AD-6): every query scopes ownership in
// SQL — same rule as conversations/store.ts — and ids are ULIDs minted by the
// server, never taken from the client. The routes stay thin; story 2's turn
// route reuses `resolveAudioBlob` as the frozen attach-validation seam.

/** Values for a new blob; id and createdAt are minted here, not by callers. */
export type NewAudioBlob = {
  mime: string;
  durationMs: number;
  blob: Buffer;
};

/** Insert one blob owned by `userId` and return the stored row. */
export function insertAudioBlob(db: YuiDatabase, userId: string, input: NewAudioBlob): AudioBlob {
  const row: AudioBlob = {
    id: ulid(),
    ownerUserId: userId,
    mime: input.mime,
    durationMs: input.durationMs,
    blob: input.blob,
    createdAt: Date.now(),
  };
  db.insert(audioBlobs).values(row).run();
  return row;
}

/**
 * Blob `audioId` owned by `userId`, or null when it does not exist OR belongs
 * to someone else. Scoping is DIRECTLY by blob owner (AD-6) — never via a
 * thread join — and the route maps both null cases to an identical 404 so the
 * existence of another user's blob never leaks.
 */
export function getAudioById(db: YuiDatabase, userId: string, audioId: string): AudioBlob | null {
  return (
    db
      .select()
      .from(audioBlobs)
      .where(and(eq(audioBlobs.id, audioId), eq(audioBlobs.ownerUserId, userId)))
      .get() ?? null
  );
}

/**
 * Frozen helper for story 2 (turn route attach validation): same owner-scoped
 * semantics as getAudioById, kept as its own export so the turn route has a
 * stable seam independent of the playback route's read path.
 */
export function resolveAudioBlob(db: YuiDatabase, userId: string, audioId: string): AudioBlob | null {
  return getAudioById(db, userId, audioId);
}

/**
 * Single source of truth for the text stored as a voice-note user message:
 * `[Voice note: m:ss]` with zero-padded seconds (42000 → "[Voice note: 0:42]",
 * 125000 → "[Voice note: 2:05]"). The turn route derives it from the stored
 * blob's durationMs; history and the engine transcript then read it back as
 * plain message text, so the format is derived in exactly one place and the
 * client only renders durationMs from the DTO.
 */
export function voiceNotePlaceholder(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `[Voice note: ${minutes}:${String(seconds).padStart(2, "0")}]`;
}
