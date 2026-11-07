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
import { insertBot } from "../bots/store.ts";
import { DEFAULT_BOT_PERSONA } from "../../shared/app.ts";
import { upsertProviderConfig } from "../providers/store.ts";
import { startMockOpenAI, type MockOpenAI } from "../../../tests/helpers/mock-openai.ts";
import { postTurn, registerUser } from "../../../tests/helpers/api.ts";
import { readSse, type SseEvent } from "../../../tests/helpers/sse.ts";

// Bukti R4 (route SSE in-process, semua baris matriks story):
// happy path kumulatif → final → settled; tanpa config; tanpa sesi (401);
// provider 500; putus mid-stream; KEK absen saat materialisasi; isolasi dua
// pengguna. Tidak ada jaringan nyata — hanya tiruan lokal 127.0.0.1.

const KEY_B64 = randomBytes(32).toString("base64");

const tmpRoot = mkdtempSync(join(tmpdir(), "yui-engine-test-"));

const openDbs: YuiDatabase[] = [];
const openMocks: MockOpenAI[] = [];
let fileSeq = 0;

function makeApp(): { app: Hono; db: YuiDatabase } {
  const db = createDatabase(join(tmpRoot, `engine-${++fileSeq}.db`));
  migrateDatabase(db);
  openDbs.push(db);
  return { app: createApp("dist", db), db };
}

/** KEK sekali-pakai aktif sepanjang file; skenario KEK-absen menghapusnya eksplisit. */
let previousKey: string | undefined;

beforeAll(() => {
  previousKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = KEY_B64;
});

/** Register + POST giliran kini dari tests/helpers/api.ts; SSE dari
 * tests/helpers/sse.ts (ekstraksi byte-identik dari file ini). */

function seedConfig(db: YuiDatabase, userId: string, mock: MockOpenAI, apiKey: string) {
  return upsertProviderConfig(db, {
    userId,
    kind: "openai-compatible",
    baseUrl: mock.baseUrl,
    modelId: "mock-model",
    apiKey,
  });
}

function names(events: SseEvent[]): string[] {
  return events.map((frame) => frame.event);
}

