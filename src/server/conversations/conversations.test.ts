import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ulid } from "ulidx";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../app.ts";
import { createDatabase, migrateDatabase, type YuiDatabase } from "../db/index.ts";
import { audioBlobs, imageBlobs, messages, threads, users } from "../db/schema.ts";
import { SESSION_COOKIE } from "../auth/cookies.ts";
import { registerUser } from "../../../tests/helpers/api.ts";

// Bukti story skema threads/messages + REST baca riwayat (R2, AD-5/AD-6/
// AD-9): GET /api/threads + GET /api/threads/:id/messages di balik gerbang
// sesi; dua akun tak saling melihat (isolasi di SQL); riwayat urut createdAt
// asc dengan tiebreaker id; 404 tanpa leak eksistensi; migrasi 0003 bersih;
// CHECK role di DB; kaskase FK hidup.
// Fixture disemai LANGSUNG lewat drizzle — penulisan route datang di story 3
// (server penulis tunggal berlaku untuk client, bukan untuk test).

const tmpRoot = mkdtempSync(join(tmpdir(), "yui-conversations-test-"));

const openDbs: YuiDatabase[] = [];
let fileSeq = 0;

function makeApp(): { app: Hono; db: YuiDatabase } {
  const file = join(tmpRoot, `conversations-${++fileSeq}.db`);
  const db = createDatabase(file);
  migrateDatabase(db);
  openDbs.push(db);
  return { app: createApp("dist", db), db };
}

function seedThread(
  db: YuiDatabase,
  userId: string,
  at: { title?: string; createdAt: number; updatedAt?: number },
  id: string = ulid(),
): string {
  db.insert(threads)
    .values({
      id,
      userId,
      // `title` sengaja tak disertakan bila tak diberikan — membuktikan
      // DEFAULT '' di level SQL (pengisian judul sungguhan = story 3).
      ...(at.title === undefined ? {} : { title: at.title }),
      createdAt: at.createdAt,
      updatedAt: at.updatedAt ?? at.createdAt,
    })
    .run();
  return id;
}

function seedMessage(
  db: YuiDatabase,
  threadId: string,
  role: "user" | "assistant",
  text: string,
  createdAt: number,
  id: string = ulid(),
): string {
  db.insert(messages).values({ id, threadId, role, text, createdAt }).run();
  return id;
}

async function getThreads(app: Hono, token: string | undefined): Promise<Response> {
  return app.request("/api/threads", {
    headers: token === undefined ? {} : { cookie: `${SESSION_COOKIE}=${token}` },
  });
}

async function getMessages(app: Hono, token: string | undefined, threadId: string): Promise<Response> {
  return app.request(`/api/threads/${threadId}/messages`, {
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

describe("migrasi 0003", () => {
  it("DB kosong: createDatabase + migrateDatabase tak melempar; idempoten dipanggil ulang; tabel queryable", () => {
    const file = join(tmpRoot, `migration-clean-${++fileSeq}.db`);
    const db = createDatabase(file);
    try {
      expect(() => migrateDatabase(db)).not.toThrow();
      // Migrasi yang sudah masuk __drizzle_migrations di-skip — dipanggil
      // ulang tetap aman (pola server start).
      expect(() => migrateDatabase(db)).not.toThrow();
      expect(db.select().from(threads).all()).toEqual([]);
      expect(db.select().from(messages).all()).toEqual([]);
    } finally {
      db.$client.close();
    }
  });
});

describe("tanpa sesi", () => {
  it("GET kedua route tanpa cookie → 401 unauthorized envelope", async () => {
    const { app } = makeApp();

    const list = await getThreads(app, undefined);
    expect(list.status).toBe(401);
    await expect(list.json()).resolves.toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    });

    const history = await getMessages(app, undefined, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(history.status).toBe(401);
    await expect(history.json()).resolves.toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    });
  });
});

