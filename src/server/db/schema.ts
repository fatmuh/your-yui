import { type InferSelectModel, sql } from "drizzle-orm";
import { blob, check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    // Mask satu arah `sk-…abcd` (maskSecret) — dihitung SEKALI saat upsert,
    // saat route masih memegang plaintext, lalu disimpan sebagai non-rahasia.
    // View bermask dibaca dari sini; decrypt demi mask dilarang (AD-3).
    maskedHint: text("masked_hint").notNull().default(""),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("provider_configs_user_id_kind_unique").on(table.userId, table.kind)],
);

// epic-percakapan (R2, AD-5, AD-6): `threads` + `messages` — riwayat percakapan
// per pengguna. Server adalah penulis tunggal (route giliran, story 3); cerita
// ini hanya membaca. `threads.title` DEFAULT '' — kolom disiapkan untuk daftar;
// pengisian judul sungguhan (turunan pesan user pertama) = keputusan story 3.

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default(""),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("threads_user_id_updated_at_index").on(table.userId, table.updatedAt)],
);

// `role` menyimpan nilai `MessageRole` kontrak shared — selaras tipe Message
// template client ('user' | 'assistant'); tanpa kolom spekulatif di luar R2
// (token/kind/audio menyusul story 3+ bila dibutuhkan). Nilai dijaga CHECK
// constraint di DB — kolom TEXT mentah tanpa check akan menerima apa pun dan
// lolos ke wire lewat cast di route.

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    text: text("text").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("messages_thread_id_created_at_index").on(table.threadId, table.createdAt),
    check("messages_role_check", sql`${table.role} IN ('user', 'assistant')`),
  ],
);

export type User = InferSelectModel<typeof users>;
export type AuthSession = InferSelectModel<typeof authSessions>;
export type ProviderConfig = InferSelectModel<typeof providerConfigs>;
export type Thread = InferSelectModel<typeof threads>;
export type Message = InferSelectModel<typeof messages>;
