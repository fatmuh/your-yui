import { and, eq } from "drizzle-orm";
import { ulid } from "ulidx";
import { providerConfigs, type ProviderConfig } from "../db/schema.ts";
import type { YuiDatabase } from "../db/index.ts";
import type { ProviderKind } from "../../shared/engine.ts";
import { encryptSecret, loadEncryptionKey } from "./crypto.ts";

// Penyimpanan config penyedia (R1, AD-3): modul ini menyimpan dan menyajikan
// CIPHERTEXT saja — tidak pernah mengembalikan kredensial plaintext. Dekripsi
// hanya dilakukan adapter saat materialisasi per prompt.

/** Baris config yang aman dilempar antar modul server — ciphertext utuh, tanpa plaintext. */
export type StoredProviderConfig = {
  id: string;
  userId: string;
  kind: string;
  baseUrl: string | null;
  modelId: string | null;
  createdAt: number;
  updatedAt: number;
  /** BLOB `iv:tag:ct` — hanya dikonsumsi adapter (decrypt), tak pernah di-log. */
  ciphertext: Buffer;
};

export type ProviderConfigInput = {
  userId: string;
  kind: ProviderKind;
  baseUrl?: string | null;
  modelId?: string | null;
  /** Kredensial plaintext HANYA hidup di stack pemanggil; dienkripsi sebelum disentuh DB. */
  apiKey: string;
};

function toStored(row: ProviderConfig): StoredProviderConfig {
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind,
    baseUrl: row.baseUrl,
    modelId: row.modelId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ciphertext: row.ciphertext,
  };
}

/**
 * Upsert satu config aktif per (userId, kind) — asumsi epik: beberapa config
 * per jenis pasca-v1. Kredensial dienkripsi AES-256-GCM sebelum menulis;
 * baris lama diganti (ON CONFLICT update) tanpa menyimpan plaintext.
 */
export function upsertProviderConfig(
  db: YuiDatabase,
  input: ProviderConfigInput,
): StoredProviderConfig {
  if (input.apiKey.length === 0) {
    throw new Error("apiKey must not be empty");
  }
  const key = loadEncryptionKey();
  const ciphertext = encryptSecret(key, input.apiKey);
  const now = Date.now();

  const existing = getProviderConfig(db, input.userId, input.kind);
  const values = {
    id: existing?.id ?? ulid(),
    userId: input.userId,
    kind: input.kind,
    baseUrl: input.baseUrl ?? null,
    modelId: input.modelId ?? null,
    ciphertext,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  db.insert(providerConfigs)
    .values(values)
    .onConflictDoUpdate({
      target: [providerConfigs.userId, providerConfigs.kind],
      set: {
        baseUrl: values.baseUrl,
        modelId: values.modelId,
        ciphertext: values.ciphertext,
        updatedAt: values.updatedAt,
      },
    })
    .run();
  return toStored({ ...values } as ProviderConfig);
}

/** Config aktif pengguna untuk satu jenis — scope userId, tanpa plaintext. */
export function getProviderConfig(
  db: YuiDatabase,
  userId: string,
  kind: ProviderKind,
): StoredProviderConfig | null {
  const row = db
    .select()
    .from(providerConfigs)
    .where(and(eq(providerConfigs.userId, userId), eq(providerConfigs.kind, kind)))
    .get();
  return row ? toStored(row) : null;
}

/** Config berdasarkan id — TETAP di-scope userId (AD-9: tak ada aksi lintas pengguna). */
export function getProviderConfigById(
  db: YuiDatabase,
  userId: string,
  configId: string,
): StoredProviderConfig | null {
  const row = db
    .select()
    .from(providerConfigs)
    .where(and(eq(providerConfigs.userId, userId), eq(providerConfigs.id, configId)))
    .get();
  return row ? toStored(row) : null;
}

/** Hapus config (userId, kind); true bila baris terhapus. */
export function deleteProviderConfig(db: YuiDatabase, userId: string, kind: ProviderKind): boolean {
  const result = db
    .delete(providerConfigs)
    .where(and(eq(providerConfigs.userId, userId), eq(providerConfigs.kind, kind)))
    .run();
  return result.changes > 0;
}
