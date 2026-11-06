import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ulid } from "ulidx";
import type { Hono } from "hono";
import { createApp } from "../app.ts";
import { createDatabase, migrateDatabase, type YuiDatabase } from "../db/index.ts";
import { authSessions, users } from "../db/schema.ts";
import { SESSION_COOKIE } from "./cookies.ts";

// Bukti verify story 3: 10 skenario matriks + asersi kebocoran password_hash
// + sesi kadaluarsa manual. Setiap skenario memakai file DB temp segar.

const tmpRoot = mkdtempSync(join(tmpdir(), "yui-auth-test-"));

const openDbs: YuiDatabase[] = [];
let fileSeq = 0;

/** App + DB termigrasi segar per skenario; DB ditutup otomatis di afterEach. */
function makeApp(): { app: Hono; db: YuiDatabase } {
  const db = createDatabase(join(tmpRoot, `auth-${++fileSeq}.db`));
  migrateDatabase(db);
  openDbs.push(db);
  return { app: createApp("dist", db), db };
}

async function postJson(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

async function register(app: Hono, username: string, password: string): Promise<Response> {
  return postJson(app, "/api/auth/register", { username, password });
}

async function login(app: Hono, username: string, password: string): Promise<Response> {
  return postJson(app, "/api/auth/login", { username, password });
}

async function me(app: Hono, token: string | undefined): Promise<Response> {
  return app.request("/api/me", {
    headers: token === undefined ? {} : { cookie: `${SESSION_COOKIE}=${token}` },
  });
}

/** Token mentah dari header Set-Cookie respons (base64url — tanpa '='). */
function sessionToken(res: Response): string | undefined {
  const cookie = res.headers
    .getSetCookie()
    .find((entry) => entry.startsWith(`${SESSION_COOKIE}=`));
  return cookie?.split(";")[0]?.slice(SESSION_COOKIE.length + 1);
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;

/** Tidak ada bentuk hash password yang bocor keluar API. */
function expectNoPasswordLeak(rawBody: string): void {
  expect(rawBody).not.toContain("password_hash");
  expect(rawBody).not.toContain("passwordHash");
}

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.$client.close();
  }
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("POST /api/auth/register", () => {
  it("register valid: 201 + Set-Cookie sesi + body {id, username} tanpa password_hash", async () => {
    const { app } = makeApp();

    const res = await register(app, "Arjuna ", "password-tepat");

    expect(res.status).toBe(201);
    const raw = await res.text();
    // Username dinormalisasi lowercase+trim sebelum disimpan.
    expect(JSON.parse(raw)).toEqual({
      id: expect.stringMatching(ULID),
      username: "arjuna",
    });
    expectNoPasswordLeak(raw);

    const token = sessionToken(res);
    expect(token).toBeDefined();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    const cookieHeader = res.headers.getSetCookie().join("\n");
    expect(cookieHeader).toContain("HttpOnly");
    expect(cookieHeader).toContain("SameSite=Lax");
    expect(cookieHeader).toContain("Path=/");
    expect(cookieHeader).toContain("Secure");
    expect(cookieHeader).toContain("Max-Age=2592000");
  });

  it("register ganda: username sudah dipakai → 409 username_taken (normalisasi menutup variasi kapital)", async () => {
    const { app, db } = makeApp();

    const first = await register(app, "rangga", "password-tepat");
    expect(first.status).toBe(201);

    const second = await register(app, "  RANGGA ", "password-lain");
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toEqual({
      error: { code: "username_taken", message: expect.any(String) },
    });
    // Tidak ada baris user kedua.
    expect(db.select().from(users).all()).toHaveLength(1);
  });

  it("register input invalid: username/password di luar aturan → 400 invalid_request", async () => {
    const { app } = makeApp();
    const cases: Array<Record<string, unknown>> = [
      { username: "ab", password: "password-tepat" }, // username < 3 karakter
      { username: "a".repeat(33), password: "password-tepat" }, // username > 32
      { username: "ada spasi", password: "password-tepat" }, // karakter terlarang
      { username: "tidak-valid!", password: "password-tepat" },
      { username: "validuser", password: "7karak" }, // password < 8 karakter
      { username: 42, password: "password-tepat" }, // tipe salah
      { username: "validuser" }, // password hilang
    ];

    for (const body of cases) {
      const res = await postJson(app, "/api/auth/register", body);
      expect(res.status, `case ${JSON.stringify(body)}`).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: { code: "invalid_request", message: expect.any(String) },
      });
    }

    // Body bukan JSON valid juga ditolak 400, bukan 500.
    const malformed = await postJson(app, "/api/auth/register", "{bukan-json");
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      error: { code: "invalid_request", message: expect.any(String) },
    });
  });
});