describe("GET /api/threads", () => {
  it("isolasi dua akun: A melihat 2 thread-nya urut updatedAt desc, B melihat 1 miliknya", async () => {
    const { app, db } = makeApp();
    const userA = await registerUser(app, "pemilik-a");
    const userB = await registerUser(app, "pemirsa-b");

    const base = Date.UTC(2026, 10, 7, 9, 0, 0);
    const oldThread = seedThread(db, userA.userId, {
      title: "Thread lama",
      createdAt: base,
      updatedAt: base + 1_000,
    });
    // Tanpa title → DEFAULT ''; updatedAt terbaru → muncul pertama.
    const newThread = seedThread(db, userA.userId, { createdAt: base + 2_000, updatedAt: base + 3_000 });
    const threadB = seedThread(db, userB.userId, { title: "Milik B", createdAt: base, updatedAt: base + 5_000 });

    const resA = await getThreads(app, userA.token);
    expect(resA.status).toBe(200);
    const bodyA = (await resA.json()) as Array<Record<string, unknown>>;
    expect(bodyA.map((thread) => thread.id)).toEqual([newThread, oldThread]);
    expect(bodyA.map((thread) => thread.id)).not.toContain(threadB);
    // DTO persis: konversi epoch-ms → ISO-8601 UTC terjadi di tepi route.
    // botId null = the 0005 column on a pre-migration fixture row (new rows
    // are always bot-bound via the turn route).
    expect(bodyA[0]).toEqual({
      id: newThread,
      botId: null,
      title: "",
      createdAt: new Date(base + 2_000).toISOString(),
      updatedAt: new Date(base + 3_000).toISOString(),
    });
    expect(bodyA[1]!.title).toBe("Thread lama");

    const resB = await getThreads(app, userB.token);
    expect(resB.status).toBe(200);
    const bodyB = (await resB.json()) as Array<Record<string, unknown>>;
    expect(bodyB.map((thread) => thread.id)).toEqual([threadB]);
  });

  it("updatedAt sama: tiebreaker id desc — deterministik, bukan kebetulan arah scan index", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "tiebreak-thread");
    const base = Date.UTC(2026, 10, 7, 12, 0, 0);
    // Dibuat X dulu (id lebih kecil), Y belakangan — updatedAt identik.
    const olderId = "01THR-TIE-A";
    const newerId = "01THR-TIE-B";
    seedThread(db, user.userId, { createdAt: base, updatedAt: base }, olderId);
    seedThread(db, user.userId, { createdAt: base + 1, updatedAt: base }, newerId);

    const res = await getThreads(app, user.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    // ULID terurut leksikografis per waktu — id desc = yang lebih baru dibuat
    // duluan pada timestamp sama.
    expect(body.map((thread) => thread.id)).toEqual([newerId, olderId]);
  });

  it("user baru tanpa thread → [] (bukan 404)", async () => {
    const { app } = makeApp();
    const user = await registerUser(app, "user-baru");

    const res = await getThreads(app, user.token);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([]);
  });
});