/** Upload one voice note through the real audio route; returns the blob id. */
async function uploadAudio(
  app: Hono,
  token: string,
  durationMs: number,
  mime = "audio/webm;codecs=opus",
): Promise<string> {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(64)], "note.webm", { type: mime }));
  form.append("durationMs", String(durationMs));
  const res = await app.request("/api/audio", {
    method: "POST",
    body: form,
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** GET /api/threads/:id/messages as the session user. */
async function fetchHistory(
  app: Hono,
  token: string,
  threadId: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await app.request(`/api/threads/${threadId}/messages`, {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Array<Record<string, unknown>>;
}

/** Fixture thread milik sesi (story 3: threadId string kini wajib thread
 * milik pengguna — bukan id ephemeral arbiter). Test boleh menulis langsung
 * lewat drizzle; penulis tunggal AD-5 berlaku untuk client, bukan untuk test.
 * `botId` optionally binds the thread to a bot (multi-bot harness); null = a
 * pre-0005 row, the route's default-persona defensive path. */
function seedThread(db: YuiDatabase, userId: string, threadId: string, botId: string | null = null): void {
  const now = Date.now();
  db.insert(threads).values({ id: threadId, userId, botId, createdAt: now, updatedAt: now }).run();
}

/** Session-owned bot — a turn without threadId must now name its bot. */
function seedBot(db: YuiDatabase, userId: string, name = "Bot uji", persona = ""): string {
  return insertBot(db, userId, { name, persona }).id;
}

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

describe("POST /api/engine/turn — matriks story", () => {
  it("happy path: ≥2 delta kumulatif prefix-monotonic → 1 final (clientToken) → settled, stream tutup", async () => {
    const { app, db } = makeApp();
    const reply = "Jawaban tiruan lokal: giliran uji ini mengalir penuh sampai akhir.";
    const mock = await startMockOpenAI({ replyText: reply });
    openMocks.push(mock);
    const user = await registerUser(app, "arjuna");
    const apiKey = "sk-live-uji-1234567890abcd";
    seedConfig(db, user.userId, mock, apiKey);
    // Happy path bound to a custom-persona bot: the persona is a FULL
    // replacement of the engine's system prompt — it must reach the provider as-is.
    const persona = "You are a study coach; you only run spaced-repetition review sessions.";
    const botId = seedBot(db, user.userId, "Coach", persona);
    seedThread(db, user.userId, "thread-uji-1", botId);

    const res = await postTurn(app, user.token, {
      threadId: "thread-uji-1",
      content: "Giliran uji pertama",
      clientToken: "tok-optimistik-1",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const { events, raw } = await readSse(res);
    const deltas = events.filter((frame) => frame.event === "message.delta");
    const finals = events.filter((frame) => frame.event === "message.final");
    const settled = events.filter((frame) => frame.event === "turn.settled");
    const errors = events.filter((frame) => frame.event === "error");

    // ≥2 delta, KUMULATIF dan prefix-monotonic: setiap teks adalah awalan dari
    // teks berikutnya, dan teks penuh = balasan tiruan.
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < deltas.length; i += 1) {
      const current = deltas[i].data.text as string;
      const previous = deltas[i - 1].data.text as string;
      expect(current.startsWith(previous)).toBe(true);
      expect(current.length).toBeGreaterThan(previous.length);
    }
    expect(deltas[deltas.length - 1].data.text).toBe(reply);
    for (const delta of deltas) {
      expect(delta.data).toMatchObject({ threadId: "thread-uji-1", role: "assistant" });
    }

    // 1 message.final: clientToken tepat + teks penuh, messageId konsisten.
    expect(finals).toHaveLength(1);
    expect(finals[0].data).toEqual({
      threadId: "thread-uji-1",
      messageId: deltas[0].data.messageId,
      role: "assistant",
      clientToken: "tok-optimistik-1",
      text: reply,
    });

    // Lalu turn.settled sebagai event terakhir; tanpa error; stream menutup
    // (readSse resolve hanya saat body habis).
    expect(errors).toHaveLength(0);
    expect(settled).toHaveLength(1);
    expect(names(events)[names(events).length - 1]).toBe("turn.settled");
    expect(settled[0].data).toEqual({ threadId: "thread-uji-1" });

    // Kredensial dekripsi sampai ke penyedia sebagai Bearer, TIDAK PERNAH ke
    // stream SSE (AD-3: respons bersih).
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].authorization).toBe(`Bearer ${apiKey}`);
    expect(mock.requests[0].url).toBe("/v1/chat/completions");
    expect(mock.requests[0].body).toContain("Giliran uji pertama");
    // The thread-bound bot's full-replacement persona arrives whole, AND the
    // engine's default coding-agent prompt never tags along (multi-bot harness).
    expect(mock.requests[0].body).toContain(persona);
    expect(mock.requests[0].body).not.toContain(DEFAULT_BOT_PERSONA);
    expect(raw).not.toContain(apiKey);
  }, 30_000);

  it("tanpa config tersimpan: 1 error (tanpa kredensial) + turn.settled; engine tak tersentuh", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "tanpa-config");
    const botId = seedBot(db, user.userId);

    const res = await postTurn(app, user.token, { content: "Halo", botId });
    expect(res.status).toBe(200);

    const { events, raw } = await readSse(res);
    // Story 3: giliran tetap jadi penulis — thread auto + thread.updated
    // (bawa judul turunan) mengalir SEBELUM error; settled tetap terakhir.
    expect(names(events)).toEqual(["thread.updated", "error", "turn.settled"]);
    expect(events[0].data.title).toBe("Halo");
    expect(events[1].data.code).toBe("no_provider_config");
    expect(typeof events[1].data.message).toBe("string");
    expect(events[2].data).toEqual({ threadId: events[1].data.threadId });
    expect(raw).not.toMatch(/sk-/);
  }, 30_000);

  it("tanpa sesi (tanpa cookie): 401 envelope konvensi fondasi, bukan SSE", async () => {
    const { app } = makeApp();

    const res = await postTurn(app, undefined, { content: "Halo" });

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    });
  });

  it("body invalid: 400 invalid_request (pra-stream)", async () => {
    const { app } = makeApp();
    const user = await registerUser(app, "bad-body");

    const noContent = await postTurn(app, user.token, {});
    expect(noContent.status).toBe(400);
    await expect(noContent.json()).resolves.toEqual({
      error: { code: "invalid_request", message: expect.any(String) },
    });

    const wrongType = await postTurn(app, user.token, { content: 42 });
    expect(wrongType.status).toBe(400);

    const malformed = await app.request("/api/engine/turn", {
      method: "POST",
      body: "{bukan-json",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${user.token}` },
    });
    expect(malformed.status).toBe(400);
  });

  it("provider gagal 500: error + turn.settled, proses tetap hidup untuk request berikut", async () => {
    const { app, db } = makeApp();
    const failing = await startMockOpenAI({ behavior: "http500" });
    openMocks.push(failing);
    const healthy = await startMockOpenAI({ replyText: "Pemulihan baik." });
    openMocks.push(healthy);
    const user = await registerUser(app, "provider-gagal");
    const apiKey = "sk-live-gagal-9999efgh";
    seedConfig(db, user.userId, failing, apiKey);
    seedThread(db, user.userId, "thread-gagal");

    const failed = await postTurn(app, user.token, { threadId: "thread-gagal", content: "Coba" });
    expect(failed.status).toBe(200);
    const { events, raw } = await readSse(failed);

    // Thread milik sesi → thread.updated tanpa judul dulu, lalu error+settled.
    expect(names(events)).toEqual(["thread.updated", "error", "turn.settled"]);
    expect(events[0].data).not.toHaveProperty("title");
    expect(events[1].data.code).toBe("provider_error");
    expect(typeof events[1].data.message).toBe("string");
    expect(events[1].data.threadId).toBe("thread-gagal");
    // Log/respons hanya bentuk aman: kredensial tak pernah tampil utuh.
    expect(raw).not.toContain(apiKey);

    // Proses tetap hidup: giliran berikutnya (config dipindah ke tiruan sehat)
    // mengalir normal di app yang sama.
    seedConfig(db, user.userId, healthy, apiKey);
    const recovered = await postTurn(app, user.token, { threadId: "thread-gagal", content: "Lagi" });
    expect(recovered.status).toBe(200);
    const second = await readSse(recovered);
    expect(names(second.events)).toEqual(
      expect.arrayContaining(["message.delta", "message.final", "turn.settled"]),
    );
    const finalEvent = second.events.find((frame) => frame.event === "message.final");
    expect(finalEvent?.data.text).toBe("Pemulihan baik.");
    expect(healthy.requests).toHaveLength(1);
  }, 30_000);

  it("provider putus mid-stream: error + turn.settled", async () => {
    const { app, db } = makeApp();
    const cut = await startMockOpenAI({ replyText: "Terputus di tengah jalan.", behavior: "cut-mid-stream" });
    openMocks.push(cut);
    const user = await registerUser(app, "mid-stream");
    seedConfig(db, user.userId, cut, "sk-live-putus-7777wxyz");
    const botId = seedBot(db, user.userId);

    const res = await postTurn(app, user.token, { content: "Coba putus", botId });
    expect(res.status).toBe(200);
    const { events } = await readSse(res);

    const sequence = names(events);
    expect(sequence[sequence.length - 1]).toBe("turn.settled");
    expect(sequence).toContain("error");
    expect(sequence).not.toContain("message.final");
    // Setiap error SELALU diikuti turn.settled (AD-4).
    const errorIndex = sequence.indexOf("error");
    expect(sequence[errorIndex + 1]).toBe("turn.settled");
  }, 30_000);

  it("KEK absen saat materialisasi: fail-fast jelas sebagai error+settled, tanpa fallback", async () => {
    const { app, db } = makeApp();
    const mock = await startMockOpenAI({ replyText: "Tidak akan tercapai." });
    openMocks.push(mock);
    const user = await registerUser(app, "kek-absen");
    seedConfig(db, user.userId, mock, "sk-live-kek-5555pqrs");
    const botId = seedBot(db, user.userId);

    const prev = process.env.APP_ENCRYPTION_KEY;
    delete process.env.APP_ENCRYPTION_KEY;
    try {
      const res = await postTurn(app, user.token, { content: "Halo", botId });
      expect(res.status).toBe(200);
      const { events } = await readSse(res);
      expect(names(events)).toEqual(["thread.updated", "error", "turn.settled"]);
      expect(events[1].data.code).toBe("engine_setup_failed");
      expect(events[1].data.message).toContain("APP_ENCRYPTION_KEY");
      // Tiruan tak pernah tersentuh — engine tidak terpasang tanpa KEK.
      expect(mock.requests).toHaveLength(0);
    } finally {
      if (prev === undefined) {
        delete process.env.APP_ENCRYPTION_KEY;
      } else {
        process.env.APP_ENCRYPTION_KEY = prev;
      }
    }
  }, 30_000);

  it("isolasi dua pengguna: kredensial masing-masing sampai ke tiruannya sendiri", async () => {
    const { app, db } = makeApp();
    const mockA = await startMockOpenAI({ replyText: "Balasan untuk alpha." });
    const mockB = await startMockOpenAI({ replyText: "Balasan untuk bravo." });
    openMocks.push(mockA, mockB);
    const userA = await registerUser(app, "alpha");
    const userB = await registerUser(app, "bravo");
    seedConfig(db, userA.userId, mockA, "sk-live-alpha-aaa1111aaaa");
    seedConfig(db, userB.userId, mockB, "sk-live-bravo-bbb2222bbbb");
    const botA = seedBot(db, userA.userId, "Bot alpha");
    const botB = seedBot(db, userB.userId, "Bot bravo");

    // Without threadId → the per-user auto thread for each user's own bot
    // (story 3 semantics + the multi-bot binding).
    const turnA = await postTurn(app, userA.token, { content: "Untuk alpha", botId: botA });
    const turnB = await postTurn(app, userB.token, { content: "Untuk bravo", botId: botB });
    const eventsA = await readSse(turnA);
    const eventsB = await readSse(turnB);

    expect(mockA.requests).toHaveLength(1);
    expect(mockB.requests).toHaveLength(1);
    expect(mockA.requests[0].authorization).toBe("Bearer sk-live-alpha-aaa1111aaaa");
    expect(mockB.requests[0].authorization).toBe("Bearer sk-live-bravo-bbb2222bbbb");
    expect(eventsA.raw).not.toContain("sk-live-bravo");
    expect(eventsB.raw).not.toContain("sk-live-alpha");
    const finalA = eventsA.events.find((frame) => frame.event === "message.final");
    const finalB = eventsB.events.find((frame) => frame.event === "message.final");
    expect(finalA?.data.text).toBe("Balasan untuk alpha.");
    expect(finalB?.data.text).toBe("Balasan untuk bravo.");
  }, 30_000);

  it("config datang belakangan: threadId sama pulih setelah config disimpan (binding di-refresh)", async () => {
    const { app, db } = makeApp();
    const mock = await startMockOpenAI({ replyText: "Kini config sudah ada." });
    openMocks.push(mock);
    const user = await registerUser(app, "config-belakangan");

    // Giliran pertama: belum ada config → no_provider_config, threadId tetap.
    const threadId = "thread-belakangan";
    seedThread(db, user.userId, threadId);
    const before = await readSse(await postTurn(app, user.token, { threadId, content: "Sebelum" }));
    expect(names(before.events)).toEqual(["thread.updated", "error", "turn.settled"]);
    expect(before.events[1].data.code).toBe("no_provider_config");

    // Config disimpan, giliran ulang di thread YANG SAMA → binding session
    // di-refresh, bukan terjebak null selamanya.
    seedConfig(db, user.userId, mock, "sk-live-belakangan-4444ghij");
    const after = await readSse(await postTurn(app, user.token, { threadId, content: "Sesudah" }));
    expect(names(after.events)).toEqual(
      expect.arrayContaining(["message.delta", "message.final", "turn.settled"]),
    );
    const finalEvent = after.events.find((frame) => frame.event === "message.final");
    expect(finalEvent?.data.text).toBe("Kini config sudah ada.");
    expect(mock.requests).toHaveLength(1);
    expect(after.raw).not.toContain("sk-live-belakangan");
  }, 30_000);

  it("threadId sama dipakai ulang: sesi idempoten (adapter), settled tetap terurut", async () => {
    const { app, db } = makeApp();
    const mock = await startMockOpenAI({ replyText: "Giliran kedua di thread sama." });
    openMocks.push(mock);
    const user = await registerUser(app, "thread-sama");
    seedConfig(db, user.userId, mock, "sk-live-thread-3333cdef");
    seedThread(db, user.userId, "t-sama");

    const first = await readSse(await postTurn(app, user.token, { threadId: "t-sama", content: "Satu" }));
    const second = await readSse(await postTurn(app, user.token, { threadId: "t-sama", content: "Dua" }));

    expect(names(first.events)).toContain("message.final");
    expect(names(second.events)).toContain("message.final");
    expect(mock.requests).toHaveLength(2);
    // messageId berbeda antar giliran (pesannya memang berbeda).
    const id1 = first.events.find((frame) => frame.event === "message.final")?.data.messageId;
    const id2 = second.events.find((frame) => frame.event === "message.final")?.data.messageId;
    expect(id1).not.toBe(id2);
  }, 30_000);
});

describe("POST /api/engine/turn — voice notes (epic-voice story 2)", () => {
  it("voice-only turn on a new thread: placeholder stored with audio_id, full SSE contract, provider transcript carries the voice line, history exposes audio", async () => {
    const { app, db } = makeApp();
    const reply = "A spoken answer from the local mock.";
    const mock = await startMockOpenAI({ replyText: reply });
    openMocks.push(mock);
    const user = await registerUser(app, "voice-baru");
    seedConfig(db, user.userId, mock, "sk-live-voice-baru-1111aa");
    const botId = seedBot(db, user.userId);
    const mime = "audio/webm;codecs=opus";
    const audioId = await uploadAudio(app, user.token, 42_000, mime);

    const res = await postTurn(app, user.token, { audioId, botId });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const { events } = await readSse(res);
    const sequence = names(events);

    // Full AD-4 contract, identical shape to a text turn: thread.updated first
    // (new thread → title derived from the placeholder), cumulative deltas,
    // exactly one final, settled last, no error.
    expect(sequence[0]).toBe("thread.updated");
    expect(events[0].data.title).toBe("[Voice note: 0:42]");
    const threadId = events[0].data.threadId;
    expect(typeof threadId).toBe("string");
    expect(sequence[sequence.length - 1]).toBe("turn.settled");
    expect(sequence).not.toContain("error");

    const deltas = events.filter((frame) => frame.event === "message.delta");
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    const finals = events.filter((frame) => frame.event === "message.final");
    expect(finals).toHaveLength(1);
    expect(finals[0]!.data.text).toBe(reply);

    // The engine reads the stored placeholder as plain message text via the
    // transcript — no engine/adapter involvement (no transcription, AD-1).
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].body).toContain("user: [Voice note: 0:42]");

    // Persisted user message: placeholder text + the attached blob id; the
    // assistant reply carries no audio.
    const stored = db.select().from(messages).all();
    expect(stored.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(stored[0]!.text).toBe("[Voice note: 0:42]");
    expect(stored[0]!.audioId).toBe(audioId);
    expect(stored[1]!.audioId).toBeNull();

    // History REST shows audio {id, mime, durationMs} on the voice message only.
    const history = await fetchHistory(app, user.token, threadId as string);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      id: stored[0]!.id,
      role: "user",
      text: "[Voice note: 0:42]",
      audio: { id: audioId, mime, durationMs: 42_000 },
    });
    expect(history[1]).not.toHaveProperty("audio");
  }, 30_000);

  it("voice turn on an existing thread: same contract on that thread, zero-padded seconds placeholder", async () => {
    const { app, db } = makeApp();
    const reply = "Answered on the existing thread.";
    const mock = await startMockOpenAI({ replyText: reply });
    openMocks.push(mock);
    const user = await registerUser(app, "voice-thread-lama");
    seedConfig(db, user.userId, mock, "sk-live-voice-lama-2222bb");
    seedThread(db, user.userId, "thread-voice-lama");
    const audioId = await uploadAudio(app, user.token, 125_000);

    const res = await postTurn(app, user.token, { threadId: "thread-voice-lama", audioId });
    expect(res.status).toBe(200);
    const { events } = await readSse(res);
    const sequence = names(events);

    // Existing thread: thread.updated first WITHOUT a title, then the same
    // delta → final → settled shape as a text turn.
    expect(sequence[0]).toBe("thread.updated");
    expect(events[0].data).not.toHaveProperty("title");
    expect(events[0].data.threadId).toBe("thread-voice-lama");
    expect(sequence[sequence.length - 1]).toBe("turn.settled");
    expect(sequence).not.toContain("error");
    const finalEvent = events.find((frame) => frame.event === "message.final");
    expect(finalEvent?.data.text).toBe(reply);

    // 125000 ms → "[Voice note: 2:05]" (seconds zero-padded by the helper).
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].body).toContain("user: [Voice note: 2:05]");

    const history = await fetchHistory(app, user.token, "thread-voice-lama");
    expect(history.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(history[0]).toMatchObject({
      text: "[Voice note: 2:05]",
      audio: { id: audioId, mime: "audio/webm;codecs=opus", durationMs: 125_000 },
    });
  }, 30_000);

  it("foreign audioId vs unknown audioId: identical 404 envelopes, and nothing is written", async () => {
    const { app, db } = makeApp();
    const owner = await registerUser(app, "voice-pemilik");
    const stranger = await registerUser(app, "voice-penginta");
    const audioId = await uploadAudio(app, owner.token, 3_000);

    const foreign = await postTurn(app, stranger.token, { audioId });
    expect(foreign.status).toBe(404);
    const unknown = await postTurn(app, stranger.token, { audioId: ulid() });
    expect(unknown.status).toBe(404);

    // Byte-identical bodies: "someone else's blob" is indistinguishable from
    // "never existed" (the same convention as the thread 404).
    const foreignBody = await foreign.json();
    const unknownBody = await unknown.json();
    expect(foreignBody).toEqual({ error: { code: "not_found", message: expect.any(String) } });
    expect(unknownBody).toEqual(foreignBody);

    // The attach is rejected BEFORE any write: no thread, no message for the
    // stranger (and the owner's blob is untouched).
    expect(db.select().from(threads).all()).toEqual([]);
    expect(db.select().from(messages).all()).toEqual([]);
  });

  it("content and audioId together → 400 invalid_request; both absent → 400 (original rule)", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "voice-xor");
    const audioId = await uploadAudio(app, user.token, 1_500);

    const both = await postTurn(app, user.token, { content: "Halo", audioId });
    expect(both.status).toBe(400);
    await expect(both.json()).resolves.toEqual({
      error: { code: "invalid_request", message: expect.stringContaining("either") },
    });

    const neither = await postTurn(app, user.token, {});
    expect(neither.status).toBe(400);
    await expect(neither.json()).resolves.toEqual({
      error: { code: "invalid_request", message: expect.any(String) },
    });

    // Both rejections are pre-write.
    expect(db.select().from(threads).all()).toEqual([]);
    expect(db.select().from(messages).all()).toEqual([]);
  });
});
