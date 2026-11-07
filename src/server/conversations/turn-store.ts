import { and, desc, eq } from "drizzle-orm";
import { monotonicFactory } from "ulidx";
import { messages, threads, type Message, type Thread } from "../db/schema.ts";
import type { YuiDatabase } from "../db/index.ts";

// Penulis giliran (story 3, AD-5, AD-6): route engine memanggil helper
// murni-DB ini — modul conversations TIDAK mengimpor engine (AD-1); alur/
// event tetap dikoordinasikan route. Semua query menscope userId di SQL
// (pola store.ts), dan setiap tulis pesan SELALU men-bump threads.updatedAt
// di jalur yang sama. Id = ULID server sendiri; id event engine (messageId)
// tidak pernah dipakai sebagai id DB.

// Pabrik ULID MONOTONIC satu instans per proses: `ulid()` default acak dalam
// milidetik yang sama, sehingga pasangan pesan user→asisten sama-ms bisa
// terbalik oleh tiebreaker (createdAt, id) story 2. Monotonisitas pabrik
// menjamin id yang dikeluarkan modul ini selalu naik leksikografis —
// jangan menggantinya kembali ke `ulid()`.
const newUlid = monotonicFactory();

/** Judul thread = awal pesan user pertama: whitespace diratakan, ≤80 char. */
const TITLE_MAX_CHARS = 80;
/** Konteks per giliran: 20 pesan terakhir (longgar — 3× anggaran 8k/turn). */
const TRANSCRIPT_MAX_MESSAGES = 20;
const TRANSCRIPT_MAX_CHARS = 24_000;

function deriveTitle(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  // Potong per CODE POINT, bukan unit UTF-16 — slice mentah bisa membelah
  // surrogate pair di perbatasan dan menyimpan lone surrogate ke judul.
  return Array.from(normalized).slice(0, TITLE_MAX_CHARS).join("");
}

/** Bump updatedAt thread (scope userId di SQL — thread asing tak tersentuh). */
function touchThread(db: YuiDatabase, userId: string, threadId: string, at: number): void {
  db.update(threads)
    .set({ updatedAt: at })
    .where(and(eq(threads.id, threadId), eq(threads.userId, userId)))
    .run();
}

/**
 * Thread milik `userId`, atau null bila tak ada ATAU milik orang lain —
 * route memetakan null → 404 tanpa membedakan kedua kasus (konvensi story 2:
 * eksistensi thread orang lain tak boleh bocor).
 */
export function resolveThread(db: YuiDatabase, userId: string, threadId: string): Thread | null {
  return (
    db
      .select()
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.userId, userId)))
      .get() ?? null
  );
}

export type CreatedThread = {
  threadId: string;
  /** Judul turunan pesan pertama — dipancarkan route hanya saat pembuatan. */
  title: string;
  updatedAt: number;
};

/** Thread baru (ULID server, judul turunan) + pesan user pertamanya. */
export function createThreadWithMessage(
  db: YuiDatabase,
  userId: string,
  content: string,
  at: number,
): CreatedThread {
  const threadId = newUlid();
  const title = deriveTitle(content);
  db.insert(threads).values({ id: threadId, userId, title, createdAt: at, updatedAt: at }).run();
  db.insert(messages).values({ id: newUlid(), threadId, role: "user", text: content, createdAt: at }).run();
  return { threadId, title, updatedAt: at };
}

export type AppendedMessage = {
  /**
   * Id DB pesan baru — ULID server BARU (monotonic), bukan messageId event
   * engine: pasangan user→asisten dalam milidetik yang sama tetap urut id
   * asc (tiebreaker story 2).
   */
  messageId: string;
  updatedAt: number;
};

export function appendUserMessage(
  db: YuiDatabase,
  userId: string,
  threadId: string,
  text: string,
  at: number,
): AppendedMessage {
  const messageId = newUlid();
  db.insert(messages).values({ id: messageId, threadId, role: "user", text, createdAt: at }).run();
  touchThread(db, userId, threadId, at);
  return { messageId, updatedAt: at };
}

export function appendAssistantMessage(
  db: YuiDatabase,
  userId: string,
  threadId: string,
  text: string,
  at: number,
): AppendedMessage {
  const messageId = newUlid();
  db.insert(messages).values({ id: messageId, threadId, role: "assistant", text, createdAt: at }).run();
  touchThread(db, userId, threadId, at);
  return { messageId, updatedAt: at };
}

/**
 * Transkrip konteks multi-giliran server-side: baris `user: <teks>` /
 * `assistant: <teks>` dipisah `\n`, dari 20 pesan TERAKHIR thread (urutan
 * identik riwayat: createdAt+id asc). Anggaran 24.000 char — baris dipotong
 * dari KEPALA sampai muat; baris terakhir (pesan user barusan, ≤8k char +
 * prefiks role) selalu utuh. Turunan naive murni-DB, tanpa logika baru di
 * shared (AD-8).
 */
export function assembleTranscript(db: YuiDatabase, userId: string, threadId: string): string {
  const rows = db
    .select({ message: messages })
    .from(threads)
    .leftJoin(messages, eq(messages.threadId, threads.id))
    .where(and(eq(threads.id, threadId), eq(threads.userId, userId)))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(TRANSCRIPT_MAX_MESSAGES)
    .all();
  const lines = rows
    .map((row) => row.message)
    .filter((message): message is Message => message !== null)
    .map((message) => `${message.role}: ${message.text}`)
    .reverse();
  while (lines.length > 1 && lines.join("\n").length > TRANSCRIPT_MAX_CHARS) {
    lines.shift();
  }
  return lines.join("\n");
}
