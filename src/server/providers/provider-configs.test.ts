import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../app.ts";
import { createDatabase, migrateDatabase, type YuiDatabase } from "../db/index.ts";
import { providerConfigs } from "../db/schema.ts";
import { SESSION_COOKIE } from "../auth/cookies.ts";
import { maskSecret } from "./crypto.ts";

// Bukti story API config penyedia (R1 API + R2, AD-3/AD-9): PUT/GET/DELETE
// /api/provider-configs/:kind di balik gerbang sesi; view bermask dari
// masked_hint TERSIMPAN (route tidak pernah mendekripsi); isolasi dua akun;
// validasi pra-tulis tanpa menyentuh penyimpanan; at-rest ciphertext-only.

const KEY_B64 = randomBytes(32).toString("base64");

const tmpRoot = mkdtempSync(join(tmpdir(), "yui-provider-configs-test-"));

const openDbs: YuiDatabase[] = [];
let fileSeq = 0;

function makeApp(): { app: Hono; db: YuiDatabase; file: string } {
  const file = join(tmpRoot, `provider-configs-${++fileSeq}.db`);
  const db = createDatabase(file);
  migrateDatabase(db);
  openDbs.push(db);
  return { app: createApp("dist", db), db, file };
}

/** KEK sekali-pakai aktif sepanjang file (upsert mengekripsi). */
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

async function call(
  app: Hono,
  method: "PUT" | "GET" | "DELETE",
  kind: string,
  token: string | undefined,
  body?: unknown,
): Promise<Response> {
  return app.request(`/api/provider-configs/${kind}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { cookie: `${SESSION_COOKIE}=${token}` }),
    },
  });
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const OPENAI_BODY = {
  baseUrl: "http://127.0.0.1:9/v1",
  modelId: "mock-model",
  apiKey: "sk-live-openai-1111aaaa",
};
const ANTHROPIC_KEY = "sk-live-anthropic-2222bbbb";

type SseEvent = { event: string; data: Record<string, unknown> };

/** Baca seluruh stream SSE sampai tutup; kembalikan frame terurut. */
async function readSse(res: Response): Promise<SseEvent[]> {
  expect(res.body).not.toBeNull();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (dataLines.length > 0) {
        events.push({ event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> });
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  return events;
}

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.$client.close();
  }
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (previousKey === undefined) {
    delete process.env.APP_ENCRYPTION_KEY;
  } else {
    process.env.APP_ENCRYPTION_KEY = previousKey;
  }
});

describe("PUT /api/provider-configs/:kind", () => {
  it("simpan openai: 200 view bermask; DB hanya ciphertext + masked_hint", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "simpan-openai");

    const res = await call(app, "PUT", "openai-compatible", user.token, OPENAI_BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:9/v1",
      modelId: "mock-model",
      maskedHint: maskSecret(OPENAI_BODY.apiKey),
      createdAt: expect.stringMatching(ISO_UTC),
      updatedAt: expect.stringMatching(ISO_UTC),
    });
    // Acceptance: string kunci utuh TIDAK pernah ada di respons.
    expect(JSON.stringify(body)).not.toContain(OPENAI_BODY.apiKey);

    // DB: satu baris, ciphertext format iv:tag:ct, masked_hint terisi,
    // plaintext absen dari bytes kolom.
    const rows = db.select().from(providerConfigs).all();
    expect(rows).toHaveLength(1);
    const ciphertextText = Buffer.from(rows[0]!.ciphertext).toString("utf8");
    expect(ciphertextText.split(":")).toHaveLength(3);
    expect(ciphertextText).not.toContain(OPENAI_BODY.apiKey);
    expect(rows[0]!.maskedHint).toBe(maskSecret(OPENAI_BODY.apiKey));
    expect(rows[0]!.userId).toBe(user.userId);
  });

  it("simpan anthropic: apiKey saja (baseUrl/modelId opsional) → 200 view bermask", async () => {
    const { app } = makeApp();
    const user = await registerUser(app, "simpan-anthropic");

    const res = await call(app, "PUT", "anthropic", user.token, { apiKey: ANTHROPIC_KEY });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      kind: "anthropic",
      baseUrl: null,
      modelId: null,
      maskedHint: maskSecret(ANTHROPIC_KEY),
      createdAt: expect.stringMatching(ISO_UTC),
      updatedAt: expect.stringMatching(ISO_UTC),
    });
    expect(JSON.stringify(body)).not.toContain(ANTHROPIC_KEY);
  });

  it("upsert mengganti: satu baris per (user,kind), masked_hint baru, createdAt bertahan", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "upsert-ganti");

    const first = await call(app, "PUT", "openai-compatible", user.token, OPENAI_BODY);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;

    const secondKey = "sk-live-openai-3333cccc";
    const second = await call(app, "PUT", "openai-compatible", user.token, {
      ...OPENAI_BODY,
      baseUrl: "http://127.0.0.1:10/v1",
      apiKey: secondKey,
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as Record<string, unknown>;

    expect(db.select().from(providerConfigs).all()).toHaveLength(1);
    expect(secondBody.maskedHint).toBe(maskSecret(secondKey));
    expect(secondBody.maskedHint).not.toBe(firstBody.maskedHint);
    expect(secondBody.baseUrl).toBe("http://127.0.0.1:10/v1");
    expect(secondBody.createdAt).toBe(firstBody.createdAt);
    expect(secondBody.updatedAt).toMatch(ISO_UTC);
  });
});

describe("GET /api/provider-configs/:kind", () => {
  it("baca bermask: 200 view persis PUT, tanpa kredensial utuh; 404 bila kosong", async () => {
    const { app } = makeApp();
    const user = await registerUser(app, "baca-bermask");

    const missing = await call(app, "GET", "openai-compatible", user.token);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      error: { code: "not_found", message: expect.any(String) },
    });

    const put = await call(app, "PUT", "openai-compatible", user.token, OPENAI_BODY);
    expect(put.status).toBe(200);
    const view = await call(app, "GET", "openai-compatible", user.token);
    expect(view.status).toBe(200);
    const body = (await view.json()) as Record<string, unknown>;
    expect(body).toEqual(await put.json());
    // Acceptance: kredensial utuh tak pernah ada di body mana pun.
    expect(JSON.stringify(body)).not.toContain(OPENAI_BODY.apiKey);
    expect(JSON.stringify(body)).not.toContain("sk-live-openai");
  });
});

describe("DELETE /api/provider-configs/:kind", () => {
  it("hapus: 204 tanpa body; GET berikut 404; giliran berikut no_provider_config; kedua 404", async () => {
    const { app } = makeApp();
    const user = await registerUser(app, "hapus-config");
    expect(
      (await call(app, "PUT", "openai-compatible", user.token, OPENAI_BODY)).status,
    ).toBe(200);

    const res = await call(app, "DELETE", "openai-compatible", user.token);
    expect(res.status).toBe(204);
    await expect(res.text()).resolves.toBe("");

    expect((await call(app, "GET", "openai-compatible", user.token)).status).toBe(404);

    // Giliran berikutnya: engine tak lagi menemukan config → no_provider_config.
    const turn = await app.request("/api/engine/turn", {
      method: "POST",
      body: JSON.stringify({ content: "Halo" }),
      headers: {
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE}=${user.token}`,
      },
    });
    expect(turn.status).toBe(200);
    const events = await readSse(turn);
    expect(events.map((frame) => frame.event)).toEqual(["error", "turn.settled"]);
    expect(events[0].data.code).toBe("no_provider_config");

    const again = await call(app, "DELETE", "openai-compatible", user.token);
    expect(again.status).toBe(404);
    await expect(again.json()).resolves.toEqual({
      error: { code: "not_found", message: expect.any(String) },
    });
  });
});

