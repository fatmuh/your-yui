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

function seedConfig(db: YuiDatabase, userId: string, mock: MockOpenAI, apiKey: string) {
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

describe("POST /api/engine/turn — matriks story", () => {
  it("happy path: ≥2 delta kumulatif prefix-monotonic → 1 final (clientToken) → settled, stream tutup", async () => {
    const { app, db } = makeApp();
    const reply = "Jawaban tiruan lokal: giliran uji ini mengalir penuh sampai akhir.";
    const mock = await startMockOpenAI({ replyText: reply });
    openMocks.push(mock);
    const user = await registerUser(app, "arjuna");
    const apiKey = "sk-live-uji-1234567890abcd";
    seedConfig(db, user.userId, mock, apiKey);

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
    expect(raw).not.toContain(apiKey);
  }, 30_000);

  it("tanpa config tersimpan: 1 error (tanpa kredensial) + turn.settled; engine tak tersentuh", async () => {
    const { app } = makeApp();
    const user = await registerUser(app, "tanpa-config");

    const res = await postTurn(app, user.token, { content: "Halo" });
    expect(res.status).toBe(200);

    const { events, raw } = await readSse(res);
    expect(names(events)).toEqual(["error", "turn.settled"]);
    expect(events[0].data.code).toBe("no_provider_config");
    expect(typeof events[0].data.message).toBe("string");
    expect(events[1].data).toEqual({ threadId: events[0].data.threadId });
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

    const failed = await postTurn(app, user.token, { threadId: "thread-gagal", content: "Coba" });
    expect(failed.status).toBe(200);
    const { events, raw } = await readSse(failed);

    expect(names(events)).toEqual(["error", "turn.settled"]);
    expect(events[0].data.code).toBe("provider_error");
    expect(typeof events[0].data.message).toBe("string");
    expect(events[0].data.threadId).toBe("thread-gagal");
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

    const res = await postTurn(app, user.token, { content: "Coba putus" });
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

    const prev = process.env.APP_ENCRYPTION_KEY;
    delete process.env.APP_ENCRYPTION_KEY;
    try {
      const res = await postTurn(app, user.token, { content: "Halo" });
      expect(res.status).toBe(200);
      const { events } = await readSse(res);
      expect(names(events)).toEqual(["error", "turn.settled"]);
      expect(events[0].data.code).toBe("engine_setup_failed");
      expect(events[0].data.message).toContain("APP_ENCRYPTION_KEY");
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

    const turnA = await postTurn(app, userA.token, { threadId: "ta", content: "Untuk alpha" });
    const turnB = await postTurn(app, userB.token, { threadId: "tb", content: "Untuk bravo" });
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
    const before = await readSse(await postTurn(app, user.token, { threadId, content: "Sebelum" }));
    expect(names(before.events)).toEqual(["error", "turn.settled"]);
    expect(before.events[0].data.code).toBe("no_provider_config");

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