describe("GET /api/threads/:id/messages", () => {
  it("riwayat urut createdAt asc meski disisip acak; DTO role/text/ISO di tepi", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "urut-pesan");
    const base = Date.UTC(2026, 10, 6, 8, 30, 0);
    const threadId = seedThread(db, user.userId, { createdAt: base, updatedAt: base });

    // Sisip sengaja TIDAK urut — urutan dibuktikan ada di ORDER BY SQL.
    const third = seedMessage(db, threadId, "assistant", "Ada lagi?", base + 2_000);
    const first = seedMessage(db, threadId, "user", "Hai Yui", base);
    const second = seedMessage(db, threadId, "assistant", "Hai! Ada yang bisa dibantu?", base + 1_000);

    const res = await getMessages(app, user.token, threadId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body.map((message) => message.id)).toEqual([first, second, third]);
    expect(body.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(body.map((message) => message.text)).toEqual([
      "Hai Yui",
      "Hai! Ada yang bisa dibantu?",
      "Ada lagi?",
    ]);
    expect(body.map((message) => message.createdAt)).toEqual([
      new Date(base).toISOString(),
      new Date(base + 1_000).toISOString(),
      new Date(base + 2_000).toISOString(),
    ]);
  });

  it("createdAt sama (pasangan user+assistant satu giliran story 3): tiebreaker id asc", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "tiebreak-pesan");
    const base = Date.UTC(2026, 10, 7, 12, 30, 0);
    const threadId = seedThread(db, user.userId, { createdAt: base, updatedAt: base });

    // Disisip TERBALIK dengan createdAt identik — writer story 3 memakai satu
    // Date.now() untuk pesan user lalu assistant; tanpa tiebreaker, balasan
    // bisa terrender di atas pertanyaannya.
    const reply = seedMessage(db, threadId, "assistant", "Jawaban", base, "01MSG-TIE-B");
    const question = seedMessage(db, threadId, "user", "Pertanyaan", base, "01MSG-TIE-A");

    const res = await getMessages(app, user.token, threadId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body.map((message) => message.id)).toEqual([question, reply]);
    expect(body.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("voice message maps audio {id, mime, durationMs} onto the DTO; an unresolvable blob omits audio but keeps the placeholder text", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "dto-audio");
    const base = Date.UTC(2026, 10, 7, 9, 0, 0);
    const threadId = seedThread(db, user.userId, { createdAt: base, updatedAt: base });

    const audioId = ulid();
    db.insert(audioBlobs)
      .values({
        id: audioId,
        ownerUserId: user.userId,
        mime: "audio/webm;codecs=opus",
        durationMs: 42_000,
        blob: Buffer.alloc(64),
        createdAt: base,
      })
      .run();
    db.insert(messages)
      .values({
        id: "01MSG-AUDIO-USER",
        threadId,
        role: "user",
        text: "[Voice note: 0:42]",
        audioId,
        createdAt: base,
      })
      .run();
    seedMessage(db, threadId, "assistant", "Siap.", base + 1_000);

    const withBlob = await getMessages(app, user.token, threadId);
    expect(withBlob.status).toBe(200);
    const mapped = (await withBlob.json()) as Array<Record<string, unknown>>;
    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toMatchObject({
      id: "01MSG-AUDIO-USER",
      role: "user",
      text: "[Voice note: 0:42]",
      audio: { id: audioId, mime: "audio/webm;codecs=opus", durationMs: 42_000 },
    });
    expect(mapped[1]).not.toHaveProperty("audio");

    // Blob gone from under the message: `audio` is omitted and the stored
    // placeholder text stays — history must not break on a dangling reference.
    // FK checks are disabled for this fixture delete only, because a dangling
    // pointer is exactly the case under test.
    db.$client.pragma("foreign_keys = OFF");
    db.delete(audioBlobs).where(eq(audioBlobs.id, audioId)).run();
    db.$client.pragma("foreign_keys = ON");

    const after = await getMessages(app, user.token, threadId);
    expect(after.status).toBe(200);
    const dangling = (await after.json()) as Array<Record<string, unknown>>;
    expect(dangling[0]).not.toHaveProperty("audio");
    expect(dangling[0]).toMatchObject({ text: "[Voice note: 0:42]" });
  });

  it("image message maps images {id, mime} onto the DTO; a dangling blob id is dropped, never a 500", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "dto-gambar");
    const base = Date.UTC(2026, 10, 7, 9, 0, 0);
    const threadId = seedThread(db, user.userId, { createdAt: base, updatedAt: base });

    const imageId = ulid();
    db.insert(imageBlobs)
      .values({
        id: imageId,
        ownerUserId: user.userId,
        mime: "image/png",
        blob: Buffer.alloc(32),
        createdAt: base,
      })
      .run();
    db.insert(messages)
      .values({
        id: "01MSG-IMAGE-USER",
        threadId,
        role: "user",
        text: "[Image]",
        imageIds: JSON.stringify([imageId]),
        createdAt: base,
      })
      .run();
    seedMessage(db, threadId, "assistant", "Nice picture.", base + 1_000);

    const withBlob = await getMessages(app, user.token, threadId);
    expect(withBlob.status).toBe(200);
    const mapped = (await withBlob.json()) as Array<Record<string, unknown>>;
    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toMatchObject({
      id: "01MSG-IMAGE-USER",
      role: "user",
      text: "[Image]",
      images: [{ id: imageId, mime: "image/png" }],
    });
    expect(mapped[1]).not.toHaveProperty("images");

    // Blob gone from under the message: `images` is omitted and the stored
    // placeholder text stays — history must not break on a dangling reference
    // (image_ids is a JSON TEXT column with no FK; the route's null filter is
    // the only guard). FK pragmas are untouched here — image_blobs has no FK
    // into messages at all.
    db.delete(imageBlobs).where(eq(imageBlobs.id, imageId)).run();

    const after = await getMessages(app, user.token, threadId);
    expect(after.status).toBe(200);
    const dangling = (await after.json()) as Array<Record<string, unknown>>;
    expect(dangling).toHaveLength(2);
    expect(dangling[0]).not.toHaveProperty("images");
    expect(dangling[0]).toMatchObject({ text: "[Image]" });
  });

  it("thread milik B diakses A → 404; thread tak ada → 404 IDENTIK; thread sah kosong → []", async () => {
    const { app, db } = makeApp();
    const userA = await registerUser(app, "peninjau-a");
    const userB = await registerUser(app, "pemilik-b");
    const base = Date.UTC(2026, 10, 7, 10, 0, 0);
    const threadB = seedThread(db, userB.userId, { title: "Rahasia B", createdAt: base, updatedAt: base });
    seedMessage(db, threadB, "user", "pesan rahasia B", base + 1);
    const threadEmpty = seedThread(db, userA.userId, { createdAt: base, updatedAt: base });

    const foreign = await getMessages(app, userA.token, threadB);
    expect(foreign.status).toBe(404);
    const foreignBody = await foreign.json();

    const missing = await getMessages(app, userA.token, ulid());
    expect(missing.status).toBe(404);
    const missingBody = await missing.json();

    // Envelope kedua kasus identik — pemanggil tak bisa membedakan "thread
    // orang lain" dari "thread tak pernah ada" (403 akan membocorkan).
    expect(foreignBody).toEqual({ error: { code: "not_found", message: expect.any(String) } });
    expect(missingBody).toEqual(foreignBody);
    // Isi thread B tak pernah muncul di respons A.
    const foreignText = JSON.stringify(foreignBody);
    expect(foreignText).not.toContain("Rahasia B");
    expect(foreignText).not.toContain("pesan rahasia B");

    // Thread milik sesi tanpa pesan → array kosong, bukan 404/null.
    const empty = await getMessages(app, userA.token, threadEmpty);
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toEqual([]);
  });
});