describe("isolasi dua akun", () => {
  it("B tidak melihat/menghapus config A (404); B PUT membuat baris sendiri; A tak terganggu", async () => {
    const { app, db } = makeApp();
    const userA = await registerUser(app, "pemilik-a");
    const userB = await registerUser(app, "pemirsa-b");

    const keyA = "sk-live-milik-a-4444dddd";
    const keyB = "sk-live-milik-b-5555eeee";
    const putA = await call(app, "PUT", "anthropic", userA.token, { apiKey: keyA });
    expect(putA.status).toBe(200);

    // B melihat 404 — isi A tak pernah muncul di respons B.
    const getB = await call(app, "GET", "anthropic", userB.token);
    expect(getB.status).toBe(404);
    const getBText = await getB.text();
    expect(getBText).not.toContain(keyA);
    expect(getBText).not.toContain(maskSecret(keyA));

    const deleteB = await call(app, "DELETE", "anthropic", userB.token);
    expect(deleteB.status).toBe(404);
    // Config A tetap utuh setelah B mencoba menghapus.
    const getA = await call(app, "GET", "anthropic", userA.token);
    expect(getA.status).toBe(200);
    expect(((await getA.json()) as Record<string, unknown>).maskedHint).toBe(maskSecret(keyA));

    // B PUT membuat barisnya sendiri: dua baris terpisah, mask masing-masing.
    const putB = await call(app, "PUT", "anthropic", userB.token, { apiKey: keyB });
    expect(putB.status).toBe(200);
    const rows = db.select().from(providerConfigs).all();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.userId).sort()).toEqual([userA.userId, userB.userId].sort());
    expect(((await putB.json()) as Record<string, unknown>).maskedHint).toBe(maskSecret(keyB));

    const getA2 = await call(app, "GET", "anthropic", userA.token);
    expect(getA2.status).toBe(200);
    expect(((await getA2.json()) as Record<string, unknown>).maskedHint).toBe(maskSecret(keyA));
  });
});

