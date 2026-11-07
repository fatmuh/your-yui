import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "./auth/cookies.ts";
import { startMockAnthropic, type MockAnthropic } from "../../tests/helpers/mock-anthropic.ts";
import { startMockOpenAI, type MockOpenAI } from "../../tests/helpers/mock-openai.ts";

// Bukti R5 (probe pada build yang DISAJIKAN): entry produksi
// src/server/index.ts di-spawn sebagai anak proses nyata (boot + migrasi +
// serve dalam satu proses) dengan env sekali-pakai. Tiruan penyedia hidup
// in-process di test (127.0.0.1); anak proses menjangkaunya lewat soket nyata.
// Seluruh perjalanan dilalui lewat HTTP API nyata: register → cookie → PUT
// config (enkripsi terjadi DI ANAK PROSES lewat route story 3 — tanpa seeding
// DB langsung) → POST /api/engine/turn → SSE dibaca dari body respons soket.
// Tanpa jaringan luar; tanpa perubahan perilaku server produksi.

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DATA_DIR = mkdtempSync(join(tmpdir(), "yui-served-probe-"));
const DISPOSABLE_KEK = randomBytes(32).toString("base64");

// Kunci dengan ujung yang dipilih agar mask-nya persis `sk-…abcd` /
// `sk-…wxyz` (prefiks 3 + elipsis + 4 terakhir, konvensi crypto.ts).
const OPENAI_API_KEY = "sk-live-served-aaaabbbbccccabcd";
const ANTHROPIC_API_KEY = "sk-ant-served-11112222wxyz";

const JSON_HEADERS = { "content-type": "application/json" };

let child: ChildProcess | null = null;
let baseUrl = "";

/** stdout + stderr anak proses sejak spawn — untuk audit R2 (kunci utuh absen). */
let childOutput = "";

const openMocks: Array<MockOpenAI | MockAnthropic> = [];
/** Setiap body respons yang pernah diterima test — untuk audit R2. */
const responseBodies: string[] = [];

type SseEvent = { event: string; data: Record<string, unknown> };

/** Cadangkan port lewat listen(0) lalu tutup — PORT=0 ditolak index.ts (jatuh default 3000). */
function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("reservePort: unexpected listen address"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Spawn anak proses produksi (cwd = root repo agar `dist` di-serve persis
 * seperti CI) dan tunggu baris log `listening on http://localhost:PORT`.
 * Timeout/gagal → error membawa seluruh log yang terkumpul.
 */
async function spawnServed(port: number): Promise<ChildProcess> {
  const spawned = spawn(process.execPath, [join(REPO_ROOT, "src", "server", "index.ts")], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: DATA_DIR,
      APP_ENCRYPTION_KEY: DISPOSABLE_KEK,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise<void>((resolve, reject) => {
    const marker = `listening on http://localhost:${port}`;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `anak proses tak mengumumkan "${marker}" dalam 30 detik\n--- stdout+stderr anak ---\n${childOutput}`,
        ),
      );
    }, 30_000);
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    spawned.stdout!.setEncoding("utf8");
    spawned.stdout!.on("data", (chunk: string) => {
      childOutput += chunk;
      if (childOutput.includes(marker)) succeed();
    });
    spawned.stderr!.setEncoding("utf8");
    spawned.stderr!.on("data", (chunk: string) => {
      childOutput += chunk;
    });
    spawned.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `anak proses mati sebelum listening (code=${code} signal=${signal})\n--- stdout+stderr anak ---\n${childOutput}`,
        ),
      );
    });
  });

  return spawned;
}

/** SIGTERM → tunggu exit (grace) → SIGKILL fallback; tidak pernah menggantung. */
async function stopChild(target: ChildProcess): Promise<void> {
  if (target.exitCode !== null || target.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    target.once("exit", () => resolve());
  });
  target.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (target.exitCode === null && target.signalCode === null) {
    target.kill("SIGKILL");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
}

/** Fetch nyata ke anak proses; body direkam untuk audit R2 lalu di-parse JSON. */
async function requestJson(
  path: string,
  init: RequestInit,
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  responseBodies.push(text);
  let body: unknown = null;
  try {
    body = text.length > 0 ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = null;
  }
  return { status: res.status, headers: res.headers, body };
}

