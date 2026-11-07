import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { ulid } from "ulidx";
import { createApp } from "../app.ts";
import { createDatabase, migrateDatabase, type YuiDatabase } from "../db/index.ts";
import { messages, threads } from "../db/schema.ts";
import { SESSION_COOKIE } from "../auth/cookies.ts";
import { upsertProviderConfig } from "../providers/store.ts";
import { startMockOpenAI, type MockOpenAI } from "../../../tests/helpers/mock-openai.ts";
import { postTurn, registerUser } from "../../../tests/helpers/api.ts";
import { readSse, type SseEvent } from "../../../tests/helpers/sse.ts";
import { assembleTranscript, createThreadWithMessage } from "./turn-store.ts";

// Bukti story 3 (route giliran = penulis tunggal AD-5 + konteks multi-giliran
// server-side): dua giliran satu thread (transkrip giliran pertama masuk ISI
// body prompt kedua), thread auto-create berjudul turunan, 404 thread
// asing identik tak-ada pra-stream, provider error menyisakan pesan user
// TANPA pesan asisten, final tersimpan dengan id ULID server sendiri,
// padanan restart (tutup-buka file DB sama), 401 tetap, plus unit cap
// transkrip (20 pesan / 24.000 char). Fixture disemai LANGSUNG lewat drizzle
// — penulis tunggal berlaku untuk client, bukan untuk test (pola
// conversations.test.ts). Tidak ada jaringan nyata — hanya tiruan lokal.

const KEY_B64 = randomBytes(32).toString("base64");

const tmpRoot = mkdtempSync(join(tmpdir(), "yui-turn-test-"));

const openDbs: YuiDatabase[] = [];
const openMocks: MockOpenAI[] = [];
let fileSeq = 0;

function makeApp(file?: string): { app: Hono; db: YuiDatabase; file: string } {
  const dbFile = file ?? join(tmpRoot, `turn-${++fileSeq}.db`);
  const db = createDatabase(dbFile);
  migrateDatabase(db);
  openDbs.push(db);
  return { app: createApp("dist", db), db, file: dbFile };
}

/** Lepas DB dari pembersihan afterEach — ditutup manual oleh test restart. */
function forgetDb(db: YuiDatabase): void {
  const index = openDbs.indexOf(db);
  if (index >= 0) openDbs.splice(index, 1);
}

/** KEK sekali-pakai aktif sepanjang file. */
let previousKey: string | undefined;

beforeAll(() => {
  previousKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = KEY_B64;
});

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.$client.close();
  }
});

afterAll(async () => {
  while (openMocks.length > 0) {
    await openMocks.pop()?.close();
  }
  rmSync(tmpRoot, { recursive: true, force: true });
  if (previousKey === undefined) {
    delete process.env.APP_ENCRYPTION_KEY;
  } else {
    process.env.APP_ENCRYPTION_KEY = previousKey;
  }
});

function seedConfig(db: YuiDatabase, userId: string, mock: MockOpenAI, apiKey: string) {
  return upsertProviderConfig(db, {
    userId,
    kind: "openai-compatible",
    baseUrl: mock.baseUrl,
    modelId: "mock-model",
    apiKey,
  });
}

function seedThread(db: YuiDatabase, userId: string): string {
  const threadId = ulid();
  const now = Date.now();
  db.insert(threads).values({ id: threadId, userId, createdAt: now, updatedAt: now }).run();
  return threadId;
}

function seedMessage(
  db: YuiDatabase,
  threadId: string,
  role: "user" | "assistant",
  text: string,
  createdAt: number,
): string {
  const id = ulid();
  db.insert(messages).values({ id, threadId, role, text, createdAt }).run();
  return id;
}

function names(events: SseEvent[]): string[] {
  return events.map((frame) => frame.event);
}

type HistoryRow = { id: string; role: string; text: string; createdAt: string };
type ThreadRow = { id: string; title: string; createdAt: string; updatedAt: string };