describe("POST /api/auth/login", () => {
  it("login valid: 200 + Set-Cookie + body user tanpa password_hash", async () => {
    const { app } = makeApp();
    const registered = await register(app, "sasmi", "password-tepat");
    const registeredId = ((await registered.json()) as { id: string }).id;

    const res = await login(app, "SASMI", "password-tepat");

    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(JSON.parse(raw)).toEqual({ id: registeredId, username: "sasmi" });
    expectNoPasswordLeak(raw);
    // Sesi login adalah baris auth_sessions baru (bukan cookie register).
    expect(sessionToken(res)).not.toBe(sessionToken(registered));
  });

  it("login password salah: 401 invalid_credentials", async () => {
    const { app } = makeApp();
    await register(app, "dewi", "password-tepat");

    const res = await login(app, "dewi", "password-salah");

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: { code: "invalid_credentials", message: expect.any(String) },
    });
  });

  it("login username tak dikenal: respons identik dengan password salah — keberadaan akun tidak bocor", async () => {
    const { app } = makeApp();
    await register(app, "hendra", "password-tepat");

    const wrongPassword = await login(app, "hendra", "password-salah");
    const unknownUser = await login(app, "tidak-ada", "password-apapun");

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(await unknownUser.json()).toEqual(await wrongPassword.json());
  });
});

describe("GET /api/me", () => {
  it("me dengan sesi valid: 200 {id, username, createdAt} ISO-8601", async () => {
    const { app, db } = makeApp();
    const registered = await register(app, "laras", "password-tepat");
    const token = sessionToken(registered);
    const createdAtDb = db
      .select()
      .from(users)
      .where(eq(users.username, "laras"))
      .get()!.createdAt;

    const res = await me(app, token);

    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(JSON.parse(raw)).toEqual({
      id: expect.stringMatching(ULID),
      username: "laras",
      createdAt: new Date(createdAtDb).toISOString(),
    });
    expect(new Date(createdAtDb).toISOString()).toMatch(ISO_8601);
    expectNoPasswordLeak(raw);
  });

  it("me tanpa cookie / token tak dikenal / kadaluarsa: 401 unauthorized", async () => {
    const { app, db } = makeApp();
    await register(app, "mirna", "password-tepat");

    const noCookie = await me(app, undefined);
    expect(noCookie.status).toBe(401);
    await expect(noCookie.json()).resolves.toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    });

    const unknownToken = await me(app, "token-yang-tidak-terdaftar");
    expect(unknownToken.status).toBe(401);

    // Sesi kadaluarsa: baris valid tapi expires_at sudah lewat (insert manual).
    const expiredToken = "expired-token-manual";
    const userId = db
      .select()
      .from(users)
      .where(eq(users.username, "mirna"))
      .get()!.id;
    db.insert(authSessions)
      .values({
        id: ulid(),
        userId,
        tokenHash: createHash("sha256").update(expiredToken).digest("hex"),
        expiresAt: Date.now() - 1_000,
        createdAt: Date.now() - 2_000,
      })
      .run();

    const expired = await me(app, expiredToken);
    expect(expired.status).toBe(401);
    await expect(expired.json()).resolves.toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    });
  });
});

describe("POST /api/auth/logout + pencabutan & isolasi", () => {
  it("logout: 204 + cookie dibersihkan (Max-Age=0) + baris sesi DELETED", async () => {
    const { app, db } = makeApp();
    const registered = await register(app, "pramudya", "password-tepat");
    const token = sessionToken(registered);
    expect(db.select().from(authSessions).all()).toHaveLength(1);

    const res = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    const cookieHeader = res.headers.getSetCookie().join("\n");
    expect(cookieHeader).toContain(`${SESSION_COOKIE}=`);
    expect(cookieHeader).toContain("Max-Age=0");
    expect(db.select().from(authSessions).all()).toHaveLength(0);
  });

  it("sesi tercabut: /api/me dengan cookie lama → 401 unauthorized", async () => {
    const { app } = makeApp();
    const registered = await register(app, "toha", "password-tepat");
    const token = sessionToken(registered);

    await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });

    const res = await me(app, token);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    });
  });

  it("isolasi dua akun: me(A)=A, me(B)=B; logout A tidak mempengaruhi sesi B", async () => {
    const { app } = makeApp();
    // Alur matriks "register+login A dan B": akun dibuat lewat register, tapi
    // cookie yang diuji adalah hasil LOGIN — jalur returning user story 4.
    await register(app, "alpha", "password-tepat");
    await register(app, "bravo", "password-lain");
    const cookieA = sessionToken(await login(app, "alpha", "password-tepat"));
    const cookieB = sessionToken(await login(app, "bravo", "password-lain"));
    expect(cookieA).not.toBe(cookieB);

    const meA = await me(app, cookieA);
    await expect(meA.json()).resolves.toMatchObject({ username: "alpha" });

    const meB = await me(app, cookieB);
    await expect(meB.json()).resolves.toMatchObject({ username: "bravo" });

    // Pencabutan ter-scope per sesi: hanya sesi login A yang mati.
    await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${cookieA}` },
    });

    expect((await me(app, cookieA)).status).toBe(401);
    const stillOk = await me(app, cookieB);
    expect(stillOk.status).toBe(200);
    await expect(stillOk.json()).resolves.toMatchObject({ username: "bravo" });
  });
});