/** Register via HTTP nyata → 201 + Set-Cookie; kembalikan pasangan cookie utuh. */
async function registerUser(username: string): Promise<string> {
  const res = await requestJson("/api/auth/register", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ username, password: "password-tepat" }),
  });
  expect(res.status).toBe(201);
  const cookie = res.headers
    .getSetCookie()
    .find((entry) => entry.startsWith(`${SESSION_COOKIE}=`));
  expect(cookie).toBeDefined();
  const body = res.body as { id: string; username: string };
  expect(body).toMatchObject({ username });
  return cookie!.split(";")[0]!;
}

type ConfigView = {
  kind: string;
  baseUrl: string | null;
  modelId: string | null;
  maskedHint: string;
};

async function putConfig(
  cookie: string,
  kind: string,
  payload: Record<string, unknown>,
): Promise<ConfigView> {
  const res = await requestJson(`/api/provider-configs/${kind}`, {
    method: "PUT",
    headers: { ...JSON_HEADERS, cookie },
    body: JSON.stringify(payload),
  });
  expect(res.status).toBe(200);
  return res.body as ConfigView;
}

async function getConfig(cookie: string, kind: string): Promise<ConfigView> {
  const res = await requestJson(`/api/provider-configs/${kind}`, {
    method: "GET",
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  return res.body as ConfigView;
}

/** Baca seluruh stream SSE dari soket nyata sampai tutup; kembalikan frame terurut. */
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
  responseBodies.push(raw);
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

async function postTurn(
  cookie: string,
  body: Record<string, unknown>,
): Promise<{ events: SseEvent[]; raw: string }> {
  const res = await fetch(`${baseUrl}/api/engine/turn`, {
    method: "POST",
    headers: { ...JSON_HEADERS, cookie },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  return readSse(res);
}

/** Kontrak giliran penuh (R5): ≥2 delta kumulatif prefix-monotonic → 1 final
 * (clientToken + teks penuh) → turn.settled terakhir, tanpa error. */
function assertFullContract(
  events: SseEvent[],
  expected: { threadId: string; clientToken: string; reply: string },
): void {
  const deltas = events.filter((frame) => frame.event === "message.delta");
  const finals = events.filter((frame) => frame.event === "message.final");
  const settled = events.filter((frame) => frame.event === "turn.settled");
  const errors = events.filter((frame) => frame.event === "error");

  expect(deltas.length).toBeGreaterThanOrEqual(2);
  for (let i = 1; i < deltas.length; i += 1) {
    const current = deltas[i].data.text as string;
    const previous = deltas[i - 1].data.text as string;
    expect(current.startsWith(previous)).toBe(true);
    expect(current.length).toBeGreaterThan(previous.length);
  }
  expect(deltas[deltas.length - 1].data.text).toBe(expected.reply);
  for (const delta of deltas) {
    expect(delta.data).toMatchObject({ threadId: expected.threadId, role: "assistant" });
  }

  expect(finals).toHaveLength(1);
  expect(finals[0].data).toEqual({
    threadId: expected.threadId,
    messageId: deltas[0].data.messageId,
    role: "assistant",
    clientToken: expected.clientToken,
    text: expected.reply,
  });

  expect(errors).toHaveLength(0);
  expect(settled).toHaveLength(1);
  expect(names(events)[names(events).length - 1]).toBe("turn.settled");
  expect(settled[0].data).toEqual({ threadId: expected.threadId });
}

beforeAll(async () => {
  const port = await reservePort();
  child = await spawnServed(port);
  baseUrl = `http://127.0.0.1:${port}`;
}, 60_000);

afterAll(async () => {
  if (child !== null) {
    await stopChild(child);
  }
  while (openMocks.length > 0) {
    await openMocks.pop()?.close();
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
}, 15_000);

describe("probe build tersaji — anak proses produksi lewat HTTP+SSE nyata", () => {
  it("boot & serve: log listening, migrasi membentuk DB temp, GET / menyajikan dist bila ada", async (ctx) => {
    // Migrasi boot jalan di anak proses → file DB tunggal terbentuk di DATA_DIR temp.
    expect(existsSync(join(DATA_DIR, "yui.db"))).toBe(true);

    // CI selalu build sebelum test (typecheck → build → test) sehingga asertif
    // aktif di sana; lokal tanpa `npm run build` → skip asertif dengan alasan.
    if (!existsSync(join(REPO_ROOT, "dist", "index.html"))) {
      ctx.skip("dist/index.html tidak ada — jalankan `npm run build` (CI selalu build sebelum test)");
    }
    const res = await fetch(`${baseUrl}/`);
    const text = await res.text();
    responseBodies.push(text);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  }, 60_000);

  it("giliran openai-compatible nyata: register → PUT config → SSE kontrak penuh; Bearer = kunci yang di-PUT", async () => {
    const reply = "Jawaban tiruan penyajian: giliran openai mengalir penuh lewat soket nyata.";
    const mock = await startMockOpenAI({ replyText: reply });
    openMocks.push(mock);
    const cookie = await registerUser("probe-openai");

    // Enkripsi terjadi di anak proses lewat route story 3; respons hanya view bermask.
    const put = await putConfig(cookie, "openai-compatible", {
      apiKey: OPENAI_API_KEY,
      baseUrl: mock.baseUrl,
      modelId: "mock-model",
    });
    expect(put.kind).toBe("openai-compatible");
    expect(put.baseUrl).toBe(mock.baseUrl);
    expect(put.modelId).toBe("mock-model");
    expect(put.maskedHint).toBe("sk-…abcd");
    expect(JSON.stringify(put)).not.toContain(OPENAI_API_KEY);

    // GET view pun hanya bermask — kunci utuh tak pernah kembali (R2).
    const view = await getConfig(cookie, "openai-compatible");
    expect(view.maskedHint).toBe("sk-…abcd");
    expect(JSON.stringify(view)).not.toContain(OPENAI_API_KEY);

    const { events, raw } = await postTurn(cookie, {
      threadId: "thread-served-openai",
      content: "Giliran uji openai pada proses penyajian",
      clientToken: "tok-served-openai",
    });
    assertFullContract(events, {
      threadId: "thread-served-openai",
      clientToken: "tok-served-openai",
      reply,
    });
    expect(raw).not.toContain(OPENAI_API_KEY);

    // Header auth yang sampai ke tiruan = kunci yang di-PUT (dekripsi di anak).
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].method).toBe("POST");
    expect(mock.requests[0].authorization).toBe(`Bearer ${OPENAI_API_KEY}`);
    expect(mock.requests[0].url).toBe("/v1/chat/completions");
    expect(mock.requests[0].body).toContain("Giliran uji openai pada proses penyajian");
  }, 60_000);

  it("giliran anthropic nyata + R2: x-api-key = kunci yang di-PUT; kunci utuh absen dari semua body + log anak proses", async () => {
    const reply = "Jawaban tiruan penyajian anthropic: kontrak identik lewat adapter yang sama.";
    const mock = await startMockAnthropic({ replyText: reply });
    openMocks.push(mock);
    const cookie = await registerUser("probe-anthropic");

    // anthropic hanya wajib apiKey; baseUrl → tiruan (TANPA /v1 — SDK menambah
    // path-nya); modelId jatuh ke default internal adapter.
    const put = await putConfig(cookie, "anthropic", {
      apiKey: ANTHROPIC_API_KEY,
      baseUrl: mock.baseUrl,
    });
    expect(put.kind).toBe("anthropic");
    expect(put.maskedHint).toBe("sk-…wxyz");
    expect(JSON.stringify(put)).not.toContain(ANTHROPIC_API_KEY);

    const { events, raw } = await postTurn(cookie, {
      kind: "anthropic",
      threadId: "thread-served-anthropic",
      content: "Giliran uji anthropic pada proses penyajian",
      clientToken: "tok-served-anthropic",
    });
    assertFullContract(events, {
      threadId: "thread-served-anthropic",
      clientToken: "tok-served-anthropic",
      reply,
    });
    expect(raw).not.toContain(ANTHROPIC_API_KEY);

    // Wire anthropic: x-api-key = kunci yang di-PUT, path /v1/messages.
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].method).toBe("POST");
    expect(mock.requests[0].url).toMatch(/^\/v1\/messages/);
    expect(mock.requests[0].apiKeyHeader).toBe(ANTHROPIC_API_KEY);
    expect(mock.requests[0].body).toContain("Giliran uji anthropic pada proses penyajian");

    // R2 pada proses nyata: kunci utuh KEDUA jenis absen dari setiap body
    // respons yang pernah diterima test maupun stdout/stderr anak proses.
    for (const body of responseBodies) {
      expect(body).not.toContain(OPENAI_API_KEY);
      expect(body).not.toContain(ANTHROPIC_API_KEY);
    }
    expect(childOutput).not.toContain(OPENAI_API_KEY);
    expect(childOutput).not.toContain(ANTHROPIC_API_KEY);
  }, 60_000);
});