async function getThreadMessages(app: Hono, token: string, threadId: string): Promise<HistoryRow[]> {
  const res = await app.request(`/api/threads/${threadId}/messages`, {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as HistoryRow[];
}

async function getThreads(app: Hono, token: string): Promise<ThreadRow[]> {
  const res = await app.request("/api/threads", {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ThreadRow[];
}

describe("dua giliran satu thread (konteks multi-giliran server-side)", () => {
  it("giliran 1 tanpa threadId → thread baru berjudul; prompt giliran 2 memuat transkrip giliran 1; riwayat 4 pesan asc", async () => {
    const { app, db } = makeApp();
    const reply = "Balasan giliran pertama dari tiruan lokal.";
    const mock = await startMockOpenAI({ replyText: reply });
    openMocks.push(mock);
    const user = await registerUser(app, "dua-giliran");
    seedConfig(db, user.userId, mock, "sk-live-dua-11112222aaaa");

    // Giliran 1 — threadId ABSENT: server membuat thread (ULID server).
    const first = await readSse(
      await postTurn(app, user.token, {
        content: "Pertanyaan giliran pertama",
        clientToken: "tok-giliran-1",
      }),
    );
    const sequence1 = names(first.events);
    // Urutan penuh: thread.updated (bawa title) → delta… → final →
    // thread.updated (tanpa title) → settled TERAKHIR (AD-4 + penulis).
    expect(sequence1[0]).toBe("thread.updated");
    expect(sequence1[sequence1.length - 1]).toBe("turn.settled");
    const firstMeta = first.events[0]!.data;
    expect(firstMeta.title).toBe("Pertanyaan giliran pertama");
    expect(Number.isNaN(Date.parse(String(firstMeta.updated_at)))).toBe(false);
    const threadId = String(firstMeta.threadId);
    const finalIndex1 = sequence1.indexOf("message.final");
    expect(sequence1[finalIndex1 + 1]).toBe("thread.updated");
    expect(sequence1[finalIndex1 + 2]).toBe("turn.settled");
    const threadUpdatedFrames = first.events.filter((frame) => frame.event === "thread.updated");
    expect(threadUpdatedFrames).toHaveLength(2);
    expect(threadUpdatedFrames[1]!.data).not.toHaveProperty("title");
    expect(threadUpdatedFrames[1]!.data.threadId).toBe(threadId);

    // Giliran 2 — threadId string milik sesi: berlanjut di thread yang sama.
    const second = await readSse(
      await postTurn(app, user.token, {
        threadId,
        content: "Pertanyaan giliran kedua",
        clientToken: "tok-giliran-2",
      }),
    );
    const sequence2 = names(second.events);
    expect(sequence2[0]).toBe("thread.updated");
    expect(second.events[0]!.data).not.toHaveProperty("title");
    expect(second.events[0]!.data.threadId).toBe(threadId);
    expect(sequence2[sequence2.length - 1]).toBe("turn.settled");

    // ISI body prompt KEDUA (asersi isi, bukan sekadar 200): transkrip
    // giliran pertama + pesan user baru — konteks dirakit server-side.
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[0]!.body).toContain("user: Pertanyaan giliran pertama");
    expect(mock.requests[0]!.body).not.toContain("assistant:");
    expect(mock.requests[1]!.body).toContain("user: Pertanyaan giliran pertama");
    expect(mock.requests[1]!.body).toContain(`assistant: ${reply}`);
    expect(mock.requests[1]!.body).toContain("user: Pertanyaan giliran kedua");

    // Riwayat GET: 4 pesan urut asc, teks persis.
    const history = await getThreadMessages(app, user.token, threadId);
    expect(history.map((row) => row.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(history.map((row) => row.text)).toEqual([
      "Pertanyaan giliran pertama",
      reply,
      "Pertanyaan giliran kedua",
      reply,
    ]);

    // Thread auto nongol di daftar dengan judul turunan.
    const threadList = await getThreads(app, user.token);
    expect(threadList.map((row) => row.id)).toEqual([threadId]);
    expect(threadList[0]!.title).toBe("Pertanyaan giliran pertama");
  }, 30_000);
});

describe("thread auto-create berjudul turunan", () => {
  it("judul = awal pesan user pertama, whitespace diratakan, cap 80 char; terlihat di GET /api/threads dan event", async () => {
    const { app } = makeApp();
    const user = await registerUser(app, "judul-turunan");

    // Giliran tanpa config pun giliran sungguhan: pesan user + thread tetap
    // tersimpan (jujur secara transkrip) — cukup membuktikan judul.
    const messy = await readSse(
      await postTurn(app, user.token, {
        content: "   Rencana \n\n hari   Sabtu — \tbersih-bersih  ",
      }),
    );
    const long = await readSse(
      await postTurn(app, user.token, {
        content: `Awalan judul ${"kata-turunan ".repeat(40)}`,
      }),
    );

    // Daftar terbaru dulu (tiebreaker id desc menjamin thread kedua di atas
    // walau updatedAt sama-ms).
    const list = await getThreads(app, user.token);
    expect(list).toHaveLength(2);
    expect(list[1]!.title).toBe("Rencana hari Sabtu — bersih-bersih");
    expect(list[0]!.title!.length).toBe(80);
    expect(list[0]!.title).toMatch(/^Awalan judul kata-turunan/);
    expect(list[0]!.id).not.toBe(list[1]!.id);
    // Event thread.updated membawa judul yang sama dengan riwayat.
    expect(messy.events[0]!.data.title).toBe("Rencana hari Sabtu — bersih-bersih");
    expect(long.events[0]!.data.title).toBe(list[0]!.title);
  }, 30_000);
});

describe("threadId asing / tak-ada", () => {
  it("404 not_found pra-stream IDENTIK untuk asing maupun tak-ada; tanpa jejak tulisan; bentuk salah → 400", async () => {
    const { app, db } = makeApp();
    const userA = await registerUser(app, "penginta-a");
    const userB = await registerUser(app, "pemilik-b");
    const threadB = seedThread(db, userB.userId);

    const foreign = await postTurn(app, userA.token, { threadId: threadB, content: "Boleh masuk?" });
    expect(foreign.status).toBe(404);
    expect(foreign.headers.get("content-type")).toContain("application/json");
    const foreignBody = await foreign.json();

    const missing = await postTurn(app, userA.token, { threadId: ulid(), content: "Boleh masuk?" });
    expect(missing.status).toBe(404);
    const missingBody = await missing.json();

    // Envelope konvensi story 2 — kedua kasus identik (eksistensi thread
    // orang lain tak boleh bocor lewat perbedaan respons).
    expect(missingBody).toEqual({ error: { code: "not_found", message: expect.any(String) } });
    expect(foreignBody).toEqual(missingBody);

    // 404 terjadi pra-tulis: tak ada pesan/thread tertinggal untuk A.
    expect(db.select().from(messages).all()).toEqual([]);
    expect(db.select().from(threads).all().map((thread) => thread.id)).toEqual([threadB]);

    // Bentuk threadId salah → 400 invalid_request (bukan dibuat diam-diam).
    for (const bad of ["", 42, null]) {
      const res = await postTurn(app, userA.token, { threadId: bad, content: "Halo" });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: { code: "invalid_request", message: expect.any(String) },
      });
    }
  });
});

describe("provider error mid-giliran", () => {
  it("pesan user tersimpan, pesan asisten TIDAK; thread.updated → error → settled", async () => {
    const { app, db } = makeApp();
    const failing = await startMockOpenAI({ behavior: "http500" });
    openMocks.push(failing);
    const user = await registerUser(app, "gagal-tersimpan");
    seedConfig(db, user.userId, failing, "sk-live-gagal-tersimpan-1a2b");

    const { events } = await readSse(
      await postTurn(app, user.token, { content: "Tanya yang gagal" }),
    );
    expect(names(events)).toEqual(["thread.updated", "error", "turn.settled"]);
    expect(events[1]!.data.code).toBe("provider_error");
    const threadId = String(events[2]!.data.threadId);

    // Jujur secara transkrip: pesan user ada, TANPA pesan asisten setengah.
    const history = await getThreadMessages(app, user.token, threadId);
    expect(history.map((row) => row.role)).toEqual(["user"]);
    expect(history[0]!.text).toBe("Tanya yang gagal");
    // Thread tetap terdaftar.
    expect((await getThreads(app, user.token)).map((row) => row.id)).toEqual([threadId]);
  }, 30_000);
});

describe("persist final", () => {
  it("teks final otoritatif tersimpan; id DB = ULID server BARU (bukan messageId event); clientToken dibalik; user < asisten", async () => {
    const { app, db } = makeApp();
    const reply = "Teks final otoritatif yang disimpan utuh.";
    const mock = await startMockOpenAI({ replyText: reply });
    openMocks.push(mock);
    const user = await registerUser(app, "final-tersimpan");
    seedConfig(db, user.userId, mock, "sk-live-final-33334444bbbb");

    const { events } = await readSse(
      await postTurn(app, user.token, {
        content: "Pertanyaan final",
        clientToken: "tok-final-1",
      }),
    );
    const finalFrame = events.find((frame) => frame.event === "message.final")!.data;
    expect(finalFrame.clientToken).toBe("tok-final-1");

    const history = await getThreadMessages(app, user.token, String(finalFrame.threadId));
    expect(history).toHaveLength(2);
    const [userRow, assistantRow] = history;
    expect(assistantRow!.text).toBe(reply);
    expect(assistantRow!.text).toBe(finalFrame.text);
    // Id riwayat ≠ id stream: DB memakai ULID server sendiri — klien tak
    // mencocokkan keduanya (dedup = clientToken); perbedaan disengaja.
    expect(assistantRow!.id).not.toBe(finalFrame.messageId);
    expect(assistantRow!.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    // Monotonis ULID proses (pabrik monotonic turn-store): pasangan sama-ms
    // tetap urut user → asisten (tiebreaker leksikografis story 2).
    expect(String(userRow!.id) < String(assistantRow!.id)).toBe(true);
  }, 30_000);
});

describe("padanan restart", () => {
  it("tutup DB → buka ulang file sama: riwayat GET utuh (id + urut + judul tetap)", async () => {
    const file = join(tmpRoot, `turn-restart-${++fileSeq}.db`);
    const first = makeApp(file);
    const reply = "Balasan sebelum restart.";
    const mock = await startMockOpenAI({ replyText: reply });
    openMocks.push(mock);
    const user = await registerUser(first.app, "pra-restart");
    seedConfig(first.db, user.userId, mock, "sk-live-restart-55556666cccc");

    const turn = await readSse(
      await postTurn(first.app, user.token, { content: "Sebelum restart" }),
    );
    const threadId = String(turn.events[0]!.data.threadId);
    const before = await getThreadMessages(first.app, user.token, threadId);
    expect(before.map((row) => row.role)).toEqual(["user", "assistant"]);

    // Tutup koneksi, buka ulang + migrasi file yang sama — sesi cookie tetap
    // valid karena auth_sessions satu file DB (AD-2).
    forgetDb(first.db);
    first.db.$client.close();
    const reopened = makeApp(file);

    const after = await getThreadMessages(reopened.app, user.token, threadId);
    expect(after).toEqual(before);
    const list = await getThreads(reopened.app, user.token);
    expect(list.map((row) => row.id)).toEqual([threadId]);
    expect(list[0]!.title).toBe("Sebelum restart");
  }, 30_000);
});

describe("tanpa sesi", () => {
  it("POST tanpa cookie → 401 envelope pra-stream, tak ada thread/pesan tertulis", async () => {
    const { app, db } = makeApp();

    const res = await postTurn(app, undefined, { content: "Halo" });

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    });
    expect(db.select().from(threads).all()).toEqual([]);
    expect(db.select().from(messages).all()).toEqual([]);
  });
});

describe("assembleTranscript (unit)", () => {
  it("cap 20 pesan TERAKHIR: 5 tertua terpotong, urut asc baris per baris", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "cap-20");
    const threadId = seedThread(db, user.userId);
    const base = Date.now();
    for (let i = 0; i < 25; i += 1) {
      seedMessage(
        db,
        threadId,
        i % 2 === 0 ? "assistant" : "user",
        `pesan-${String(i).padStart(2, "0")}`,
        base + i,
      );
    }

    const lines = assembleTranscript(db, user.userId, threadId).split("\n");
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe("user: pesan-05");
    expect(lines[19]).toBe("assistant: pesan-24");
    expect(lines.join("\n")).not.toContain("pesan-04");
  });

  it("anggaran 24.000 char: dipotong dari KEPALA; pesan terbaru (user) selalu utuh", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "anggaran-24k");
    const threadId = seedThread(db, user.userId);
    const base = Date.now();
    const filler = "x".repeat(1_500);
    for (let i = 0; i < 20; i += 1) {
      seedMessage(
        db,
        threadId,
        i % 2 === 0 ? "assistant" : "user",
        `${filler} tanda-${String(i).padStart(2, "0")}`,
        base + i,
      );
    }

    const transcript = assembleTranscript(db, user.userId, threadId);
    expect(transcript.length).toBeLessThanOrEqual(24_000);
    // Baris terakhir (pesan user barusan) utuh — selalu masuk apa pun
    // anggarannya.
    expect(transcript.endsWith(`user: ${filler} tanda-19`)).toBe(true);
    // Kepala terpotong: tertua hilang, terbaru bertahan.
    expect(transcript).not.toContain("tanda-04");
    expect(transcript).toContain("tanda-05");
    expect(transcript).toContain("tanda-19");
  });
});

