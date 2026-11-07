import { and, asc, desc, eq } from "drizzle-orm";
import { messages, threads, type Message, type Thread } from "../db/schema.ts";
import type { YuiDatabase } from "../db/index.ts";

// Store baca percakapan (R2, AD-5, AD-6, AD-9): thread dan pesan milik
// pengguna — isolasi di-enforce di SQL (filter userId di query yang sama),
// bukan post-hoc di JS. Cerita ini READ-ONLY; penulisan datang bersama route
// giliran (story 3) — server penulis tunggal (AD-5).

/**
 * Daftar thread milik `userId`, terbaru dulu (updatedAt desc) — bentuk daftar
 * sisi klien. Tiebreaker `id` desc: ULID terurut leksikografis per waktu,
 * sehingga updatedAt sama (jarak < 1 ms antar baris) tetap deterministik —
 * bukan kebetulan arah scan index. Baris mentah; konversi epoch-ms →
 * ISO-8601 terjadi di tepi route.
 */
export function listThreads(db: YuiDatabase, userId: string): Thread[] {
  return db
    .select()
    .from(threads)
    .where(eq(threads.userId, userId))
    .orderBy(desc(threads.updatedAt), desc(threads.id))
    .all();
}

/**
 * Riwayat pesan satu thread (createdAt asc), atau null bila thread tak ada
 * ATAU bukan milik `userId` — route memetakan null → 404 tanpa membedakan
 * kedua kasus (eksistensi thread orang lain tak boleh bocor).
 *
 * Tiebreaker `id` asc: writer story 3 memakai satu Date.now() untuk pesan
 * user+assistant satu giliran — tanpa tiebreaker, balasan bisa terrender
 * di atas pertanyaannya. ULID terurut leksikografis per waktu, jadi id asc
 * = urutan buat dalam milidetik yang sama.
 *
 * Scan dimulai dari `threads` yang sudah di-filter userId lalu LEFT JOIN
 * pesan, sehingga kepemilikan dan pembacaan dijaga DALAM query yang sama;
 * thread sah tanpa pesan menghasilkan array kosong (bukan null).
 */
export function listMessages(db: YuiDatabase, userId: string, threadId: string): Message[] | null {
  const rows = db
    .select({ message: messages })
    .from(threads)
    .leftJoin(messages, eq(messages.threadId, threads.id))
    .where(and(eq(threads.id, threadId), eq(threads.userId, userId)))
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .all();
  if (rows.length === 0) return null;
  return rows
    .map((row) => row.message)
    .filter((message): message is Message => message !== null);
}
