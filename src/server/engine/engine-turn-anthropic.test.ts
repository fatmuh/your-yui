import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../app.ts";
import { createDatabase, migrateDatabase, type YuiDatabase } from "../db/index.ts";
import { threads } from "../db/schema.ts";
import { SESSION_COOKIE } from "../auth/cookies.ts";
import { insertBot } from "../bots/store.ts";
import { upsertProviderConfig } from "../providers/store.ts";
import { startMockOpenAI, type MockOpenAI } from "../../../tests/helpers/mock-openai.ts";
import { startMockAnthropic, type MockAnthropic } from "../../../tests/helpers/mock-anthropic.ts";
import { postTurn, registerUser } from "../../../tests/helpers/api.ts";
import { readSse, type SseEvent } from "../../../tests/helpers/sse.ts";
import { resolveProviderEntry } from "./adapter.ts";

// Bukti R4 story 2 (jenis kedua lewat adapter yang sama): happy path anthropic
// dengan event kontrak IDENTIK story 1; koeksistensi dua jenis; kegagalan
// provider anthropic (500 dan putus sebelum message_stop); tanpa config;
// kind invalid; unit pembentukan entry baseUrl/modelId null. Tidak ada jaringan
// nyata — hanya tiruan lokal 127.0.0.1.

const KEY_B64 = randomBytes(32).toString("base64");

const tmpRoot = mkdtempSync(join(tmpdir(), "yui-engine-anthropic-test-"));

const openDbs: YuiDatabase[] = [];
const openMocks: Array<MockOpenAI | MockAnthropic> = [];
let fileSeq = 0;

function makeApp(): { app: Hono; db: YuiDatabase } {
  const db = createDatabase(join(tmpRoot, `engine-anthropic-${++fileSeq}.db`));
  migrateDatabase(db);
  openDbs.push(db);
  return { app: createApp("dist", db), db };
}

/** KEK sekali-pakai aktif sepanjang file. */
let previousKey: string | undefined;

beforeAll(() => {
  previousKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = KEY_B64;
});

/** Register + POST giliran kini dari tests/helpers/api.ts; SSE dari
 * tests/helpers/sse.ts (ekstraksi byte-identik dari engine-turn.test.ts). */

function seedAnthropicConfig(
  db: YuiDatabase,
  userId: string,
  mock: MockAnthropic,
  apiKey: string,
  overrides: { baseUrl?: string | null; modelId?: string | null } = {},
) {
  return upsertProviderConfig(db, {
    userId,
    kind: "anthropic",
    baseUrl: overrides.baseUrl !== undefined ? overrides.baseUrl : mock.baseUrl,
    modelId: overrides.modelId !== undefined ? overrides.modelId : "mock-anthropic-model",
    apiKey,
  });
}

