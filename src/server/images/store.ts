import { and, eq } from "drizzle-orm";
import { ulid } from "ulidx";
import { imageBlobs, type ImageBlob } from "../db/schema.ts";
import type { YuiDatabase } from "../db/index.ts";

// Pure-DB image blob store (bot-tool-calling epic, AD-6): the MIRROR of the
// audio protocol — every query scopes ownership in SQL, ids are ULIDs minted
// by the server (never taken from the client), and the routes stay thin. The
// turn route reuses `resolveImageBlob` as the frozen attach-validation seam.

/** Values for a new blob; id and createdAt are minted here, not by callers. */
export type NewImageBlob = {
  mime: string;
  blob: Buffer;
};

/** Insert one image blob owned by `userId` and return the stored row. */
export function insertImageBlob(db: YuiDatabase, userId: string, input: NewImageBlob): ImageBlob {
  const row: ImageBlob = {
    id: ulid(),
    ownerUserId: userId,
    mime: input.mime,
    blob: input.blob,
    createdAt: Date.now(),
  };
  db.insert(imageBlobs).values(row).run();
  return row;
}

/**
 * Blob `imageId` owned by `userId`, or null when it does not exist OR belongs
 * to someone else. Scoping is DIRECTLY by blob owner (AD-6) — the route maps
 * both null cases to one identical 404 so another user's blob never leaks.
 */
export function getImageById(db: YuiDatabase, userId: string, imageId: string): ImageBlob | null {
  return (
    db
      .select()
      .from(imageBlobs)
      .where(and(eq(imageBlobs.id, imageId), eq(imageBlobs.ownerUserId, userId)))
      .get() ?? null
  );
}

/**
 * Frozen seam for the turn route (attach validation): same owner-scoped
 * semantics as getImageById, kept as its own export mirroring the audio
 * store's resolveAudioBlob.
 */
export function resolveImageBlob(db: YuiDatabase, userId: string, imageId: string): ImageBlob | null {
  return getImageById(db, userId, imageId);
}

/**
 * Single source of truth for the text stored as an image-only user message
 * (mirrors voiceNotePlaceholder): `[Image]` for one attachment, `[Image x3]`
 * for several. History and the engine transcript read it back as plain
 * message text; the client renders thumbnails from the DTO, never this text.
 */
export function imageNotePlaceholder(count: number): string {
  return count <= 1 ? "[Image]" : `[Image x${count}]`;
}
