import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../app.ts";
import { createDatabase, migrateDatabase, type YuiDatabase } from "../db/index.ts";
import { SESSION_COOKIE } from "../auth/cookies.ts";
import { upsertProviderConfig } from "../providers/store.ts";
import { startMockOpenAI, type MockOpenAI } from "../../../tests/helpers/mock-openai.ts";
import { startMockAnthropic, type MockAnthropic } from "../../../tests/helpers/mock-anthropic.ts";
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

/** Register + ambil token cookie mentah dari Set-Cookie beserta userId. */
async function registerUser(app: Hono, username: string): Promise<{ token: string; userId: string }> {
  const res = await app.request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, password: "password-tepat" }),
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(201);
  const cookie = res.headers
    .getSetCookie()
    .find((entry) => entry.startsWith(`${SESSION_COOKIE}=`));
  expect(cookie).toBeDefined();
  const body = (await res.json()) as { id: string };
  return { token: cookie!.split(";")[0]!.slice(SESSION_COOKIE.length + 1), userId: body.id };
}

async function postTurn(
  app: Hono,
  token: string | undefined,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request("/api/engine/turn", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { cookie: `${SESSION_COOKIE}=${token}` }),
    },
  });
}

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

type SseEvent = { event: string; data: Record<string, unknown> };

/** Baca seluruh stream SSE sampai tutup; kembalikan frame terurut. */
async function readSse(res: Response): Promise<{ events: SseEvent[]; raw: string }> {
  expect(res.body).not.toBeNull();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = "";
  let raw = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    raw += text;
    buffer += text;
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseFrame(frame);
      if (parsed !== null) events.push(parsed);
      boundary = buffer.indexOf("\n\n");
    }
  }
  return { events, raw };
}

function parseFrame(frame: string): SseEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> };
}

function names(events: SseEvent[]): string[] {
  return events.map((frame) => frame.event);
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

    const failed = await postTurn(app, user.token, { kind: "anthropic", threadId: "thread-ag", content: "Coba" });
    expect(failed.status).toBe(200);
    const { events, raw } = await readSse(failed);

    expect(names(events)).toEqual(["error", "turn.settled"]);
    expect(events[0].data.code).toBe("provider_error");
    expect(typeof events[0].data.message).toBe("string");
    expect(events[0].data.threadId).toBe("thread-ag");
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

    const res = await postTurn(app, user.token, { kind: "anthropic", content: "Coba putus" });
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
    const { app } = makeApp();
    const user = await registerUser(app, "anthropic-tanpa-config");

    const res = await postTurn(app, user.token, { kind: "anthropic", content: "Halo" });
    expect(res.status).toBe(200);

    const { events, raw } = await readSse(res);
    expect(names(events)).toEqual(["error", "turn.settled"]);
    expect(events[0].data.code).toBe("no_provider_config");
    expect(typeof events[0].data.message).toBe("string");
    expect(events[1].data).toEqual({ threadId: events[0].data.threadId });
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
    expect(names(anthropicTurn.events)).toEqual(["error", "turn.settled"]);
    expect(anthropicTurn.events[0].data.code).toBe("no_provider_config");
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
});