describe("penulis turn-store (unit)", () => {
  it("ULID monotonic: dua createThreadWithMessage beruntun (kemungkinan sama-ms) tetap naik leksikografis", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "ulid-monoton");

    // `ulid()` default acak dalam ms yang sama — pabrik monotonic turn-store
    // wajib menjaga arah, atau tiebreaker (createdAt, id) bisa membalik
    // pasangan user→asisten sama-ms.
    const first = createThreadWithMessage(db, user.userId, "Pertanyaan pertama", Date.now());
    const second = createThreadWithMessage(db, user.userId, "Pertanyaan kedua", Date.now());

    expect(first.threadId).not.toBe(second.threadId);
    expect(first.threadId < second.threadId).toBe(true);
  });

  it("judul dipotong per code point: emoji di perbatasan 80 tetap utuh (tanpa lone surrogate)", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "judul-emoji");

    // Unit UTF-16 ke-80/81 jatuh di TENGAH emoji pertama — potongan per code
    // point harus menyimpan emoji utuh, bukan belahan high-surrogate.
    const emoji = "\u{1F642}"; // 🙂
    const content = `${"a".repeat(79)}${emoji.repeat(3)}`;
    const { title } = createThreadWithMessage(db, user.userId, content, Date.now());

    expect(title).toBe(`${"a".repeat(79)}${emoji}`);
    expect([...title]).toHaveLength(80);
  });
});
