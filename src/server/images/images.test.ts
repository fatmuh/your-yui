import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ulid } from "ulidx";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../app.ts";
import { createDatabase, migrateDatabase, type YuiDatabase } from "../db/index.ts";
import { imageBlobs, users } from "../db/schema.ts";
import { SESSION_COOKIE } from "../auth/cookies.ts";
import { registerUser } from "../../../tests/helpers/api.ts";

// Route-level proof for the image blob schema + upload/preview API
// (bot-tool-calling epic, AD-6, AD-9) — a MIRROR of the audio route tests:
// POST /api/images and GET /api/images/:id behind the session gate; preview
// scoped DIRECTLY by blob owner; identical 404s for unknown vs foreign ids (no
// existence leak); the three-layer 5 MB cap; non-image mimes are 400s.
// Migration 0006 is clean, idempotent, and its FK cascade is alive.

/** Same value as the route's cap, restated here so the test owns its literal. */
const CAP_BYTES = 5 * 1024 * 1024;
/** Mirrors the route's framing allowance (multipart overhead ceiling). */
const FRAMING_ALLOWANCE = 64 * 1024;

const tmpRoot = mkdtempSync(join(tmpdir(), "yui-images-test-"));

const openDbs: YuiDatabase[] = [];
let fileSeq = 0;

function makeApp(): { app: Hono; db: YuiDatabase } {
  const file = join(tmpRoot, `images-${++fileSeq}.db`);
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

function imageFile(bytes: Uint8Array, type = "image/png"): File {
  return new File([bytes], "image.png", { type });
}

function imageForm(file?: File): FormData {
  const form = new FormData();
  if (file !== undefined) form.append("file", file);
  return form;
}

async function postImage(
  app: Hono,
  token: string | undefined,
  body: FormData | string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return app.request("/api/images", {
    method: "POST",
    body,
    headers: {
      ...extraHeaders,
      ...(token === undefined ? {} : { cookie: `${SESSION_COOKIE}=${token}` }),
    },
  });
}

async function getImage(app: Hono, token: string | undefined, imageId: string): Promise<Response> {
  return app.request(`/api/images/${imageId}`, {
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

describe("migration 0006", () => {
  it("fresh DB: migrateDatabase applies cleanly, is idempotent, and image_blobs is queryable", () => {
    const file = join(tmpRoot, `migration-clean-${++fileSeq}.db`);
    const db = createDatabase(file);
    try {
      expect(() => migrateDatabase(db)).not.toThrow();
      expect(() => migrateDatabase(db)).not.toThrow();
      expect(db.select().from(imageBlobs).all()).toEqual([]);
    } finally {
      db.$client.close();
    }
  });

  it("deleting a user cascades their image blobs while another user's blobs survive", async () => {
    const { app, db } = makeApp();
    const userA = await registerUser(app, "gambar-terhapus");
    const userB = await registerUser(app, "gambar-bertahan");

    const uploadA = await postImage(app, userA.token, imageForm(imageFile(patternBytes(64))));
    const uploadB = await postImage(app, userB.token, imageForm(imageFile(patternBytes(64))));
    expect(uploadA.status).toBe(201);
    expect(uploadB.status).toBe(201);
    const idB = ((await uploadB.json()) as { id: string }).id;

    db.delete(users).where(eq(users.id, userA.userId)).run();

    expect(db.select().from(imageBlobs).all().map((row) => row.id)).toEqual([idB]);
    const preview = await getImage(app, userB.token, idB);
    expect(preview.status).toBe(200);
  });
});

describe("session gate", () => {
  it("POST and GET without a session cookie → 401 unauthorized envelope", async () => {
    const { app } = makeApp();

    const upload = await postImage(app, undefined, imageForm(imageFile(patternBytes(64))));
    expect(upload.status).toBe(401);
    await expect(upload.json()).resolves.toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    });

    const preview = await getImage(app, undefined, ulid());
    expect(preview.status).toBe(401);
    await expect(preview.json()).resolves.toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    });
  });
});

describe("upload + preview round trip", () => {
  it("upload 201 {id, mime} → GET returns identical bytes, stored mime verbatim, Content-Length", async () => {
    const { app } = makeApp();
    const user = await registerUser(app, "putar-balik");
    const bytes = patternBytes(2048);

    const upload = await postImage(app, user.token, imageForm(imageFile(bytes)));
    expect(upload.status).toBe(201);
    const uploaded = (await upload.json()) as { id: string; mime: string };
    expect(uploaded).toEqual({ id: expect.any(String), mime: "image/png" });
    const imageId = uploaded.id;

    const preview = await getImage(app, user.token, imageId);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/png");
    expect(preview.headers.get("content-length")).toBe(String(bytes.length));
    // The preview must not be re-sniffed into an executable type.
    expect(preview.headers.get("x-content-type-options")).toBe("nosniff");
    const body = new Uint8Array(await preview.arrayBuffer());
    expect(body).toEqual(bytes);
  });

  it("image/svg+xml is refused (400) even though it starts with image/", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "svg-ditolak");
    // An SVG carries script that would execute same-origin on preview — the
    // route must reject it before anything is stored.
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    const upload = await postImage(app, user.token, imageForm(imageFile(svg, "image/svg+xml")));
    expect(upload.status).toBe(400);
    await expect(upload.json()).resolves.toEqual({
      error: { code: "invalid_request", message: expect.stringContaining("SVG") },
    });
    expect(db.select().from(imageBlobs).all()).toEqual([]);
  });

  it("a zero-byte image file is refused (400), storing nothing", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "gambar-kosong");
    const upload = await postImage(app, user.token, imageForm(imageFile(new Uint8Array(0))));
    expect(upload.status).toBe(400);
    await expect(upload.json()).resolves.toEqual({
      error: { code: "invalid_request", message: expect.any(String) },
    });
    expect(db.select().from(imageBlobs).all()).toEqual([]);
  });
});

