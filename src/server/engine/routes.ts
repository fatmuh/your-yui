import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import type { YuiDatabase } from "../db/index.ts";
import { sessionUser } from "../auth/service.ts";
import { SESSION_COOKIE } from "../auth/cookies.ts";
import { getProviderConfig } from "../providers/store.ts";
import { getBotById, resolveBotPersona } from "../bots/store.ts";
import { DEFAULT_BOT_PERSONA } from "../../shared/app.ts";
import {
  appendAssistantMessage,
  appendUserMessage,
  assembleTranscript,
  createThreadWithMessage,
  resolveThread,
} from "../conversations/turn-store.ts";
import { resolveAudioBlob, voiceNotePlaceholder } from "../audio/store.ts";
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

// Revocation poll cadence for an in-flight turn stream (AD-9): a logout is
// detected within this window; the lookup is an indexed token-hash select,
// cheap to repeat while a stream is open.
const REVOKE_POLL_MS = 500;

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

    // epic-voice (story 2): a turn carries EITHER `content` (text) XOR
    // `audioId` (a blob this session uploaded). Shape checks stay pra-stream
    // 400s; the blob itself is resolved owner-scoped below, BEFORE any
    // thread/message write.
    const content = body !== null ? body.content : undefined;
    const rawAudioId = body?.audioId;
    if (rawAudioId !== undefined && (typeof rawAudioId !== "string" || rawAudioId.trim().length === 0)) {
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: `Request body "audioId" must be a non-empty string of an uploaded audio blob, or omitted.`,
          },
        },
        400,
      );
    }
    const audioId = typeof rawAudioId === "string" && rawAudioId.trim().length > 0 ? rawAudioId : undefined;

    // Presence of `content` under the XOR rule: a non-empty string counts, and
    // any other defined value still counts — a malformed value must not slip
    // past the either/or rejection below.
    const contentProvided =
      typeof content === "string" ? content.trim().length > 0 : content !== undefined;
    if (audioId !== undefined && contentProvided) {
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: `Request body must provide either "content" or "audioId", not both.`,
          },
        },
        400,
      );
    }

    // The text stored as this turn's user message: the validated content for
    // text turns, or the duration-derived placeholder for voice turns (single
    // source of truth: voiceNotePlaceholder in the audio store). A voice turn
    // also carries the blob id onto the inserted message row.
    let userText: string;
    let userAudioId: string | undefined;
    if (audioId === undefined) {
      if (
        typeof content !== "string" ||
        content.trim().length === 0 ||
        content.length > MAX_CONTENT_CHARS
      ) {
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
      userText = content;
    } else {
      // Owner-scoped attach via the frozen story-1 seam. Foreign and unknown
      // ids share one identical 404 (no existence leak), and the check runs
      // BEFORE any thread/message write so a rejected attach leaves nothing
      // behind. The stored durationMs derives the placeholder text.
      const blob = resolveAudioBlob(db, user.id, audioId);
      if (blob === null) {
        return c.json(
          { error: { code: "not_found", message: "Audio not found." } },
          404,
        );
      }
      userText = voiceNotePlaceholder(blob.durationMs);
      userAudioId = blob.id;
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

    // Multi-bot harness: a turn is bound to a bot. `botId` is REQUIRED when
    // `threadId` is absent (the new thread is created for that bot); when a
    // thread is given, the thread's OWN bot governs the turn and a mismatching
    // `botId` is a 400 (never a silent persona switch). Shape checks stay
    // pre-stream 400s; ownership is resolved below BEFORE any write.
    const rawBotId = body?.botId;
    if (rawBotId !== undefined && (typeof rawBotId !== "string" || rawBotId.length === 0)) {
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: `Request body "botId" must be a non-empty string of one of your bots, or omitted when "threadId" is given.`,
          },
        },
        400,
      );
    }
    if (rawThreadId === undefined && typeof rawBotId !== "string") {
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: `Request body "botId" is required when "threadId" is omitted — a new thread must name the bot it belongs to.`,
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
    // turunan pesan pertamanya dan terikat bot pengirim. Giliran gagal
    // sekalipun, pesan user tetap (jujur secara transkrip).
    const turnStartedAt = Date.now();
    let threadId: string;
    let newThreadTitle: string | undefined;
    let userWriteAt: number;
    // Persona giliran ini (fallback resolved — never empty): the bot a new
    // thread is created for, or the bot the existing thread is bound to.
    let persona: string;
    if (rawThreadId === undefined) {
      // Owner-scoped resolution BEFORE any write: foreign and unknown bot ids
      // share one identical 404 (anti-enumeration), leaving nothing behind.
      const bot = getBotById(db, user.id, rawBotId as string);
      if (bot === null) {
        return c.json(
          { error: { code: "not_found", message: "Bot not found." } },
          404,
        );
      }
      const created = createThreadWithMessage(
        db,
        user.id,
        bot.id,
        userText,
        turnStartedAt,
        userAudioId,
      );
      if (created === null) {
        return c.json(
          { error: { code: "not_found", message: "Bot not found." } },
          404,
        );
      }
      threadId = created.threadId;
      newThreadTitle = created.title;
      userWriteAt = created.updatedAt;
      persona = resolveBotPersona(bot);
    } else {
      const thread = resolveThread(db, user.id, rawThreadId);
      if (thread === null) {
        return c.json(
          { error: { code: "not_found", message: "Thread not found." } },
          404,
        );
      }
      // The thread's own bot governs an existing-thread turn; a body botId
      // that disagrees is rejected instead of silently switching persona.
      if (rawBotId !== undefined && rawBotId !== thread.botId) {
        return c.json(
          {
            error: {
              code: "invalid_request",
              message: `Request body "botId" does not match the bot this thread belongs to; omit it to continue the thread as-is.`,
            },
          },
          400,
        );
      }
      threadId = thread.id;
      // Defensive: threads predating the bots migration carry null bot_id —
      // the default persona keeps such rows chat-able instead of failing hard.
      const bot = thread.botId === null ? null : getBotById(db, user.id, thread.botId);
      persona = bot === null ? DEFAULT_BOT_PERSONA : resolveBotPersona(bot);
      userWriteAt = appendUserMessage(db, user.id, threadId, userText, turnStartedAt, userAudioId).updatedAt;
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

      // AD-9 revocation watch: the session gate above only runs PRE-stream, so
      // a logout during a live turn would otherwise leave this SSE connection
      // open until the engine reply finishes. Poll the session row while the
      // turn streams; once the token no longer resolves to a user, stop
      // forwarding NEW events at once, then close the connection after the
      // already-queued writes drain (detection window ≤ REVOKE_POLL_MS). The
      // engine prompt itself is NOT aborted: the server stays the sole writer
      // (AD-5) and still persists this turn's assistant message on
      // message.final — the full event contract is simply not promised for a
      // revoked stream.
      const stopWatchAndClose = () => {
        writable = false;
        clearInterval(revocationWatch);
        queue = queue.then(() => stream.close()).catch(() => {});
      };
      const revocationWatch = setInterval(() => {
        if (token === undefined) return;
        try {
          if (sessionUser(db, token) !== null) return;
        } catch {
          // The session can no longer be attested (the lookup threw): close
          // conservatively instead of letting the error escape the timer — an
          // uncaught throw inside setInterval would take down the process,
          // a far bigger blast radius than the 500 this route returns when
          // the same lookup throws on the pre-stream gate path.
          stopWatchAndClose();
          return;
        }
        stopWatchAndClose();
      }, REVOKE_POLL_MS);
      // Client disconnected: stop polling for its revocation and drop writes.
      // Without this, a provider that accepts the connection but never
      // settles would keep the interval alive for the process lifetime.
      stream.onAbort(() => {
        clearInterval(revocationWatch);
        writable = false;
      });

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
        await adapter.prompt({ sessionId, content: transcript, persona, clientToken }, onEvent);
      } catch (error) {
        // Defensive: error di luar jaminan adapter tetap berakhir settled
        // (AD-4). Pesan user tetap tersimpan; pesan asisten tidak dibuat.
        const message =
          error instanceof EngineAdapterError
            ? error.message
            : "The turn failed unexpectedly.";
        sink({ type: "error", threadId, code: "turn_failed", message });
        sink({ type: "turn.settled", threadId });
      } finally {
        // Every exit path (natural end, adapter error, revocation) clears the
        // timer — a normal turn never leaks an interval across requests.
        clearInterval(revocationWatch);
      }
      await queue;
    });
  });

  return app;
}
