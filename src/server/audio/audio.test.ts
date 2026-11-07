import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ulid } from "ulidx";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../app.ts";
import { createDatabase, migrateDatabase, type YuiDatabase } from "../db/index.ts";
import { audioBlobs, users } from "../db/schema.ts";
import { SESSION_COOKIE } from "../auth/cookies.ts";
import { registerUser } from "../../../tests/helpers/api.ts";

// Route-level proof for the audio blob schema + upload/playback API
// (epic-voice, AD-6, AD-9): POST /api/audio and GET /api/audio/:id behind the
// session gate; playback scoped DIRECTLY by blob owner; identical 404s for
// unknown vs foreign ids (no existence leak); the three-layer 5 MB cap (header
// gate, bounded read, exact file size) rejects oversized uploads before
// anything reaches the DB; malformed multipart fields are 400s. Migration 0004
// is clean, idempotent, and its FK cascade is alive.

/** Same value as the route's cap, restated here so the test owns its own literal. */
const CAP_BYTES = 5 * 1024 * 1024;
/**
 * Mirrors the route's framing allowance: multipart framing adds a few hundred
 * bytes on top of the file, so the transport-level ceiling is cap + allowance.
 */
const FRAMING_ALLOWANCE = 64 * 1024;

const tmpRoot = mkdtempSync(join(tmpdir(), "yui-audio-test-"));

const openDbs: YuiDatabase[] = [];
let fileSeq = 0;

function makeApp(): { app: Hono; db: YuiDatabase } {
  const file = join(tmpRoot, `audio-${++fileSeq}.db`);
  const db = createDatabase(file);
  migrateDatabase(db);
  openDbs.push(db);
  return { app: createApp("dist", db), db };
}

/** Deterministic byte pattern that exercises 0x00..0xff values. */
function patternBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (i * 31 + 7) & 0xff;
  }
  return bytes;
}

function audioFile(bytes: Uint8Array, type = "audio/webm"): File {
  return new File([bytes], "note.webm", { type });
}

function audioForm(file?: File, durationMs: string = "1500"): FormData {
  const form = new FormData();
  if (file !== undefined) form.append("file", file);
  form.append("durationMs", durationMs);
  return form;
}

async function postAudio(
  app: Hono,
  token: string | undefined,
  body: FormData | string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return app.request("/api/audio", {
    method: "POST",
    body,
    headers: {
      ...extraHeaders,
      ...(token === undefined ? {} : { cookie: `${SESSION_COOKIE}=${token}` }),
    },
  });
}

async function getAudio(app: Hono, token: string | undefined, audioId: string): Promise<Response> {
  return app.request(`/api/audio/${audioId}`, {
    headers: token === undefined ? {} : { cookie: `${SESSION_COOKIE}=${token}` },
  });
}

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.$client.close();
  }
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("migration 0004", () => {
  it("fresh DB: migrateDatabase applies cleanly, is idempotent, and audio_blobs is queryable", () => {
    const file = join(tmpRoot, `migration-clean-${++fileSeq}.db`);
    const db = createDatabase(file);
    try {
      expect(() => migrateDatabase(db)).not.toThrow();
      // Migrations already recorded in __drizzle_migrations are skipped, so a
      // second run (the server-start pattern) stays safe.
      expect(() => migrateDatabase(db)).not.toThrow();
      expect(db.select().from(audioBlobs).all()).toEqual([]);
    } finally {
      db.$client.close();
    }
  });

  it("deleting a user cascades their audio blobs while another user's blobs survive", async () => {
    const { app, db } = makeApp();
    const userA = await registerUser(app, "audio-terhapus");
    const userB = await registerUser(app, "audio-bertahan");

    const uploadA = await postAudio(app, userA.token, audioForm(audioFile(patternBytes(64))));
    const uploadB = await postAudio(app, userB.token, audioForm(audioFile(patternBytes(64))));
    expect(uploadA.status).toBe(201);
    expect(uploadB.status).toBe(201);
    const idB = ((await uploadB.json()) as { id: string }).id;

    db.delete(users).where(eq(users.id, userA.userId)).run();

    expect(db.select().from(audioBlobs).all().map((row) => row.id)).toEqual([idB]);
    // The surviving blob remains playable by its owner.
    const playback = await getAudio(app, userB.token, idB);
    expect(playback.status).toBe(200);
  });
});