describe("owner-scoped preview", () => {
  it("unknown id vs another user's id → identical 404 envelopes; foreign bytes never leak", async () => {
    const { app } = makeApp();
    const userA = await registerUser(app, "peninjau-gambar-a");
    const userB = await registerUser(app, "pemilik-gambar-b");
    const secret = patternBytes(128);
    const upload = await postImage(app, userB.token, imageForm(imageFile(secret)));
    expect(upload.status).toBe(201);
    const imageId = ((await upload.json()) as { id: string }).id;

    const foreign = await getImage(app, userA.token, imageId);
    expect(foreign.status).toBe(404);

    const missing = await getImage(app, userA.token, ulid());
    expect(missing.status).toBe(404);

    // Byte-identical bodies: "someone else's blob" is indistinguishable from
    // "never existed" (anti-enumeration, same convention as audio).
    const foreignBody = await foreign.json();
    const missingBody = await missing.json();
    expect(foreignBody).toEqual({ error: { code: "not_found", message: expect.any(String) } });
    expect(missingBody).toEqual(foreignBody);

    const owner = await getImage(app, userB.token, imageId);
    expect(owner.status).toBe(200);
  });
});

describe("5 MB cap (header gate, bounded read, exact file size)", () => {
  it("buffered: an actual 5 MB + 1 byte upload → 413, nothing stored", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "kebesaran-buffer");

    const res = await postImage(app, user.token, imageForm(imageFile(new Uint8Array(CAP_BYTES + 1))));
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({
      error: { code: "payload_too_large", message: expect.any(String) },
    });
    expect(db.select().from(imageBlobs).all()).toEqual([]);
  });

  it("header: Content-Length above cap + framing allowance → 413 before the body is read", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "kebesaran-header");

    // A non-multipart body: if the guard did not fire first, parsing would
    // fail and answer 400 — asserting 413 proves the pre-read ordering.
    const res = await postImage(app, user.token, "this is not multipart", {
      "content-type": "text/plain",
      "content-length": String(CAP_BYTES + FRAMING_ALLOWANCE + 1),
    });
    expect(res.status).toBe(413);
    expect(db.select().from(imageBlobs).all()).toEqual([]);
  });

  it("chunked upload without Content-Length over the cap → 413 via the bounded read", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "chunked-kebesaran");

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
    const init: RequestInit & { duplex?: "half" } = {
      method: "POST",
      headers: {
        cookie: `${SESSION_COOKIE}=${user.token}`,
        "content-type": "multipart/form-data; boundary=x",
      },
      body: stream,
      duplex: "half",
    };
    const res = await app.request(new Request("http://yui.local/api/images", init));
    expect(res.status).toBe(413);
    expect(db.select().from(imageBlobs).all()).toEqual([]);
  });

  it("exactly 5 MB is accepted — the cap is inclusive", async () => {
    const { app } = makeApp();
    const user = await registerUser(app, "pas-lima-mb");

    const res = await postImage(app, user.token, imageForm(imageFile(new Uint8Array(CAP_BYTES))));
    expect(res.status).toBe(201);
    const imageId = ((await res.json()) as { id: string }).id;
    const preview = await getImage(app, user.token, imageId);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-length")).toBe(String(CAP_BYTES));
  });
});

describe("field validation", () => {
  it("non-image mime (audio, video, empty) → 400 invalid_request", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "mime-salah");

    for (const mime of ["audio/webm", "video/mp4", "text/plain", ""]) {
      const res = await postImage(app, user.token, imageForm(imageFile(patternBytes(64), mime)));
      expect(res.status, `mime=${mime}`).toBe(400);
    }
    await expect(
      postImage(app, user.token, imageForm(imageFile(patternBytes(64), "video/mp4"))),
    ).resolves.toMatchObject({ status: 400 });
    expect(db.select().from(imageBlobs).all()).toEqual([]);
  });

  it("missing file field, or file sent as plain text → 400", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "file-hilang");

    const missing = await postImage(app, user.token, imageForm(undefined));
    expect(missing.status).toBe(400);

    const asText = new FormData();
    asText.append("file", "not a file at all");
    const stringFile = await postImage(app, user.token, asText);
    expect(stringFile.status).toBe(400);

    expect(db.select().from(imageBlobs).all()).toEqual([]);
  });
});
