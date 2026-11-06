import { type InferSelectModel } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Fondasi Yui (AD-6): hanya `users` dan `auth_sessions`. Tabel epik lain
// (provider_configs, threads, messages, audio_blobs) dimigrasi epik pemiliknya.
//
// Konvensi: ID = ULID TEXT, waktu = epoch-ms INTEGER di DB (ISO-8601 UTC di API).
// `username` dinormalisasi lowercase oleh service auth (story 3) — skema hanya
// menyimpan nilai unik. `token_hash` = SHA-256 hex token cookie; token mentah
// tidak pernah disimpan (AD-9).

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

export type User = InferSelectModel<typeof users>;
export type AuthSession = InferSelectModel<typeof authSessions>;