describe("session gate", () => {
  it("POST and GET without a session cookie → 401 unauthorized envelope", async () => {
    const { app } = makeApp();

    const upload = await postAudio(app, undefined, audioForm(audioFile(patternBytes(64))));
    expect(upload.status).toBe(401);
    await expect(upload.json()).resolves.toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    });

    const playback = await getAudio(app, undefined, ulid());
    expect(playback.status).toBe(401);
    await expect(playback.json()).resolves.toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    });
  });
});

describe("upload + playback round trip", () => {
  it("upload 201 {id, mime, durationMs} → GET returns identical bytes, stored mime verbatim, Content-Length", async () => {
    const { app } = makeApp();
    const user = await registerUser(app, "roundtrip");
    const bytes = patternBytes(2048);
    // Mime with a codecs parameter proves verbatim storage — playback writes
    // the stored string back as-is rather than normalizing it.
    const mime = "audio/webm;codecs=opus";

    const upload = await postAudio(app, user.token, audioForm(audioFile(bytes, mime), "1234"));
    expect(upload.status).toBe(201);
    const uploaded = (await upload.json()) as { id: string; mime: string; durationMs: number };
    expect(uploaded).toEqual({ id: expect.any(String), mime, durationMs: 1234 });
    const audioId = uploaded.id;

    const playback = await getAudio(app, user.token, audioId);
    expect(playback.status).toBe(200);
    expect(playback.headers.get("content-type")).toBe(mime);
    expect(playback.headers.get("content-length")).toBe(String(bytes.length));
    const body = new Uint8Array(await playback.arrayBuffer());
    expect(body).toEqual(bytes);
  });

  it("durationMs boundaries 0 and 3600000 are accepted", async () => {
    const { app } = makeApp();
    const user = await registerUser(app, "batas-durasi");

    for (const durationMs of ["0", "3600000"]) {
      const res = await postAudio(app, user.token, audioForm(audioFile(patternBytes(32)), durationMs));
      expect(res.status).toBe(201);
      await expect(res.json()).resolves.toMatchObject({ durationMs: Number(durationMs) });
    }
  });
});

describe("owner-scoped playback", () => {
  it("unknown id vs another user's id → identical 404 envelopes; foreign bytes never leak", async () => {
    const { app } = makeApp();
    const userA = await registerUser(app, "peninjau-audio-a");
    const userB = await registerUser(app, "pemilik-audio-b");
    const secret = patternBytes(128);
    const upload = await postAudio(app, userB.token, audioForm(audioFile(secret)));
    expect(upload.status).toBe(201);
    const audioId = ((await upload.json()) as { id: string }).id;

    const foreign = await getAudio(app, userA.token, audioId);
    expect(foreign.status).toBe(404);

    const missing = await getAudio(app, userA.token, ulid());
    expect(missing.status).toBe(404);

    // Byte-identical bodies: the caller cannot tell "someone else's blob" from
    // "never existed" (a 403 or distinct message would leak existence).
    const foreignBody = await foreign.json();
    const missingBody = await missing.json();
    expect(foreignBody).toEqual({ error: { code: "not_found", message: expect.any(String) } });
    expect(missingBody).toEqual(foreignBody);

    // The owner still gets their bytes.
    const owner = await getAudio(app, userB.token, audioId);
    expect(owner.status).toBe(200);
  });
});

