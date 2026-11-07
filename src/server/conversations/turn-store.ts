import { and, desc, eq, max } from "drizzle-orm";
import { monotonicFactory } from "ulidx";
import { messages, threads, type Message, type Thread } from "../db/schema.ts";
import type { YuiDatabase } from "../db/index.ts";
import { getBotById } from "../bots/store.ts";

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

/**
 * Previous tick of the thread's logical clock: the newest message createdAt,
 * falling back to the thread's current updatedAt when the thread has no
 * messages yet. Null only for a thread that exists nowhere yet (brand-new
 * thread) — there is nothing to regress against.
 */
function previousThreadTime(db: YuiDatabase, userId: string, threadId: string): number | null {
  // The messages table carries no userId column — ownership is enforced by
  // joining threads, keeping the module rule that every query scopes userId
  // in SQL (a foreign threadId reads nothing here, like everywhere else).
  const newestMessage = db
    .select({ prevAt: max(messages.createdAt) })
    .from(messages)
    .innerJoin(threads, eq(messages.threadId, threads.id))
    .where(and(eq(messages.threadId, threadId), eq(threads.userId, userId)))
    .get();
  if (newestMessage !== undefined && newestMessage.prevAt !== null) {
    return newestMessage.prevAt;
  }
  return resolveThread(db, userId, threadId)?.updatedAt ?? null;
}

/**
 * Per-thread logical clock (deferred review 3.3): createdAt/updatedAt carry
 * epoch-ms straight from the caller's wall clock, so a regression (NTP step
 * back) could misorder history and drop a just-written user message out of
 * the last-20 transcript window. Every write instead uses
 * max(inputAt, prevAt + 1) with prevAt = newest message createdAt of THIS
 * thread (thread.updatedAt fallback for an empty thread), so the clock is
 * strictly monotonic per thread no matter what the caller passes. Callers
 * keep passing `at` — the defense lives here (depth behind the single
 * writer, AD-5). The monotonic ULID factory stays the id tiebreaker; both
 * orderings now point the same way.
 */
function monotonicThreadTime(
  db: YuiDatabase,
  userId: string,
  threadId: string,
  inputAt: number,
): number {
  const prevAt = previousThreadTime(db, userId, threadId);
  return prevAt === null ? inputAt : Math.max(inputAt, prevAt + 1);
}

/**
 * Bump updatedAt thread (scope userId di SQL — thread asing tak tersentuh).
 * Non-regressing at the row level too: the bump never writes an updatedAt
 * older than the one already stored. Returns the value actually applied.
 */
function touchThread(db: YuiDatabase, userId: string, threadId: string, at: number): number {
  const current = resolveThread(db, userId, threadId)?.updatedAt;
  const writeAt = current === undefined ? at : Math.max(at, current);
  db.update(threads)
    .set({ updatedAt: writeAt })
    .where(and(eq(threads.id, threadId), eq(threads.userId, userId)))
    .run();
  return writeAt;
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

/**
 * New thread (server ULID, derived title) plus its first user message, bound
 * to bot `botId` owned by `userId`. Null when the bot is missing OR someone
 * else's — the route maps null → an identical 404 (anti-enumeration) WITHOUT
 * writing anything (multi-bot harness: a thread is born bound to its bot;
 * the binding never changes).
 */
export function createThreadWithMessage(
  db: YuiDatabase,
  userId: string,
  botId: string,
  content: string,
  at: number,
  audioId?: string,
  imageIds?: string[],
): CreatedThread | null {
  if (getBotById(db, userId, botId) === null) {
    return null;
  }
  const threadId = newUlid();
  const title = deriveTitle(content);
  // Brand-new thread: nothing exists yet, so the clock has nothing to
  // regress against — but the thread row and its first message still share
  // one value straight from the same monotonic helper.
  const writeAt = monotonicThreadTime(db, userId, threadId, at);
  db.insert(threads)
    .values({ id: threadId, userId, botId, title, createdAt: writeAt, updatedAt: writeAt })
    .run();
  db.insert(messages)
    .values({
      id: newUlid(),
      threadId,
      role: "user",
      text: content,
      createdAt: writeAt,
      // epic-voice: voice turns store the placeholder text AND the blob ref.
      ...(audioId === undefined ? {} : { audioId }),
      // bot-tool-calling: image turns store the placeholder/content text AND
      // the blob id refs as a JSON array (audio XOR images by route validation).
      ...(imageIds === undefined || imageIds.length === 0 ? {} : { imageIds: JSON.stringify(imageIds) }),
    })
    .run();
  return { threadId, title, updatedAt: writeAt };
}

export type AppendedMessage = {
  /**
   * Id DB pesan baru — ULID server BARU (monotonic), bukan messageId event
   * engine: pasangan user→asisten dalam milidetik yang sama tetap urut id
   * asc (tiebreaker story 2).
   */
  messageId: string;
  /** Thread bump tick actually applied (per-thread logical clock — monotonic). */
  updatedAt: number;
};

export function appendUserMessage(
  db: YuiDatabase,
  userId: string,
  threadId: string,
  text: string,
  at: number,
  audioId?: string,
  imageIds?: string[],
): AppendedMessage {
  const messageId = newUlid();
  const writeAt = monotonicThreadTime(db, userId, threadId, at);
  db.insert(messages)
    .values({
      id: messageId,
      threadId,
      role: "user",
      text,
      createdAt: writeAt,
      // epic-voice: voice turns store the placeholder text AND the blob ref.
      ...(audioId === undefined ? {} : { audioId }),
      // bot-tool-calling: image turns store the blob id refs as a JSON array.
      ...(imageIds === undefined || imageIds.length === 0 ? {} : { imageIds: JSON.stringify(imageIds) }),
    })
    .run();
  const updatedAt = touchThread(db, userId, threadId, writeAt);
  return { messageId, updatedAt };
}

export function appendAssistantMessage(
  db: YuiDatabase,
  userId: string,
  threadId: string,
  text: string,
  at: number,
): AppendedMessage {
  const messageId = newUlid();
  const writeAt = monotonicThreadTime(db, userId, threadId, at);
  db.insert(messages).values({ id: messageId, threadId, role: "assistant", text, createdAt: writeAt }).run();
  const updatedAt = touchThread(db, userId, threadId, writeAt);
  return { messageId, updatedAt };
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
