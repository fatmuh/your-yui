import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { YuiDatabase } from "../db/index.ts";
import type { SessionUser } from "../auth/service.ts";
import { sessionUser } from "../auth/service.ts";
import { SESSION_COOKIE } from "../auth/cookies.ts";
import { getAudioById, insertAudioBlob } from "./store.ts";

// Audio upload + playback API (epic-voice, AD-6, AD-9): POST /audio stores one
// voice-note blob owned by the session user; GET /audio/:id plays it back.
// Ownership is scoped DIRECTLY by blob owner (AD-6) — never via a thread join.
// Convention `{error:{code,message}}` envelopes: 401 without a valid session;
// 404 for a missing OR foreign id with an IDENTICAL body (a 403 would leak
// existence); 400 for malformed fields; 413 for anything over the cap.

/**
 * Hard cap from AD-6: 5 MB per blob, the EXACT limit the stored file must
 * satisfy. Enforced in three layers (see the POST handler): a coarse
 * Content-Length gate, a bounded stream read, and the exact file-size check.
 */
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
/**
 * Multipart framing (boundaries, part headers) adds a few hundred bytes on top
 * of the file itself, so the transport-level gates allow a fixed allowance —
 * an honest upload of a file at exactly the cap still passes them, and the
 * exact per-blob cap is decided by the file's own size.
 */
const MULTIPART_FRAMING_ALLOWANCE = 64 * 1024;
/** Ceiling for the request body as a whole (cap + framing allowance). */
const MAX_REQUEST_BYTES = MAX_AUDIO_BYTES + MULTIPART_FRAMING_ALLOWANCE;
/**
 * Loose upper bound for durationMs (0..1 hour). Anti-garbage validation, not a
 * product limit — anything within the range is stored as-is.
 */
const MAX_DURATION_MS = 3_600_000;

type ErrorCode = "unauthorized" | "invalid_request" | "payload_too_large" | "not_found";

function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
) {
  return c.json({ error: { code, message } }, status);
}

/**
 * Sub-app audio — mounted `app.route("/api", ...)` so the endpoints become
 * /api/audio and /api/audio/:id. Both handlers sit behind the session gate
 * (AD-9); playback URLs are never public.
 */
/**
 * Reads the raw request body up to `limit` bytes. Returns null when the body
 * exceeds the limit — a chunked request carries no Content-Length, so without
 * this the parser would buffer the whole stream before rejecting it.
 */
async function readBodyBounded(raw: Request, limit: number): Promise<Uint8Array | null> {
  const reader = raw.body?.getReader();
  if (reader === undefined) {
    return new Uint8Array(0);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function audioRoutes(db: YuiDatabase): Hono {
  const app = new Hono();

  // AD-9: session gate — without a valid cookie, 401 envelope; storage untouched.
  function currentUser(c: Context): SessionUser | null {
    const token = getCookie(c, SESSION_COOKIE);
    return token !== undefined ? sessionUser(db, token) : null;
  }

  app.post("/audio", async (c) => {
    const user = currentUser(c);
    if (user === null) {
      return errorResponse(c, 401, "unauthorized", "A valid session is required.");
    }

    // Cap layer 1 (header gate): a DECLARED Content-Length above the cap plus
    // framing allowance is rejected before any body is read. A missing or
    // unparseable header is NaN and falls through to the bounded read below.
    const contentLength = Number(c.req.header("content-length"));
    if (contentLength > MAX_REQUEST_BYTES) {
      return errorResponse(c, 413, "payload_too_large", "Audio upload exceeds the 5 MB limit.");
    }

    // Cap layer 2 (bounded read): the header above is client-controlled and a
    // chunked upload omits it entirely, so the body itself is read with a hard
    // byte ceiling — an oversized stream is cut off, never buffered whole.
    const bodyBytes = await readBodyBounded(c.req.raw, MAX_REQUEST_BYTES);
    if (bodyBytes === null) {
      return errorResponse(c, 413, "payload_too_large", "Audio upload exceeds the 5 MB limit.");
    }

    let form: FormData;
    try {
      form = await new Request("http://yui.local/upload", {
        method: "POST",
        headers: { "content-type": c.req.header("content-type") ?? "" },
        body: bodyBytes,
      }).formData();
    } catch {
      return errorResponse(c, 400, "invalid_request", "Request body must be multipart/form-data.");
    }

    const file = form.get("file");
    if (!(file instanceof File) || !file.type.startsWith("audio/")) {
      return errorResponse(c, 400, "invalid_request", "Field 'file' must be an audio file.");
    }

    // Cap layer 3 (exact): the stored blob's own size decides — the framing
    // allowance in the transport gates must never let an oversized FILE
    // through, and a lying or absent Content-Length cannot smuggle one past.
    if (file.size > MAX_AUDIO_BYTES) {
      return errorResponse(c, 413, "payload_too_large", "Audio upload exceeds the 5 MB limit.");
    }

    // Digits-only keeps "", "-1", "abc" and "1.5" out; the range check bounds
    // the value. Digits alone cannot be negative or fractional.
    const durationRaw = form.get("durationMs");
    if (
      typeof durationRaw !== "string" ||
      !/^\d+$/.test(durationRaw) ||
      Number(durationRaw) > MAX_DURATION_MS
    ) {
      return errorResponse(
        c,
        400,
        "invalid_request",
        "Field 'durationMs' must be an integer between 0 and 3600000.",
      );
    }

    const stored = await insertAudioBlob(db, user.id, {
      // Stored verbatim from the upload (e.g. "audio/webm;codecs=opus") — only
      // the recording browser knows the codec (AD-6).
      mime: file.type,
      durationMs: Number(durationRaw),
      blob: Buffer.from(await file.arrayBuffer()),
    });
    return c.json({ id: stored.id, mime: stored.mime, durationMs: stored.durationMs }, 201);
  });

  app.get("/audio/:id", (c) => {
    const user = currentUser(c);
    if (user === null) {
      return errorResponse(c, 401, "unauthorized", "A valid session is required.");
    }
    const row = getAudioById(db, user.id, c.req.param("id"));
    if (row === null) {
      return errorResponse(c, 404, "not_found", "Audio not found.");
    }
    // Full bytes in one response: Content-Type is the stored mime written back
    // as-is and Content-Length is the real byte count. No Range support in v1
    // (epic decision 2026-11-07).
    return c.body(new Uint8Array(row.blob), 200, {
      "content-type": row.mime,
      "content-length": String(row.blob.byteLength),
    });
  });

  return app;
}
