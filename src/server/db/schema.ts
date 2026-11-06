import { type InferSelectModel } from "drizzle-orm";
import { blob, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Fondasi Yui (AD-6): hanya `users` dan `auth_sessions`. Tabel epik lain
// (provider_configs, threads, messages, audio_blobs) dimigrasi epik pemiliknya.
//
// Konvensi: ID = ULID TEXT, waktu = epoch-ms INTEGER di DB (ISO-8601 UTC di API).
// `username` dinormalisasi lowercase oleh service auth (story 3) — skema hanya
// menyimpan nilai unik. `token_hash` = SHA-256 hex token cookie; token mentah
// tidak pernah disimpan (AD-9).

// epic-penyedia: `provider_configs` — satu config aktif per (userId, kind)
// (asumsi epik, upsert mengganti). `ciphertext` = kredensial AES-256-GCM
// format `iv:tag:ct` base64-segmen (AD-3); plaintext TIDAK PERNAH disimpan.

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const authSessions = sqliteTable("auth_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const providerConfigs = sqliteTable(
  "provider_configs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Kolom `kind` menyimpan nilai `ProviderKind` dari kontrak shared.
    kind: text("kind").notNull(),
    baseUrl: text("base_url"),
    modelId: text("model_id"),
    ciphertext: blob("ciphertext", { mode: "buffer" }).notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("provider_configs_user_id_kind_unique").on(table.userId, table.kind)],
);

export type User = InferSelectModel<typeof users>;
export type AuthSession = InferSelectModel<typeof authSessions>;
export type ProviderConfig = InferSelectModel<typeof providerConfigs>;
