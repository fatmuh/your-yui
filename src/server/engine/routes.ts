import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import type { YuiDatabase } from "../db/index.ts";
import { sessionUser } from "../auth/service.ts";
import { SESSION_COOKIE } from "../auth/cookies.ts";
import { getProviderConfig } from "../providers/store.ts";
import {
  appendAssistantMessage,
  appendUserMessage,
  assembleTranscript,
  createThreadWithMessage,
  resolveThread,
} from "../conversations/turn-store.ts";
import { createEngineAdapter, EngineAdapterError } from "./adapter.ts";
import { PROVIDER_KINDS, type ProviderKind, type YuiEvent } from "../../shared/engine.ts";

// Route SSE giliran (R4+R3, AD-4, AD-5, AD-9): satu POST = satu giliran penuh,
// dan route adalah PENULIS tunggal threads/messages — pesan user tersimpan
// SEBELUM prompt, pesan asisten dipersist saat `message.final` (id DB = ULID
// server sendiri, BUKAN messageId event; perbedaan id stream vs riwayat
// disengaja — klien tak mencocokkan keduanya, dedup = clientToken). Transkrip
// thread dirakit server-side jadi konten prompt, sehingga adapter yang
// stateless per giliran tetap membawa konteks multi-giliran. Envelope error
// konvensi spine {error:{code,message}} untuk kegagalan pra-stream (auth,
// validasi body, thread asing/tak-ada); kegagalan giliran mengalir sebagai
// event `error` + `turn.settled` — pesan user TETAP tersimpan (giliran
// sungguh terjadi), tanpa pesan asisten setengah jadi.

const MAX_CONTENT_CHARS = 8_000;

// Validasi kind memakai PROVIDER_KINDS dari kontrak shared — satu sumber
// kebenaran runtime (pola `Record<ProviderKind, true>` menjaga kelengkapan
// union di kompilator; lihat src/shared/engine.ts).
const DEFAULT_PROVIDER_KIND: ProviderKind = "openai-compatible";

