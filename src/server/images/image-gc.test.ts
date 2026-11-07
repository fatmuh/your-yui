import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { ulid } from "ulidx";
import { createApp } from "../app.ts";
import { createDatabase, migrateDatabase, type YuiDatabase } from "../db/index.ts";
import { imageBlobs, messages } from "../db/schema.ts";
import { SESSION_COOKIE } from "../auth/cookies.ts";
import { imageNotePlaceholder } from "./store.ts";
import { insertBot } from "../bots/store.ts";
import { createThreadWithMessage } from "../conversations/turn-store.ts";
import { ORPHAN_IMAGE_GRACE_MS, sweepOrphanImageBlobs } from "./image-gc.ts";
import { registerUser } from "../../../tests/helpers/api.ts";

// Unit proof for the boot orphan sweep of image blobs (mirror of the audio
// sweep's test): only OLD ORPHANS are deleted. An old blob still referenced
// through messages.image_ids (a JSON TEXT column with NO FK — the json_each
// NOT EXISTS guard is the only protection) survives with its message and its
// owner-scoped preview intact, and a fresh orphan survives the 24h grace
// because upload → send is a two-request flow.

const tmpRoot = mkdtempSync(join(tmpdir(), "yui-image-gc-test-"));

const openDbs: YuiDatabase[] = [];
let fileSeq = 0;

function makeApp(): { app: Hono; db: YuiDatabase } {
  const file = join(tmpRoot, `image-gc-${++fileSeq}.db`);
  const db = createDatabase(file);
  migrateDatabase(db);
  openDbs.push(db);
  return { app: createApp("dist", db), db };
}

/** Blob row with an explicit createdAt — the store helper mints Date.now(). */
function seedBlob(db: YuiDatabase, userId: string, createdAt: number, bytes = 64): string {
  const id = ulid();
  db.insert(imageBlobs)
    .values({
      id,
      ownerUserId: userId,
      mime: "image/png",
      blob: Buffer.alloc(bytes, 7),
      createdAt,
    })
    .run();
  return id;
}

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.$client.close();
  }
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("sweepOrphanImageBlobs", () => {
  it("deletes only the old orphan; the old attached blob and the fresh orphan survive, and the count is returned", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "gc-gambar");
    // Fixed clock: cutoffs are deterministic, nothing depends on wall time.
    const now = Date.UTC(2026, 10, 7, 9, 0, 0);
    const twentyFiveHours = 25 * 60 * 60 * 1000;

    const oldOrphan = seedBlob(db, user.userId, now - twentyFiveHours);
    const freshOrphan = seedBlob(db, user.userId, now - 60 * 60 * 1000);
    const attached = seedBlob(db, user.userId, now - twentyFiveHours, 128);

    // Attach `attached` through the turn-store writer — the same path an
    // image turn takes: placeholder text + JSON blob-id refs on the user
    // message. The writer requires the thread's owning bot (multi-bot
    // harness binding).
    const bot = insertBot(db, user.userId, { name: "Image GC Bot", persona: "" });
    const created = createThreadWithMessage(
      db,
      user.userId,
      bot.id,
      imageNotePlaceholder(1),
      now - twentyFiveHours,
      undefined,
      [attached],
    );
    expect(created).not.toBeNull();

    expect(sweepOrphanImageBlobs(db, now)).toBe(1);
    // The old orphan is the one row that disappeared.
    expect(db.select().from(imageBlobs).all().map((row) => row.id)).not.toContain(oldOrphan);

    const remaining = db.select().from(imageBlobs).all().map((row) => row.id).sort();
    expect(remaining).toEqual([attached, freshOrphan].sort());

    // The attached blob's message is intact and the image is still servable
    // through the owner-scoped preview route (real bytes back).
    const stored = db.select().from(messages).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.text).toBe("[Image]");
    expect(JSON.parse(stored[0]!.imageIds ?? "[]")).toEqual([attached]);
    const preview = await app.request(`/api/images/${attached}`, {
      headers: { cookie: `${SESSION_COOKIE}=${user.token}` },
    });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-length")).toBe("128");

    // Idempotent: a second sweep over the same state finds nothing.
    expect(sweepOrphanImageBlobs(db, now)).toBe(0);
  });

  it("boundary: a blob exactly at the 24h grace edge is NOT swept (strict <)", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "gc-gambar-batas");
    const now = Date.UTC(2026, 10, 7, 9, 0, 0);

    const exactlyGraceOld = seedBlob(db, user.userId, now - ORPHAN_IMAGE_GRACE_MS);
    const oneMsOlder = seedBlob(db, user.userId, now - ORPHAN_IMAGE_GRACE_MS - 1);

    expect(sweepOrphanImageBlobs(db, now)).toBe(1);
    const remaining = db.select().from(imageBlobs).all().map((row) => row.id);
    expect(remaining).toEqual([exactlyGraceOld]);
    expect(remaining).not.toContain(oneMsOlder);
  });
});