describe("CHECK messages.role", () => {
  it("insert role \"system\" via drizzle ditolak constraint — tak pernah sampai ke cast route", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "role-ditolak");
    const base = Date.now();
    const threadId = seedThread(db, user.userId, { createdAt: base, updatedAt: base });

    expect(() =>
      db.insert(messages)
        .values({ id: ulid(), threadId, role: "system", text: "pesan menyusup", createdAt: base })
        .run(),
    ).toThrowError(/CHECK constraint failed: messages_role_check/);

    // Penyimpanan tak tercemar: statement gagal utuh, tak ada baris tersisa.
    expect(db.select().from(messages).all()).toEqual([]);
  });
});

describe("kaskase FK", () => {
  it("hapus user (fixture drizzle) → thread + pesannya ikut terhapus; user lain utuh", async () => {
    const { app, db } = makeApp();
    const userA = await registerUser(app, "terhapus-a");
    const userB = await registerUser(app, "bertahan-b");
    const base = Date.UTC(2026, 10, 7, 11, 0, 0);
    const threadA = seedThread(db, userA.userId, { title: "Hilang", createdAt: base, updatedAt: base });
    seedMessage(db, threadA, "user", "pesan a", base + 1);
    const threadB = seedThread(db, userB.userId, { title: "Bertahan", createdAt: base, updatedAt: base });
    seedMessage(db, threadB, "assistant", "pesan b", base + 1);

    db.delete(users).where(eq(users.id, userA.userId)).run();

    expect(db.select().from(threads).all().map((thread) => thread.id)).toEqual([threadB]);
    expect(db.select().from(messages).all().map((message) => message.threadId)).toEqual([threadB]);
  });
});
