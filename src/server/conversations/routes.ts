import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { YuiDatabase } from "../db/index.ts";
import type { SessionUser } from "../auth/service.ts";
import { sessionUser } from "../auth/service.ts";
import { SESSION_COOKIE } from "../auth/cookies.ts";
import type { MessageDto, MessageRole, ThreadDto } from "../../shared/app.ts";
import { listMessages, listThreads } from "./store.ts";
import { getAudioById } from "../audio/store.ts";
import type { Message, Thread } from "../db/schema.ts";

// REST baca riwayat percakapan (R2, AD-9): GET /api/threads (daftar milik
// sesi, updatedAt desc) + GET /api/threads/:id/messages (riwayat, createdAt
// asc). READ-ONLY — tanpa route tulis; penulisan datang bersama route giliran
// (story 3). Envelope error konvensi spine {error:{code,message}}: 401 tanpa
// sesi valid; 404 untuk thread tak ada ATAU milik orang lain — respons kedua
// kasus identik agar eksistensi thread orang lain tak bocor (403 = leak).

type ErrorCode = "unauthorized" | "not_found";

function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
) {
  return c.json({ error: { code, message } }, status);
}

/** DB epoch-ms → ISO-8601 UTC di API (konversi di tepi route, konvensi spine). */
function toThreadDto(row: Thread): ThreadDto {
  return {
    id: row.id,
    botId: row.botId,
    title: row.title,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

/**
 * Message row → DTO (AD-8 edge conversion). epic-voice: when the row carries
 * an attached blob, it is read back owner-scoped (the thread owner IS the
 * blob owner — the turn route only attaches blobs the session uploaded). A
 * blob that no longer resolves omits `audio` and keeps the stored placeholder
 * text — defensive: the GC sweep never deletes a referenced blob, but history
 * must not break if one ever goes missing.
 */
function toMessageDto(db: YuiDatabase, userId: string, row: Message): MessageDto {
  const blob = row.audioId === null ? null : getAudioById(db, userId, row.audioId);
  return {
    id: row.id,
    role: row.role as MessageRole,
    text: row.text,
    ...(blob === null
      ? {}
      : { audio: { id: blob.id, mime: blob.mime, durationMs: blob.durationMs } }),
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

/**
 * Sub-app percakapan — di-mount `app.route("/api", ...)` sehingga endpoint
 * menjadi /api/threads dan /api/threads/:id/messages. Semua handler di balik
 * gerbang sesi (AD-9) dan di-scope userId di SQL (lihat store).
 */
export function conversationRoutes(db: YuiDatabase): Hono {
  const app = new Hono();

  // AD-9: gerbang sesi — tanpa cookie valid, 401 envelope; penyimpanan tak tersentuh.
  function currentUser(c: Context): SessionUser | null {
    const token = getCookie(c, SESSION_COOKIE);
    return token !== undefined ? sessionUser(db, token) : null;
  }

  app.get("/threads", (c) => {
    const user = currentUser(c);
    if (user === null) {
      return errorResponse(c, 401, "unauthorized", "A valid session is required.");
    }
    // User tanpa thread mendapat [] — bukan 404 (matriks "Kosong").
    return c.json(listThreads(db, user.id).map(toThreadDto), 200);
  });

  app.get("/threads/:id/messages", (c) => {
    const user = currentUser(c);
    if (user === null) {
      return errorResponse(c, 401, "unauthorized", "A valid session is required.");
    }
    const rows = listMessages(db, user.id, c.req.param("id"));
    if (rows === null) {
      return errorResponse(c, 404, "not_found", "Thread not found.");
    }
    return c.json(rows.map((row) => toMessageDto(db, user.id, row)), 200);
  });

  return app;
}