export function engineRoutes(db: YuiDatabase): Hono {
  const app = new Hono();
  const adapter = createEngineAdapter(db);

  app.post("/engine/turn", async (c) => {
    // AD-9: gerbang sesi — tanpa cookie valid, 401 envelope; engine tak tersentuh.
    const token = getCookie(c, SESSION_COOKIE);
    const user = token !== undefined ? sessionUser(db, token) : null;
    if (user === null) {
      return c.json(
        { error: { code: "unauthorized", message: "A valid session is required." } },
        401,
      );
    }

    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await c.req.json();
      if (typeof parsed === "object" && parsed !== null) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = null;
    }

    const content = body !== null ? body.content : undefined;
    if (typeof content !== "string" || content.trim().length === 0 || content.length > MAX_CONTENT_CHARS) {
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: `Request body must be JSON with a non-empty "content" string of at most ${MAX_CONTENT_CHARS} characters.`,
          },
        },
        400,
      );
    }

    // Semantik threadId (AD-5): absent → thread baru dibuat server; string →
    // WAJIB thread milik sesi (404 identik asing/tak-ada, konvensi story 2).
    // Id ephemeral arbitrary hilang — hanya ULID thread milik pengguna.
    const rawThreadId = body?.threadId;
    if (rawThreadId !== undefined && (typeof rawThreadId !== "string" || rawThreadId.length === 0)) {
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: `Request body "threadId" must be a non-empty string of an existing thread, or omitted to start a new one.`,
          },
        },
        400,
      );
    }

    // kind opsional (default openai-compatible) — nilai di luar union ditolak
    // pra-stream dengan envelope konvensi.
    const rawKind = body?.kind;
    let kind: ProviderKind = DEFAULT_PROVIDER_KIND;
    if (rawKind !== undefined) {
      if (typeof rawKind !== "string" || !PROVIDER_KINDS.includes(rawKind as ProviderKind)) {
        return c.json(
          {
            error: {
              code: "invalid_request",
              message: `Request body "kind" must be one of: ${PROVIDER_KINDS.join(", ")}.`,
            },
          },
          400,
        );
      }
      kind = rawKind as ProviderKind;
    }

    // clientToken opsional — dibalik di message.final untuk dedup pesan
    // optimistik klien (AD-4); bentuk di luar batas diabaikan diam-diam.
    const rawClientToken = body?.clientToken;
    const clientToken =
      typeof rawClientToken === "string" && rawClientToken.length > 0 && rawClientToken.length <= 128
        ? rawClientToken
        : undefined;

    // Tulis giliran (AD-5) — SETELAH seluruh validasi pra-stream: (1) pesan
    // user masuk DB lebih dulu; thread baru (ULID server) membawa judul
    // turunan pesan pertamanya. Giliran gagal sekalipun, pesan user tetap
    // (jujur secara transkrip).
    const turnStartedAt = Date.now();
    let threadId: string;
    let newThreadTitle: string | undefined;
    let userWriteAt: number;
    if (rawThreadId === undefined) {
      const created = createThreadWithMessage(db, user.id, content, turnStartedAt);
      threadId = created.threadId;
      newThreadTitle = created.title;
      userWriteAt = created.updatedAt;
    } else {
      const thread = resolveThread(db, user.id, rawThreadId);
      if (thread === null) {
        return c.json(
          { error: { code: "not_found", message: "Thread not found." } },
          404,
        );
      }
      threadId = thread.id;
      userWriteAt = appendUserMessage(db, user.id, threadId, content, turnStartedAt).updatedAt;
    }

    // (3) transkrip thread (termasuk pesan user barusan) = konten prompt
    // giliran ini — konteks multi-giliran dirakit server-side.
    const transcript = assembleTranscript(db, user.id, threadId);

    const config = getProviderConfig(db, user.id, kind);
    const { sessionId } = await adapter.createSession({
      userId: user.id,
      threadId,
      providerConfigId: config?.id ?? null,
    });

    return streamSSE(c, async (stream) => {
      // Penulisan SSE diserialkan (satu antrean promise) agar event tak
      // saling mengalahkan; kegagalan tulus (klien putus) berhenti diam —
      // persist TIDAK ikut batal (penulis = server, AD-5).
      let queue: Promise<void> = Promise.resolve();
      let writable = true;
      const sink = (event: YuiEvent) => {
        const { type, ...payload } = event;
        if (!writable) return;
        queue = queue
          .then(() => stream.writeSSE({ event: type, data: JSON.stringify(payload) }))
          .catch(() => {
            writable = false;
          });
      };

      // (2) kabar tulis user — event pertama stream; `title` hanya dibawa
      // saat thread baru (rename = fitur client pasca-v1, bukan story ini).
      sink(
        newThreadTitle === undefined
          ? { type: "thread.updated", threadId, updated_at: new Date(userWriteAt).toISOString() }
          : {
              type: "thread.updated",
              threadId,
              title: newThreadTitle,
              updated_at: new Date(userWriteAt).toISOString(),
            },
      );

      // (4) final → persist dulu (otoritas), baru forward final +
      // thread.updated ke sink. Tulisan better-sqlite3 sinkron di jalur ini,
      // jadi kedua event pasti ter-antre SEBELUM `turn.settled` yang dipancar
      // adapter setelah final, dan persist terjamin selesai sebelum callback
      // stream kembali (antrean di-await di bawah).
      const onEvent = (event: YuiEvent): void => {
        if (event.type === "message.final") {
          const { updatedAt } = appendAssistantMessage(db, user.id, threadId, event.text, Date.now());
          sink(event);
          sink({ type: "thread.updated", threadId, updated_at: new Date(updatedAt).toISOString() });
          return;
        }
        sink(event);
      };

      try {
        await adapter.prompt({ sessionId, content: transcript, clientToken }, onEvent);
      } catch (error) {
        // Defensive: error di luar jaminan adapter tetap berakhir settled
        // (AD-4). Pesan user tetap tersimpan; pesan asisten tidak dibuat.
        const message =
          error instanceof EngineAdapterError
            ? error.message
            : "The turn failed unexpectedly.";
        sink({ type: "error", threadId, code: "turn_failed", message });
        sink({ type: "turn.settled", threadId });
      }
      await queue;
    });
  });

  return app;
}