describe("validasi ditolak pra-tulis", () => {
  it("semua input invalid → 400 invalid_request envelope; penyimpanan tak tersentuh", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "validasi-400");

    const longKey = "x".repeat(4_097);
    const validKey = { apiKey: "sk-live-valid-9999zzzz" };
    const cases: Array<{
      label: string;
      method: "PUT" | "GET" | "DELETE";
      kind: string;
      body?: unknown;
    }> = [
      { label: "kind path invalid (PUT)", method: "PUT", kind: "bogus", body: validKey },
      { label: "kind path invalid (GET)", method: "GET", kind: "bogus" },
      { label: "kind path invalid (DELETE)", method: "DELETE", kind: "bogus" },
      { label: "apiKey kosong", method: "PUT", kind: "openai-compatible", body: { ...OPENAI_BODY, apiKey: "" } },
      { label: "apiKey bukan string", method: "PUT", kind: "openai-compatible", body: { ...OPENAI_BODY, apiKey: 42 } },
      { label: "apiKey > 4096", method: "PUT", kind: "openai-compatible", body: { ...OPENAI_BODY, apiKey: longKey } },
      { label: "openai tanpa baseUrl", method: "PUT", kind: "openai-compatible", body: { modelId: "m", ...validKey } },
      {
        label: "openai tanpa modelId",
        method: "PUT",
        kind: "openai-compatible",
        body: { baseUrl: "http://127.0.0.1:9/v1", ...validKey },
      },
      { label: "baseUrl bukan http(s)", method: "PUT", kind: "openai-compatible", body: { ...OPENAI_BODY, baseUrl: "ftp://example.com/v1" } },
      { label: "baseUrl bukan URL", method: "PUT", kind: "openai-compatible", body: { ...OPENAI_BODY, baseUrl: "bukan-url" } },
      { label: "modelId > 200", method: "PUT", kind: "openai-compatible", body: { ...OPENAI_BODY, modelId: "m".repeat(201) } },
    ];

    for (const { label, method, kind, body } of cases) {
      const res = await call(app, method, kind, user.token, body);
      expect(res.status, label).toBe(400);
      await expect(res.json(), label).resolves.toEqual({
        error: { code: "invalid_request", message: expect.any(String) },
      });
    }

    // Body bukan JSON: raw request (helper selalu mengirim JSON valid).
    const malformed = await app.request("/api/provider-configs/openai-compatible", {
      method: "PUT",
      body: "{bukan-json",
      headers: {
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE}=${user.token}`,
      },
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      error: { code: "invalid_request", message: expect.any(String) },
    });

    // Matriks: penyimpanan tak tersentuh — jumlah baris tetap nol.
    expect(db.select().from(providerConfigs).all()).toHaveLength(0);
  });
});

describe("tanpa sesi", () => {
  it("PUT/GET/DELETE tanpa cookie → 401 unauthorized envelope", async () => {
    const { app } = makeApp();

    for (const method of ["PUT", "GET", "DELETE"] as const) {
      const res = await call(
        app,
        method,
        "openai-compatible",
        undefined,
        method === "PUT" ? OPENAI_BODY : undefined,
      );
      expect(res.status, method).toBe(401);
      await expect(res.json(), method).resolves.toEqual({
        error: { code: "unauthorized", message: expect.any(String) },
      });
    }
  });
});

describe("at-rest", () => {
  it("dump bytes file DB (utama+WAL) setelah upsert dua akun: hanya ciphertext + masked_hint", async () => {
    const { app, db, file } = makeApp();
    const userA = await registerUser(app, "at-rest-a");
    const userB = await registerUser(app, "at-rest-b");
    const keyA = "sk-live-atrest-a-6666ffff";
    const keyB = "sk-live-atrest-b-7777gggg";

    expect((await call(app, "PUT", "openai-compatible", userA.token, { ...OPENAI_BODY, apiKey: keyA })).status).toBe(200);
    expect((await call(app, "PUT", "anthropic", userB.token, { apiKey: keyB })).status).toBe(200);

    // Dump seluruh bytes yang menyerap state: file DB utama + WAL + SHM
    // (journal mode WAL menahan halaman terbaru di sana sampai checkpoint).
    const parts = [readFileSync(file, "latin1")];
    for (const suffix of ["-wal", "-shm"]) {
      try {
        parts.push(readFileSync(`${file}${suffix}`, "latin1"));
      } catch {
        // file sidecar belum ada — biarkan.
      }
    }
    const bytes = parts.join("\n");

    // String kunci asli absen dari at-rest.
    expect(bytes).not.toContain(keyA);
    expect(bytes).not.toContain(keyB);
    expect(bytes).not.toContain("sk-live-atrest");

    // Kredensial hanya sebagai ciphertext GCM + masked_hint (non-rahasia).
    // File dibaca latin1 sedangkan masked_hint UTF-8 (elipsis multi-byte),
    // jadi kehadirannya diperiksa lewat byte-UTF8-nya, bukan string JS-nya.
    const rows = db.select().from(providerConfigs).all();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const ciphertextText = Buffer.from(row.ciphertext).toString("utf8");
      expect(ciphertextText.split(":")).toHaveLength(3);
      expect(bytes).toContain(ciphertextText.split(":")[2]);
      expect(bytes).toContain(Buffer.from(row.maskedHint, "utf8").toString("latin1"));
    }
  });
});