describe("5 MB cap (header gate, bounded read, exact file size)", () => {
  it("buffered: an actual 5 MB + 1 byte upload → 413, nothing stored", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "kebesaran-buffer");

    const res = await postAudio(app, user.token, audioForm(audioFile(new Uint8Array(CAP_BYTES + 1))));
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({
      error: { code: "payload_too_large", message: expect.any(String) },
    });
    expect(db.select().from(audioBlobs).all()).toEqual([]);
  });

  it("header: Content-Length above cap + framing allowance → 413 before the body is read", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "kebesaran-header");

    // A non-multipart body: if the guard did not fire first, parsing would
    // fail and answer 400 — asserting 413 proves the pre-read ordering.
    const res = await postAudio(app, user.token, "this is not multipart", {
      "content-type": "text/plain",
      "content-length": String(CAP_BYTES + FRAMING_ALLOWANCE + 1),
    });
    expect(res.status).toBe(413);
    expect(db.select().from(audioBlobs).all()).toEqual([]);
  });

  it("honest browser upload of exactly 5 MB (Content-Length includes framing) → 201", async () => {
    const { app } = makeApp();
    const user = await registerUser(app, "tepat-lima-wire");

    // Serialize the multipart body the way a browser would, then set the REAL
    // byte size as Content-Length: framing adds a few hundred bytes on top of
    // the 5 MB file, so a header gate without a framing allowance would 413
    // this honest upload before the exact file-size check could accept it.
    const serialized = new Request("http://yui.local/upload", {
      method: "POST",
      body: audioForm(audioFile(new Uint8Array(CAP_BYTES))),
    });
    const bytes = new Uint8Array(await serialized.arrayBuffer());
    const res = await app.request("/api/audio", {
      method: "POST",
      body: bytes,
      headers: {
        cookie: `${SESSION_COOKIE}=${user.token}`,
        "content-type": serialized.headers.get("content-type") ?? "",
        "content-length": String(bytes.byteLength),
      },
    });
    expect(res.status).toBe(201);
  });

  it("chunked upload without Content-Length over the cap → 413 via the bounded read", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "chunked-kebesaran");

    // No Content-Length header: the header gate cannot fire, so the body is
    // streamed — the bounded read must cut it off at cap + allowance instead
    // of buffering the whole stream before rejecting.
    const total = CAP_BYTES + FRAMING_ALLOWANCE + 1;
    const chunk = new Uint8Array(64 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let sent = 0; sent < total; sent += chunk.length) {
          controller.enqueue(chunk.subarray(0, Math.min(chunk.length, total - sent)));
        }
        controller.close();
      },
    });
    // `duplex: "half"` is required for streaming request bodies; the DOM
    // RequestInit type does not model it, so widen the init object's type.
    const init: RequestInit & { duplex?: "half" } = {
      method: "POST",
      headers: {
        cookie: `${SESSION_COOKIE}=${user.token}`,
        "content-type": "multipart/form-data; boundary=x",
      },
      body: stream,
      duplex: "half",
    };
    const res = await app.request(new Request("http://yui.local/api/audio", init));
    expect(res.status).toBe(413);
    expect(db.select().from(audioBlobs).all()).toEqual([]);
  });

  it("exactly 5 MB is accepted — the cap is inclusive", async () => {
    const { app } = makeApp();
    const user = await registerUser(app, "pas-lima-mb");

    const res = await postAudio(app, user.token, audioForm(audioFile(new Uint8Array(CAP_BYTES))));
    expect(res.status).toBe(201);
    const audioId = ((await res.json()) as { id: string }).id;
    const playback = await getAudio(app, user.token, audioId);
    expect(playback.status).toBe(200);
    expect(playback.headers.get("content-length")).toBe(String(CAP_BYTES));
  });

  it("after mixed uploads, no stored row ever exceeds the cap", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "sapu-cap");

    const first = await postAudio(app, user.token, audioForm(audioFile(patternBytes(1024))));
    const rejected = await postAudio(app, user.token, audioForm(audioFile(new Uint8Array(CAP_BYTES + 1))));
    const second = await postAudio(app, user.token, audioForm(audioFile(patternBytes(2048))));
    expect(first.status).toBe(201);
    expect(rejected.status).toBe(413);
    expect(second.status).toBe(201);

    const rows = db.select().from(audioBlobs).all();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.blob.byteLength).toBeLessThanOrEqual(CAP_BYTES);
    }
  });
});

describe("field validation", () => {
  it("non-audio mime → 400 invalid_request", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "mime-salah");

    const res = await postAudio(app, user.token, audioForm(audioFile(patternBytes(64), "video/mp4")));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: { code: "invalid_request", message: expect.any(String) },
    });
    expect(db.select().from(audioBlobs).all()).toEqual([]);
  });

  it("invalid durationMs ('abc', negative, over one hour, empty, missing) → 400", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "durasi-salah");

    for (const durationMs of ["abc", "-1", "3600001", "1.5", ""]) {
      const res = await postAudio(app, user.token, audioForm(audioFile(patternBytes(32)), durationMs));
      expect(res.status, `durationMs=${durationMs}`).toBe(400);
    }

    const form = new FormData();
    form.append("file", audioFile(patternBytes(32)));
    const noDuration = await postAudio(app, user.token, form);
    expect(noDuration.status).toBe(400);

    expect(db.select().from(audioBlobs).all()).toEqual([]);
  });

  it("missing file field, or file sent as plain text → 400", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "file-hilang");

    const missing = await postAudio(app, user.token, audioForm(undefined));
    expect(missing.status).toBe(400);

    const asText = new FormData();
    asText.append("file", "not a file at all");
    asText.append("durationMs", "1500");
    const stringFile = await postAudio(app, user.token, asText);
    expect(stringFile.status).toBe(400);

    expect(db.select().from(audioBlobs).all()).toEqual([]);
  });
});
