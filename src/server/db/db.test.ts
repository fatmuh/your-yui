import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulidx";
import Database from "better-sqlite3";
import { authSessions, users, type AuthSession, type User } from "./schema.ts";
import { createDatabase, migrateDatabase, resolveDatabasePath } from "./index.ts";

const tmpRoot = mkdtempSync(join(tmpdir(), "yui-db-test-"));

const openDbs: ReturnType<typeof createDatabase>[] = [];
let fileSeq = 0;

/** DB file segar per skenario, ditutup otomatis di afterEach. */
function makeDb() {
  const db = createDatabase(join(tmpRoot, `case-${++fileSeq}.db`));
  openDbs.push(db);
  return db;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Introspeksi sqlite_master lewat koneksi better-sqlite3 mentah. */
function tableNames(filePath: string): string[] {
  const raw = new Database(filePath);
  try {
    return raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
  } finally {
    raw.close();
  }
}

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.$client.close();
  }
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("migrasi schema dasar", () => {
  it("migrasi bersih: membuat tabel users dan auth_sessions + mengisi __drizzle_migrations", () => {
    const db = makeDb();
    const file = join(tmpRoot, `case-${fileSeq}.db`);

    migrateDatabase(db);

    // Hanya tabel fondasi + internal drizzle — tanpa tabel epik lain.
    expect(tableNames(file)).toEqual(["__drizzle_migrations", "auth_sessions", "users"]);

    const raw = new Database(file);
    try {
      const applied = raw
        .prepare("SELECT count(*) AS n FROM __drizzle_migrations")
        .get() as { n: number };
      expect(applied.n).toBeGreaterThan(0);
    } finally {
      raw.close();
    }
  });

  it("migrasi idempoten: dipanggil ulang pada DB yang sama tanpa error dan tanpa duplikat", () => {
    const db = makeDb();
    const file = join(tmpRoot, `case-${fileSeq}.db`);
    migrateDatabase(db);

    expect(() => migrateDatabase(db)).not.toThrow();

    const raw = new Database(file);
    try {
      const applied = raw
        .prepare("SELECT count(*) AS n FROM __drizzle_migrations")
        .get() as { n: number };
      expect(applied.n).toBe(1);
    } finally {
      raw.close();
    }
  });
});

describe("data users dan auth_sessions", () => {
  function seedUser(db: ReturnType<typeof createDatabase>, username = "yui-user"): string {
    const now = Date.now();
    const id = ulid();
    db.insert(users)
      .values({ id, username, passwordHash: "argon2-placeholder", createdAt: now, updatedAt: now })
      .run();
    return id;
  }

  it("roundtrip ULID: user + sesi terhubung terbaca utuh via drizzle typed API", () => {
    const db = makeDb();
    migrateDatabase(db);

    const userId = seedUser(db);
    const sessionId = ulid();
    const createdAt = Date.now();
    const tokenHash = hashToken("raw-cookie-token");

    db.insert(authSessions)
      .values({
        id: sessionId,
        userId,
        tokenHash,
        expiresAt: createdAt + 60_000,
        createdAt,
      })
      .run();

    const userRow: User = db.select().from(users).all()[0]!;
    const sessionRow: AuthSession = db.select().from(authSessions).all()[0]!;

    expect(userRow).toEqual({
      id: userId,
      username: "yui-user",
      passwordHash: "argon2-placeholder",
      createdAt: userRow.createdAt,
      updatedAt: userRow.updatedAt,
    });
    expect(userRow.createdAt).toBeTypeOf("number");
    expect(sessionRow).toEqual({
      id: sessionId,
      userId,
      tokenHash,
      expiresAt: createdAt + 60_000,
      createdAt,
    });
    // ULID terurut-waktu, 26 karakter canonical.
    expect(userId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(sessionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("FK kaskade: DELETE users menghapus baris auth_sessions anak (pragma foreign_keys ON)", () => {
    const db = makeDb();
    migrateDatabase(db);

    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);

    const userId = seedUser(db);
    const createdAt = Date.now();
    db.insert(authSessions)
      .values({
        id: ulid(),
        userId,
        tokenHash: hashToken("token-a"),
        expiresAt: createdAt + 60_000,
        createdAt,
      })
      .run();
    db.insert(authSessions)
      .values({
        id: ulid(),
        userId,
        tokenHash: hashToken("token-b"),
        expiresAt: createdAt + 60_000,
        createdAt,
      })
      .run();
    expect(db.select().from(authSessions).all()).toHaveLength(2);

    db.delete(users).run();

    expect(db.select().from(authSessions).all()).toHaveLength(0);
  });

  it("token unik: dua auth_sessions dengan token_hash sama ditolak (UNIQUE)", () => {
    const db = makeDb();
    migrateDatabase(db);

    const userId = seedUser(db);
    const tokenHash = hashToken("same-token");
    const createdAt = Date.now();

    db.insert(authSessions)
      .values({ id: ulid(), userId, tokenHash, expiresAt: createdAt + 60_000, createdAt })
      .run();

    expect(() =>
      db.insert(authSessions)
        .values({ id: ulid(), userId, tokenHash, expiresAt: createdAt + 60_000, createdAt })
        .run(),
    ).toThrowError(/UNIQUE constraint failed: auth_sessions\.token_hash/);
  });
});

describe("resolveDatabasePath", () => {
  const prevDataDir = process.env.DATA_DIR;
  const prevCwd = process.cwd();

  afterEach(() => {
    if (prevDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = prevDataDir;
    }
    process.chdir(prevCwd);
  });

  it("tanpa env: data/yui.db relatif cwd dan direktorinya dibuat", () => {
    delete process.env.DATA_DIR;
    process.chdir(tmpRoot);

    const path = resolveDatabasePath();

    // Relatif terhadap cwd (default `data`), persis matriks — bukan absolut.
    expect(path).toBe(join("data", "yui.db"));
    expect(existsSync(join(tmpRoot, "data"))).toBe(true);
  });

  it("dengan DATA_DIR: path absolut + mkdir -p rekursif untuk direktori bertingkat", () => {
    const nested = join(tmpRoot, "custom", "nested", "deeper");
    process.env.DATA_DIR = nested;

    const path = resolveDatabasePath();

    expect(path).toBe(join(nested, "yui.db"));
    expect(existsSync(nested)).toBe(true);
  });
});