function seedOpenAiConfig(db: YuiDatabase, userId: string, mock: MockOpenAI, apiKey: string) {
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

/** Fixture thread milik sesi (story 3: threadId string wajib thread milik
 * pengguna). Test menulis langsung lewat drizzle — penulis tunggal AD-5
 * berlaku untuk client, bukan untuk test. */
function seedThread(db: YuiDatabase, userId: string, threadId: string): void {
  const now = Date.now();
  db.insert(threads).values({ id: threadId, userId, createdAt: now, updatedAt: now }).run();
}

/** Session-owned bot — a turn without threadId must now name its bot. */
function seedBot(db: YuiDatabase, userId: string, name = "Bot uji"): string {
  return insertBot(db, userId, { name, persona: "" }).id;
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

describe("POST /api/engine/turn kind=anthropic — matriks story", () => {
  it("happy path anthropic: ≥2 delta kumulatif prefix-monotonic → 1 final (clientToken) → settled; x-api-key sampai ke tiruan", async () => {
    const { app, db } = makeApp();
    const reply = "Jawaban tiruan anthropic: giliran uji ini mengalir penuh sampai akhir.";
    const mock = await startMockAnthropic({ replyText: reply });
    openMocks.push(mock);
    const user = await registerUser(app, "anthropic-happy");
    const apiKey = "sk-ant-api-uji-1234567890abcd";
    seedAnthropicConfig(db, user.userId, mock, apiKey);
    seedThread(db, user.userId, "thread-anthropic-1");

    const res = await postTurn(app, user.token, {
      kind: "anthropic",
      threadId: "thread-anthropic-1",
      content: "Giliran uji anthropic",
      clientToken: "tok-optimistik-anthropic",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const { events, raw } = await readSse(res);
    const deltas = events.filter((frame) => frame.event === "message.delta");
    const finals = events.filter((frame) => frame.event === "message.final");
    const settled = events.filter((frame) => frame.event === "turn.settled");
    const errors = events.filter((frame) => frame.event === "error");

    // Event kontrak IDENTIK story 1: ≥2 delta KUMULATIF prefix-monotonic,
    // teks penuh = balasan tiruan.
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < deltas.length; i += 1) {
      const current = deltas[i].data.text as string;
      const previous = deltas[i - 1].data.text as string;
      expect(current.startsWith(previous)).toBe(true);
      expect(current.length).toBeGreaterThan(previous.length);
    }
    expect(deltas[deltas.length - 1].data.text).toBe(reply);
    for (const delta of deltas) {
      expect(delta.data).toMatchObject({ threadId: "thread-anthropic-1", role: "assistant" });
    }

    // 1 message.final: clientToken tepat + teks penuh, messageId konsisten.
    expect(finals).toHaveLength(1);
    expect(finals[0].data).toEqual({
      threadId: "thread-anthropic-1",
      messageId: deltas[0].data.messageId,
      role: "assistant",
      clientToken: "tok-optimistik-anthropic",
      text: reply,
    });

    // Lalu turn.settled sebagai event terakhir; tanpa error.
    expect(errors).toHaveLength(0);
    expect(settled).toHaveLength(1);
    expect(names(events)[names(events).length - 1]).toBe("turn.settled");
    expect(settled[0].data).toEqual({ threadId: "thread-anthropic-1" });

    // Wire anthropic: POST /v1/messages (baseUrl TANPA /v1 — SDK menambah
    // path), auth x-api-key, body memuat prompt dan model id; kredensial
    // TIDAK PERNAH ke stream SSE (AD-3).
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].method).toBe("POST");
    expect(mock.requests[0].url).toMatch(/^\/v1\/messages/);
    expect(mock.requests[0].apiKeyHeader).toBe(apiKey);
    expect(mock.requests[0].body).toContain("Giliran uji anthropic");
    expect(mock.requests[0].body).toContain("mock-anthropic-model");
    expect(raw).not.toContain(apiKey);
  }, 30_000);

  it("kedua jenis berdampingan: dua giliran kind masing-masing selesai lewat adapter identik, kredensial tak pernah silang, binding latest-wins", async () => {
    const { app, db } = makeApp();
    const mockOpenai = await startMockOpenAI({ replyText: "Balasan lewat jenis openai." });
    const mockAnthropic = await startMockAnthropic({ replyText: "Balasan lewat jenis anthropic." });
    openMocks.push(mockOpenai, mockAnthropic);
    const user = await registerUser(app, "dua-jenis");
    const openaiKey = "sk-live-openai-aaa1111aaaa";
    const anthropicKey = "sk-ant-api-bravo-2222bbbb";
    seedOpenAiConfig(db, user.userId, mockOpenai, openaiKey);
    seedAnthropicConfig(db, user.userId, mockAnthropic, anthropicKey);

    // SATU thread untuk kedua giliran: binding sesi latest-wins per
    // (userId, threadId) — giliran kedua memakai config kind keduanya.
    const threadId = "thread-dua-jenis";
    seedThread(db, user.userId, threadId);
    const turnOpenai = await postTurn(app, user.token, {
      kind: "openai-compatible",
      threadId,
      content: "Untuk openai",
    });
    const turnAnthropic = await postTurn(app, user.token, {
      kind: "anthropic",
      threadId,
      content: "Untuk anthropic",
    });

    const sseOpenai = await readSse(turnOpenai);
    const sseAnthropic = await readSse(turnAnthropic);
    for (const sse of [sseOpenai, sseAnthropic]) {
      expect(names(sse.events)).toEqual(
        expect.arrayContaining(["message.delta", "message.final", "turn.settled"]),
      );
      expect(sse.events.filter((frame) => frame.event === "error")).toHaveLength(0);
    }
    const finalOpenai = sseOpenai.events.find((frame) => frame.event === "message.final");
    const finalAnthropic = sseAnthropic.events.find((frame) => frame.event === "message.final");
    expect(finalOpenai?.data.text).toBe("Balasan lewat jenis openai.");
    expect(finalAnthropic?.data.text).toBe("Balasan lewat jenis anthropic.");

    // Kredensial masing-masing sampai ke tiruannya — tanpa silang/campur.
    expect(mockOpenai.requests).toHaveLength(1);
    expect(mockAnthropic.requests).toHaveLength(1);
    expect(mockOpenai.requests[0].authorization).toBe(`Bearer ${openaiKey}`);
    expect(mockAnthropic.requests[0].apiKeyHeader).toBe(anthropicKey);
    expect(mockAnthropic.requests[0].authorization).toBeUndefined();
    expect(sseOpenai.raw).not.toContain(anthropicKey);
    expect(sseAnthropic.raw).not.toContain(openaiKey);
  }, 30_000);

  it("provider anthropic gagal 500: error + turn.settled, giliran lanjutan pulih", async () => {
    const { app, db } = makeApp();
    const failing = await startMockAnthropic({ behavior: "http500" });
    const healthy = await startMockAnthropic({ replyText: "Pemulihan anthropic baik." });
    openMocks.push(failing, healthy);
    const user = await registerUser(app, "anthropic-gagal");
    const apiKey = "sk-ant-api-gagal-9999efgh";
    seedAnthropicConfig(db, user.userId, failing, apiKey);
    seedThread(db, user.userId, "thread-ag");

    const failed = await postTurn(app, user.token, { kind: "anthropic", threadId: "thread-ag", content: "Coba" });
    expect(failed.status).toBe(200);
    const { events, raw } = await readSse(failed);

    // Story 3: thread.updated (tulis user) dulu, lalu error+settled.
    expect(names(events)).toEqual(["thread.updated", "error", "turn.settled"]);
    expect(events[1].data.code).toBe("provider_error");
    expect(typeof events[1].data.message).toBe("string");
    expect(events[1].data.threadId).toBe("thread-ag");
    // Log/respons hanya bentuk aman: kredensial tak pernah tampil utuh.
    expect(raw).not.toContain(apiKey);

    // Giliran lanjutan pulih: config dipindah ke tiruan sehat, giliran baru
    // mengalir normal di app yang sama.
    seedAnthropicConfig(db, user.userId, healthy, apiKey);
    const recovered = await postTurn(app, user.token, { kind: "anthropic", threadId: "thread-ag", content: "Lagi" });
    expect(recovered.status).toBe(200);
    const second = await readSse(recovered);
    expect(names(second.events)).toEqual(
      expect.arrayContaining(["message.delta", "message.final", "turn.settled"]),
    );
    const finalEvent = second.events.find((frame) => frame.event === "message.final");
    expect(finalEvent?.data.text).toBe("Pemulihan anthropic baik.");
    expect(healthy.requests).toHaveLength(1);
  }, 30_000);

  it("stream terpotong sebelum message_stop: error (jalur engine) + turn.settled, tanpa final", async () => {
    const { app, db } = makeApp();
    const cut = await startMockAnthropic({
      replyText: "Terputus sebelum message_stop.",
      behavior: "cut-before-message-stop",
    });
    openMocks.push(cut);
    const user = await registerUser(app, "anthropic-putus");
    seedAnthropicConfig(db, user.userId, cut, "sk-ant-api-putus-7777wxyz");
    const botId = seedBot(db, user.userId);

    const res = await postTurn(app, user.token, { kind: "anthropic", content: "Coba putus", botId });
    expect(res.status).toBe(200);
    const { events, raw } = await readSse(res);

    const sequence = names(events);
    expect(sequence[sequence.length - 1]).toBe("turn.settled");
    expect(sequence).toContain("error");
    expect(sequence).not.toContain("message.final");
    // Setiap error SELALU diikuti turn.settled (AD-4).
    const errorIndex = sequence.indexOf("error");
    expect(sequence[errorIndex + 1]).toBe("turn.settled");
    // Error spesifik jalur engine: stream berakhir sebelum message_stop.
    expect(String(events[errorIndex].data.message)).toMatch(/message_stop/i);
    expect(raw).not.toContain("sk-ant-api-putus");
  }, 30_000);

  it("tanpa config anthropic: no_provider_config + turn.settled, tanpa leak", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "anthropic-tanpa-config");
    const botId = seedBot(db, user.userId);

    const res = await postTurn(app, user.token, { kind: "anthropic", content: "Halo", botId });
    expect(res.status).toBe(200);

    const { events, raw } = await readSse(res);
    // Story 3: thread auto + thread.updated dulu (giliran tetap penulis),
    // lalu error+settled.
    expect(names(events)).toEqual(["thread.updated", "error", "turn.settled"]);
    expect(events[1].data.code).toBe("no_provider_config");
    expect(typeof events[1].data.message).toBe("string");
    expect(events[2].data).toEqual({ threadId: events[1].data.threadId });
    expect(raw).not.toMatch(/sk-/);
  }, 30_000);

  it("binding sesi latest-call-wins antar kind: giliran kind tanpa config tak mewarisi config kind lain di thread sama", async () => {
    const { app, db } = makeApp();
    const mock = await startMockOpenAI({ replyText: "Balasan openai di thread ini." });
    openMocks.push(mock);
    const user = await registerUser(app, "antar-jenis");
    seedOpenAiConfig(db, user.userId, mock, "sk-live-openai-thread-8888abcd");

    // Giliran openai sukses dulu di thread ini.
    const threadId = "thread-antar-jenis";
    seedThread(db, user.userId, threadId);
    const openaiTurn = await readSse(
      await postTurn(app, user.token, { kind: "openai-compatible", threadId, content: "Untuk openai" }),
    );
    expect(names(openaiTurn.events)).toEqual(
      expect.arrayContaining(["message.final", "turn.settled"]),
    );
    expect(mock.requests).toHaveLength(1);

    // Giliran kind anthropic di thread YANG SAMA tanpa config anthropic:
    // binding openai lama TIDAK diwarisi — no_provider_config, bukan giliran
    // openai terselubung (matriks "Tanpa config anthropic").
    const anthropicTurn = await readSse(
      await postTurn(app, user.token, { kind: "anthropic", threadId, content: "Untuk anthropic" }),
    );
    expect(names(anthropicTurn.events)).toEqual(["thread.updated", "error", "turn.settled"]);
    expect(anthropicTurn.events[1].data.code).toBe("no_provider_config");
    expect(anthropicTurn.raw).not.toMatch(/sk-/);
    // Tiruan openai tak tersentuh oleh giliran kedua.
    expect(mock.requests).toHaveLength(1);
  }, 30_000);

  it("kind invalid: 400 invalid_request pra-stream (envelope), bukan SSE", async () => {
    const { app } = makeApp();
    const user = await registerUser(app, "kind-invalid");

    for (const kind of ["claude", "", 42, null]) {
      const res = await postTurn(app, user.token, { kind, content: "Halo" });
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      await expect(res.json()).resolves.toEqual({
        error: { code: "invalid_request", message: expect.any(String) },
      });
    }
  });

  it("unit resolveProviderEntry: baseUrl/modelId null (anthropic) jatuh ke default; openai-compatible wajib lengkap", () => {
    // Matriks "baseUrl null (unit)": TANPA giliran nyata — tes tak pernah
    // memukul endpoint default Anthropic.
    expect(resolveProviderEntry({ kind: "anthropic", baseUrl: null, modelId: null })).toEqual({
      providerId: "yui-anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      modelId: "claude-sonnet-4-5",
    });

    // Nilai tersimpan menang atas default (tiruan di giliran nyata memakai ini).
    expect(
      resolveProviderEntry({
        kind: "anthropic",
        baseUrl: "http://127.0.0.1:9",
        modelId: "claude-kustom",
      }),
    ).toEqual({
      providerId: "yui-anthropic",
      api: "anthropic-messages",
      baseUrl: "http://127.0.0.1:9",
      modelId: "claude-kustom",
    });

    // Kelengkapan HANYA disyaratkan openai-compatible.
    expect(resolveProviderEntry({ kind: "openai-compatible", baseUrl: null, modelId: "m" })).toBeNull();
    expect(resolveProviderEntry({ kind: "openai-compatible", baseUrl: "http://a/v1", modelId: null })).toBeNull();
    expect(
      resolveProviderEntry({ kind: "openai-compatible", baseUrl: "http://a/v1", modelId: "m1" }),
    ).toEqual({
      providerId: "yui-openai",
      api: "openai-completions",
      baseUrl: "http://a/v1",
      modelId: "m1",
    });
  });

  // bot-tool-calling: a scripted tool_use over the anthropic wire flows through
  // the same allowlisted custom tools and the same SSRF guard.
  it("tool_use turn (view_image on a loopback literal): tool.activity start+end(isError) precede settled; contract intact; provider called twice", async () => {
    const { app, db } = makeApp();
    const preamble = "One moment while I look.";
    const reply = "Anthropic cannot view that image either.";
    const mock = await startMockAnthropic({
      replyText: reply,
      toolCall: { name: "view_image", arguments: { url: "http://127.0.0.1:80/photo.jpg" }, textBefore: preamble },
    });
    openMocks.push(mock);
    const user = await registerUser(app, "anthropic-tool");
    const apiKey = "sk-ant-api-tool-3131tool";
    seedAnthropicConfig(db, user.userId, mock, apiKey);
    seedThread(db, user.userId, "thread-anthropic-tool");

    const res = await postTurn(app, user.token, {
      kind: "anthropic",
      threadId: "thread-anthropic-tool",
      content: "Look at this picture",
      clientToken: "tok-anthropic-tool",
    });
    expect(res.status).toBe(200);
    const { events, raw } = await readSse(res);
    const sequence = names(events);

    // Same transient tool.activity contract as the openai wire: start with the
    // URL, end with the guard reason, both strictly before the last event.
    const activities = events.filter((frame) => frame.event === "tool.activity");
    expect(activities).toHaveLength(2);
    expect(activities[0].data).toEqual({
      threadId: "thread-anthropic-tool",
      tool: "view_image",
      phase: "start",
      detail: "http://127.0.0.1:80/photo.jpg",
    });
    expect(activities[1].data).toMatchObject({ phase: "end", isError: true });
    expect(String(activities[1].data.detail)).toMatch(/loopback address/);
    expect(sequence[sequence.length - 1]).toBe("turn.settled");
    expect(sequence.lastIndexOf("tool.activity")).toBeLessThan(sequence.length - 1);
    expect(sequence).not.toContain("error");

    // The final message joins the preamble hop and the reply hop with a
    // paragraph break — same two-hop assembly as the openai wire.
    const finals = events.filter((frame) => frame.event === "message.final");
    expect(finals).toHaveLength(1);
    expect(finals[0].data.text).toBe(`${preamble}\n\n${reply}`);
    expect(finals[0].data.clientToken).toBe("tok-anthropic-tool");

    // Tool call + follow-up on the anthropic wire, refusal carried back.
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[1].body).toContain("loopback address");
    expect(raw).not.toContain(apiKey);
  }, 30_000);

  // bot-tool-calling: uploaded images reach the provider in anthropic wire form.
  it("image turn: the anthropic body carries the base64 image source block", async () => {
    const { app, db } = makeApp();
    const mock = await startMockAnthropic({ replyText: "Anthropic sees the picture." });
    openMocks.push(mock);
    const user = await registerUser(app, "anthropic-gambar");
    seedAnthropicConfig(db, user.userId, mock, "sk-ant-api-gambar-4242img");
    const botId = seedBot(db, user.userId);

    // A real 1x1 PNG: the engine decodes inline images and drops undecodable
    // bytes with an omission note — the fixture must survive that pipeline.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const bytes = new Uint8Array(png);
    const form = new FormData();
    form.append("file", new File([bytes], "dot.png", { type: "image/png" }));
    const upload = await app.request("/api/images", {
      method: "POST",
      body: form,
      headers: { cookie: `${SESSION_COOKIE}=${user.token}` },
    });
    expect(upload.status).toBe(201);
    const imageId = ((await upload.json()) as { id: string }).id;

    const res = await postTurn(app, user.token, { kind: "anthropic", content: "", imageIds: [imageId], botId });
    expect(res.status).toBe(200);
    const { events } = await readSse(res);
    expect(names(events)).toEqual(expect.arrayContaining(["message.final", "turn.settled"]));

    // anthropic-messages wire: base64 source block with the stored media type.
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].body).toContain(`"type":"base64"`);
    expect(mock.requests[0].body).toContain(`"media_type":"image/png"`);
    expect(mock.requests[0].body).toContain(Buffer.from(bytes).toString("base64"));
    // The placeholder line rode the transcript.
    expect(mock.requests[0].body).toContain("[Image]");
  }, 30_000);
});
