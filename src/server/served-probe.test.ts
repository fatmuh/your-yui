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
import { readSse, type SseEvent } from "../../tests/helpers/sse.ts";

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

  // Output THIS child produced only — the listening-marker scan must not see
  // the previous child's log (shared childOutput accumulates across spawns),
  // so any port, even a re-issued one, resolves unambiguously.
  let spawnedOutput = "";

  await new Promise<void>((resolve, reject) => {
    const marker = `listening on http://localhost:${port}`;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Jangan bocorkan anak proses hidup: boot mungkin saja hanya lambat
      // (runner CI sesak) — bunuh pasti SEBELUM reject (exit-handler sudah
      // di-guard `settled`, jadi tak ada double-settle).
      spawned.kill("SIGKILL");
      reject(
        new Error(
          `anak proses tak mengumumkan "${marker}" dalam 30 detik\n--- stdout+stderr anak ---\n${spawnedOutput}`,
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
      spawnedOutput += chunk;
      if (spawnedOutput.includes(marker)) succeed();
    });
    spawned.stderr!.setEncoding("utf8");
    spawned.stderr!.on("data", (chunk: string) => {
      childOutput += chunk;
      spawnedOutput += chunk;
    });
    spawned.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `anak proses mati sebelum listening (code=${code} signal=${signal})\n--- stdout+stderr anak ---\n${spawnedOutput}`,
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

/** readSse bersama (tests/helpers/sse.ts) + rekam raw body untuk audit R2 —
 * helper murni tak tahu perekaman, probe membungkus untuk pencatatan. */
async function readSseRecorded(res: Response): Promise<{ events: SseEvent[]; raw: string }> {
  const result = await readSse(res);
  responseBodies.push(result.raw);
  return result;
}

function names(events: SseEvent[]): string[] {
  return events.map((frame) => frame.event);
}

/** Story 3: tanpa threadId di POST, thread dibuat server — id giliran
 * diambil dari event final stream (kontrak: tepat satu final per giliran). */
function threadIdFromEvents(events: SseEvent[]): string {
  const final = events.find((frame) => frame.event === "message.final");
  expect(final).toBeDefined();
  return String(final!.data.threadId);
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
  return readSseRecorded(res);
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
    // Anak sudah exit dan seluruh outputnya tertangkap — audit ulang R2 agar
    // kebocoran kunci SETELAH test terakhir (mis. log saat shutdown/SIGTERM)
    // pun memerahkan suite, bukan lolos tanpa diperiksa. childOutput
    // terakumulasi lintas spawn → audit ini meliputi SEMUA anak proses.
    expect(childOutput).not.toContain(OPENAI_API_KEY);
    expect(childOutput).not.toContain(ANTHROPIC_API_KEY);
  }
  while (openMocks.length > 0) {
    await openMocks.pop()?.close();
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
  // R2 audit penuh di akhir file: kunci utuh KEDUA jenis absen dari SETIAP
  // body respons yang pernah diterima test — termasuk respons describe
  // kedua (restart, config view, SSE giliran-3) yang tak tercakup audit
  // mid-suite test terakhir describe pertama.
  for (const body of responseBodies) {
    expect(body).not.toContain(OPENAI_API_KEY);
    expect(body).not.toContain(ANTHROPIC_API_KEY);
  }
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
      content: "Giliran uji openai pada proses penyajian",
      clientToken: "tok-served-openai",
    });
    assertFullContract(events, {
      threadId: threadIdFromEvents(events),
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
      content: "Giliran uji anthropic pada proses penyajian",
      clientToken: "tok-served-anthropic",
    });
    assertFullContract(events, {
      threadId: threadIdFromEvents(events),
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

    // R2 pada proses nyata: kunci utuh KEDUA jenis absen dari stdout/stderr
    // anak proses hingga titik ini (audit penuh semua body respons + kedua
    // anak proses berjalan di afterAll).
    expect(childOutput).not.toContain(OPENAI_API_KEY);
    expect(childOutput).not.toContain(ANTHROPIC_API_KEY);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Ticket 7 — integrated verification of the served build: multi-turn context
// through the full HTTP path, two-account isolation, and persistence across a
// process restart with the same DATA_DIR + KEK. Vitest runs tests in
// declaration order, so this describe (and the child swap its last test
// performs) can never disturb the tests above.
// ---------------------------------------------------------------------------
describe("served build — multi-turn over HTTP, two-account isolation, restart persistence", () => {
  // State shared by the three tests below (declaration order is the contract).
  // Provider mocks live in the TEST process, so they stay reachable when the
  // served child process is replaced by a fresh one in the restart test.
  let aliceCookie = "";
  let aliceThreadId = "";
  let anthropicMock: MockAnthropic | null = null;

  // Unique per run of this file: one content marker per turn, one reply text
  // per mock instance. Turn 3 reuses the turn-2 anthropic mock by design, so
  // its reply text is the turn-2 reply text.
  const turn1Content = "Served multi-turn marker one 4d71";
  const turn2Content = "Served multi-turn marker two 8be3";
  const turn3Content = "Served multi-turn marker three c9f2";
  const turn1Reply = "Served mock reply one: openai adapter answers turn one.";
  const turn2Reply = "Served mock reply two: anthropic adapter answers turn two.";

  type HistoryMessage = { id: string; role: string; text: string; createdAt: string };
  type ThreadSummary = { id: string; title: string };

  /** Only the provider API POSTs. The engine stack also fires background
   * `GET /` reachability probes at the provider origin (traced, no body); they
   * land in the mock's request log asynchronously, so assertions on the wire
   * contract must filter them out instead of trusting request indices. */
  function apiPosts<Request extends { method: string | undefined; url: string | undefined }>(
    requests: Request[],
    pathPrefix: string,
  ): Request[] {
    return requests.filter(
      (request) => request.method === "POST" && request.url !== undefined && request.url.startsWith(pathPrefix),
    );
  }

  it("multi-turn, two provider kinds, one thread: server-assembled transcript + REST history", async () => {
    const openaiMock = await startMockOpenAI({ replyText: turn1Reply });
    openMocks.push(openaiMock);
    anthropicMock = await startMockAnthropic({ replyText: turn2Reply });
    openMocks.push(anthropicMock);

    aliceCookie = await registerUser("probe-alice");
    const openaiPut = await putConfig(aliceCookie, "openai-compatible", {
      apiKey: OPENAI_API_KEY,
      baseUrl: openaiMock.baseUrl,
      modelId: "mock-model",
    });
    expect(openaiPut.maskedHint).toBe("sk-…abcd");
    const anthropicPut = await putConfig(aliceCookie, "anthropic", {
      apiKey: ANTHROPIC_API_KEY,
      baseUrl: anthropicMock.baseUrl,
    });
    expect(anthropicPut.maskedHint).toBe("sk-…wxyz");

    // Turn 1 — no threadId: the default kind (openai-compatible) runs and the
    // server creates the thread; its id comes from the final event.
    const turn1 = await postTurn(aliceCookie, {
      content: turn1Content,
      clientToken: "tok-mt-one",
    });
    aliceThreadId = threadIdFromEvents(turn1.events);
    assertFullContract(turn1.events, {
      threadId: aliceThreadId,
      clientToken: "tok-mt-one",
      reply: turn1Reply,
    });
    // The mock received the key that was PUT (decryption happened in the child).
    const openaiPosts = apiPosts(openaiMock.requests, "/v1/chat/completions");
    expect(openaiPosts).toHaveLength(1);
    expect(openaiPosts[0].authorization).toBe(`Bearer ${OPENAI_API_KEY}`);

    // Turn 2 — same thread, explicit anthropic kind: kind is chosen per turn.
    const turn2 = await postTurn(aliceCookie, {
      kind: "anthropic",
      threadId: aliceThreadId,
      content: turn2Content,
      clientToken: "tok-mt-two",
    });
    assertFullContract(turn2.events, {
      threadId: aliceThreadId,
      clientToken: "tok-mt-two",
      reply: turn2Reply,
    });

    // MULTI-TURN CONTEXT PROOF: the recorded anthropic request body carries
    // turn 1's user content AND turn 1's assistant reply — the transcript was
    // assembled server-side from the stored thread (AD-5), not echoed by the
    // client, and it also carries the turn-2 user content just written.
    const anthropicPosts = apiPosts(anthropicMock.requests, "/v1/messages");
    expect(anthropicPosts).toHaveLength(1);
    expect(anthropicPosts[0].body).toContain(turn1Content);
    expect(anthropicPosts[0].body).toContain(turn1Reply);
    expect(anthropicPosts[0].body).toContain(turn2Content);

    // History via REST: exactly 4 messages, alternating roles, exact texts.
    const history = await requestJson(`/api/threads/${aliceThreadId}/messages`, {
      headers: { cookie: aliceCookie },
    });
    expect(history.status).toBe(200);
    const before = history.body as HistoryMessage[];
    expect(before).toHaveLength(4);
    expect(before.map((message) => [message.role, message.text])).toEqual([
      ["user", turn1Content],
      ["assistant", turn1Reply],
      ["user", turn2Content],
      ["assistant", turn2Reply],
    ]);

    // The thread is listed for alice, titled after its first user message.
    const list = await requestJson("/api/threads", { headers: { cookie: aliceCookie } });
    expect(list.status).toBe(200);
    const threads = list.body as ThreadSummary[];
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe(aliceThreadId);
    expect(threads[0].title).toBe(turn1Content);
  }, 60_000);

  it("two-account isolation: bob never reaches alice's thread through list, history, or turn", async () => {
    if (aliceThreadId === "") throw new Error("alice thread missing — test order broken");

    const bobCookie = await registerUser("probe-bob");

    // Positive control: alice's cookie DOES reach the thread, so bob's 404s
    // below prove isolation, not a thread that never existed.
    const aliceHistory = await requestJson(`/api/threads/${aliceThreadId}/messages`, {
      headers: { cookie: aliceCookie },
    });
    expect(aliceHistory.status).toBe(200);
    expect(aliceHistory.body).toHaveLength(4);

    // Door 1 — thread list: exactly [] (alice's thread does not leak).
    const list = await requestJson("/api/threads", { headers: { cookie: bobCookie } });
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);

    // Door 2 — reading alice's history: 404 envelope, identical to the
    // response for a thread that does not exist (no existence leak).
    const history = await requestJson(`/api/threads/${aliceThreadId}/messages`, {
      headers: { cookie: bobCookie },
    });
    expect(history.status).toBe(404);
    expect(history.body).toMatchObject({ error: { code: "not_found" } });

    // Door 3 — writing a turn into alice's thread: 404 envelope BEFORE any
    // streaming, i.e. a plain JSON response, never an SSE stream.
    const turn = await requestJson("/api/engine/turn", {
      method: "POST",
      headers: { ...JSON_HEADERS, cookie: bobCookie },
      body: JSON.stringify({
        threadId: aliceThreadId,
        content: "Bob attempts to write into alice's thread",
        clientToken: "tok-bob-isolated",
      }),
    });
    expect(turn.status).toBe(404);
    expect(turn.body).toMatchObject({ error: { code: "not_found" } });
    expect(turn.headers.get("content-type")).toContain("application/json");
  }, 60_000);

  it("restart with same DATA_DIR + KEK: history identical, session + configs survive, turn 3 keeps writing", async () => {
    if (anthropicMock === null) throw new Error("anthropic mock missing — test order broken");

    // Snapshot everything that must survive the restart, read fresh from the
    // OLD child right before it is stopped (self-contained within this test).
    const historyBefore = await requestJson(`/api/threads/${aliceThreadId}/messages`, {
      headers: { cookie: aliceCookie },
    });
    expect(historyBefore.status).toBe(200);
    expect(historyBefore.body).toHaveLength(4);

    const listBefore = await requestJson("/api/threads", { headers: { cookie: aliceCookie } });
    expect(listBefore.status).toBe(200);
    const threadsBefore = listBefore.body as ThreadSummary[];
    expect(threadsBefore).toHaveLength(1);
    expect(threadsBefore[0].id).toBe(aliceThreadId);
    const titleBefore = threadsBefore[0].title;

    if (child === null) throw new Error("served child missing — test order broken");
    await stopChild(child);
    // Reserve the replacement port AFTER the old child released its socket:
    // spawnServed scans only ITS OWN output for the listening marker, so even
    // a re-issued port stays unambiguous — and the unheld-port window other
    // ephemeral allocations could steal from stays as short as possible.
    const newPort = await reservePort();
    child = await spawnServed(newPort);
    baseUrl = `http://127.0.0.1:${newPort}`;

    // Alice's ORIGINAL cookie still works: sessions live in the DB table
    // auth_sessions, not in process memory. History is deep-equal to the
    // pre-restart snapshot (same ids, roles, texts, createdAt).
    const historyAfter = await requestJson(`/api/threads/${aliceThreadId}/messages`, {
      headers: { cookie: aliceCookie },
    });
    expect(historyAfter.status).toBe(200);
    expect(historyAfter.body).toEqual(historyBefore.body);

    // The thread is still listed under the same title.
    const listAfter = await requestJson("/api/threads", { headers: { cookie: aliceCookie } });
    expect(listAfter.status).toBe(200);
    const threadsAfter = listAfter.body as ThreadSummary[];
    expect(threadsAfter.map((thread) => ({ id: thread.id, title: thread.title }))).toEqual([
      { id: aliceThreadId, title: titleBefore },
    ]);

    // Both provider configs survive the restart (stored ciphertext + the same
    // KEK from env) with the same masked hints and no raw key in the view.
    const openaiView = await getConfig(aliceCookie, "openai-compatible");
    expect(openaiView.maskedHint).toBe("sk-…abcd");
    expect(JSON.stringify(openaiView)).not.toContain(OPENAI_API_KEY);
    const anthropicView = await getConfig(aliceCookie, "anthropic");
    expect(anthropicView.maskedHint).toBe("sk-…wxyz");
    expect(JSON.stringify(anthropicView)).not.toContain(ANTHROPIC_API_KEY);

    // Turn 3 after the restart — the new child does not only read, it WRITES:
    // the anthropic mock still lives in the test process, so the stream runs
    // to a full contract on the same thread.
    const turn3 = await postTurn(aliceCookie, {
      kind: "anthropic",
      threadId: aliceThreadId,
      content: turn3Content,
      clientToken: "tok-mt-three",
    });
    assertFullContract(turn3.events, {
      threadId: aliceThreadId,
      clientToken: "tok-mt-three",
      reply: turn2Reply,
    });

    // Cross-restart transcript: turn 3's request body still carries turn 1's
    // content — the new child reassembled history written by the old one.
    const anthropicTurns = apiPosts(anthropicMock.requests, "/v1/messages");
    expect(anthropicTurns).toHaveLength(2);
    expect(anthropicTurns[1].body).toContain(turn1Content);
    expect(anthropicTurns[1].body).toContain(turn3Content);

    // History now holds exactly 6 messages; turn 3 reused the turn-2 mock, so
    // its assistant text is the turn-2 reply text.
    const finalHistory = await requestJson(`/api/threads/${aliceThreadId}/messages`, {
      headers: { cookie: aliceCookie },
    });
    expect(finalHistory.status).toBe(200);
    const finalMessages = finalHistory.body as HistoryMessage[];
    expect(finalMessages).toHaveLength(6);
    expect(finalMessages.map((message) => [message.role, message.text])).toEqual([
      ["user", turn1Content],
      ["assistant", turn1Reply],
      ["user", turn2Content],
      ["assistant", turn2Reply],
      ["user", turn3Content],
      ["assistant", turn2Reply],
    ]);
  }, 60_000);
});
