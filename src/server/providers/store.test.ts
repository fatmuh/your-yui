import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulidx";
import { createDatabase, migrateDatabase, type YuiDatabase } from "../db/index.ts";
import { users } from "../db/schema.ts";
import {
  deleteProviderConfig,
  getProviderConfig,
  getProviderConfigById,
  upsertProviderConfig,
} from "./store.ts";
import { decryptSecret, loadEncryptionKey } from "./crypto.ts";

// R1/AD-3: penyimpanan ciphertext-only, at-rest hanya ciphertext, isolasi
// userId, upsert satu config per (userId, kind).

const KEY_B64 = randomBytes(32).toString("base64");

const tmpRoot = mkdtempSync(join(tmpdir(), "yui-store-test-"));

const openDbs: YuiDatabase[] = [];
let fileSeq = 0;

function makeDb(): { db: YuiDatabase; file: string } {
  const file = join(tmpRoot, `store-${++fileSeq}.db`);
  const db = createDatabase(file);
  migrateDatabase(db);
  openDbs.push(db);
  return { db, file };
}

function seedUser(db: YuiDatabase, username: string): string {
  const id = ulid();
  const now = Date.now();
  db.insert(users).values({ id, username, passwordHash: "x", createdAt: now, updatedAt: now }).run();
  return id;
}

function withKey<T>(fn: () => T): T {
  const prev = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = KEY_B64;
  try {
    return fn();
  } finally {
    if (prev === undefined) {
      delete process.env.APP_ENCRYPTION_KEY;
    } else {
      process.env.APP_ENCRYPTION_KEY = prev;
    }
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

const API_KEY_A = "sk-user-alpha-1111111111111111";
const API_KEY_B = "sk-user-bravo-2222222222222222";

describe("upsertProviderConfig / getProviderConfig", () => {
  it("round-trip: tersimpan dan terbaca kembali; kredensial terdekripsi utuh", () => {
    const { db } = makeDb();
    const userId = seedUser(db, "alpha");

    const stored = withKey(() =>
      upsertProviderConfig(db, {
        userId,
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:9/v1",
        modelId: "mock-model",
        apiKey: API_KEY_A,
      }),
    );

    expect(stored.userId).toBe(userId);
    expect(stored.kind).toBe("openai-compatible");
    expect(stored.baseUrl).toBe("http://127.0.0.1:9/v1");
    expect(stored.modelId).toBe("mock-model");

    const read = getProviderConfig(db, userId, "openai-compatible");
    expect(read).not.toBeNull();
    const plaintext = withKey(() => decryptSecret(loadEncryptionKey(), read!.ciphertext));
    expect(plaintext).toBe(API_KEY_A);
    // getProviderConfigById juga di-scope userId.
    expect(getProviderConfigById(db, userId, stored.id)?.id).toBe(stored.id);
  });

  it("upsert mengganti: (userId, kind) tetap satu baris, kredensial baru", () => {
    const { db } = makeDb();
    const userId = seedUser(db, "beta");

    withKey(() =>
      upsertProviderConfig(db, { userId, kind: "openai-compatible", baseUrl: "http://a/v1", modelId: "m1", apiKey: API_KEY_A }),
    );
    const second = withKey(() =>
      upsertProviderConfig(db, { userId, kind: "openai-compatible", baseUrl: "http://b/v1", modelId: "m2", apiKey: API_KEY_B }),
    );

    const rows = db.select().from(users).all(); // sanity: user tunggal
    expect(rows).toHaveLength(1);
    const read = getProviderConfig(db, userId, "openai-compatible");
    expect(read?.id).toBe(second.id);
    expect(read?.baseUrl).toBe("http://b/v1");
    expect(read?.modelId).toBe("m2");
    expect(withKey(() => decryptSecret(loadEncryptionKey(), read!.ciphertext))).toBe(API_KEY_B);
  });

  it("at-rest (matriks): dump bytes file DB — hanya ciphertext, string kunci asli absen", () => {
    const { db, file } = makeDb();
    const userId = seedUser(db, "gamma");
    withKey(() =>
      upsertProviderConfig(db, { userId, kind: "openai-compatible", baseUrl: "http://c/v1", modelId: "m", apiKey: API_KEY_A }),
    );

    // Dump seluruh bytes yang menyerap state: file DB utama + WAL (journal
    // mode WAL menahan halaman terbaru di sana sampai checkpoint).
    const parts = [readFileSync(file, "latin1")];
    for (const suffix of ["-wal", "-shm"]) {
      try {
        parts.push(readFileSync(`${file}${suffix}`, "latin1"));
      } catch {
        // file sidecar belum ada — biarkan.
      }
    }
    const bytes = parts.join("\n");

    expect(bytes).not.toContain(API_KEY_A);
    expect(bytes).not.toContain("sk-user-alpha");
    // Blob ciphertext utuh (inline) hadir di file sebagai bukti kolom terisi.
    const read = getProviderConfig(db, userId, "openai-compatible");
    expect(read).not.toBeNull();
    const ciphertextText = read!.ciphertext.toString("utf8");
    expect(ciphertextText.split(":")).toHaveLength(3);
    expect(bytes).toContain(ciphertextText.split(":")[2]);
  });

  it("isolasi userId: config A tak terlihat lewat userId B (by kind maupun by id)", () => {
    const { db } = makeDb();
    const userA = seedUser(db, "delta");
    const userB = seedUser(db, "echo");

    const storedA = withKey(() =>
      upsertProviderConfig(db, { userId: userA, kind: "openai-compatible", baseUrl: "http://a/v1", modelId: "m", apiKey: API_KEY_A }),
    );

    expect(getProviderConfig(db, userB, "openai-compatible")).toBeNull();
    expect(getProviderConfigById(db, userB, storedA.id)).toBeNull();
    // B menulis config sendiri: dua baris terpisah tanpa saling menimpa.
    withKey(() =>
      upsertProviderConfig(db, { userId: userB, kind: "openai-compatible", baseUrl: "http://b/v1", modelId: "m", apiKey: API_KEY_B }),
    );
    const readA = getProviderConfig(db, userA, "openai-compatible");
    const readB = getProviderConfig(db, userB, "openai-compatible");
    expect(readA?.id).toBe(storedA.id);
    expect(readB?.id).not.toBe(storedA.id);
    expect(withKey(() => decryptSecret(loadEncryptionKey(), readA!.ciphertext))).toBe(API_KEY_A);
    expect(withKey(() => decryptSecret(loadEncryptionKey(), readB!.ciphertext))).toBe(API_KEY_B);
  });

  it("delete: baris hilang, get null, delete kedua false", () => {
    const { db } = makeDb();
    const userId = seedUser(db, "foxtrot");
    withKey(() =>
      upsertProviderConfig(db, { userId, kind: "openai-compatible", baseUrl: "http://f/v1", modelId: "m", apiKey: API_KEY_A }),
    );

    expect(deleteProviderConfig(db, userId, "openai-compatible")).toBe(true);
    expect(getProviderConfig(db, userId, "openai-compatible")).toBeNull();
    expect(deleteProviderConfig(db, userId, "openai-compatible")).toBe(false);
  });

  it("apiKey kosong ditolak sebelum menulis apa pun", () => {
    const { db } = makeDb();
    const userId = seedUser(db, "golf");
    expect(() =>
      withKey(() =>
        upsertProviderConfig(db, { userId, kind: "openai-compatible", apiKey: "" }),
      ),
    ).toThrowError(/must not be empty/);
    expect(getProviderConfig(db, userId, "openai-compatible")).toBeNull();
  });
});
