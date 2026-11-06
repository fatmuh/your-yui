import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.ts";

// Tipe hasil drizzle() termasuk `$client` (better-sqlite3 mentah) untuk close()
// dan introspeksi — dipakai test dan story 3.
export type YuiDatabase = BetterSQLite3Database<typeof schema> & {
  $client: import("better-sqlite3").Database;
};

// Folder migrasi default di-resolve relatif ke modul ini — BUKAN cwd proses —
// supaya migrasi tetap ditemukan apa pun direktori kerja peluncur server.
const DEFAULT_MIGRATIONS_FOLDER = resolve(import.meta.dirname, "migrations");

const DEFAULT_DATA_DIR = "data";
const DATABASE_FILENAME = "yui.db";

/**
 * Buka (atau buat) database SQLite dan bungkus dengan drizzle.
 * WAL untuk konkurensi baca; foreign_keys ON agar kaskade AD-6 bekerja.
 * Tanpa singleton — pemanggil (story 3+) yang memegang instansinya.
 */
export function createDatabase(filePath: string): YuiDatabase {
  const sqlite = new Database(filePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

/**
 * Terapkan migrasi SQL ter-commit (folder src/server/db/migrations).
 * Aman dipanggil ulang: migrasi yang sudah masuk __drizzle_migrations di-skip.
 */
export function migrateDatabase(
  db: YuiDatabase,
  folder: string = DEFAULT_MIGRATIONS_FOLDER,
): void {
  migrate(db, { migrationsFolder: folder });
}

/**
 * Path file DB dari env `DATA_DIR` (default `data/`), direktorinya dibuat
 * rekursif bila belum ada. AD-2: satu file SQLite = satu-satunya state.
 */
export function resolveDatabasePath(): string {
  const dataDir = process.env.DATA_DIR || DEFAULT_DATA_DIR;
  mkdirSync(dataDir, { recursive: true });
  return join(dataDir, DATABASE_FILENAME);
}
