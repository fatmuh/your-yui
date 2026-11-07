import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { YuiDatabase } from "../db/index.ts";
import type { SessionUser } from "../auth/service.ts";
import { sessionUser } from "../auth/service.ts";
import { SESSION_COOKIE } from "../auth/cookies.ts";
import { getImageById, insertImageBlob } from "./store.ts";

// Image upload + preview API (bot-tool-calling epic, AD-6, AD-9) — a mirror
// of the audio routes: POST /images stores one image blob owned by the
// session user; GET /images/:id serves it back owner-scoped (never via a
// thread join). Convention envelopes: 401 without a valid session; 404 for a
// missing OR foreign id with an IDENTICAL body; 400 for malformed fields;
// 413 for anything over the cap.

/**
 * Hard cap (plan Always): 5 MB per blob. Enforced in three layers like the
 * audio route — a coarse Content-Length gate, a bounded stream read, and the
 * exact file-size check.
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Multipart framing allowance for the transport-level gates (same value as audio). */
const MULTIPART_FRAMING_ALLOWANCE = 64 * 1024;
/** Ceiling for the request body as a whole (cap + framing allowance). */
const MAX_REQUEST_BYTES = MAX_IMAGE_BYTES + MULTIPART_FRAMING_ALLOWANCE;

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
 * Reads the raw request body up to `limit` bytes; null when the body exceeds
 * the limit (a chunked request carries no Content-Length, so the parser would
 * otherwise buffer the whole stream before rejecting it). Byte-identical to
 * the audio route's helper.
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

/**
 * Sub-app images — mounted `app.route("/api", ...)` so the endpoints become
 * /api/images and /api/images/:id. Both handlers sit behind the session gate
 * (AD-9); preview URLs are never public.
 */
export function imageRoutes(db: YuiDatabase): Hono {
  const app = new Hono();

  function currentUser(c: Context): SessionUser | null {
    const token = getCookie(c, SESSION_COOKIE);
    return token !== undefined ? sessionUser(db, token) : null;
  }

  app.post("/images", async (c) => {
    const user = currentUser(c);
    if (user === null) {
      return errorResponse(c, 401, "unauthorized", "A valid session is required.");
    }

    // Cap layer 1 (header gate): a DECLARED Content-Length above cap plus
    // framing allowance is rejected before any body is read.
    const contentLength = Number(c.req.header("content-length"));
    if (contentLength > MAX_REQUEST_BYTES) {
      return errorResponse(c, 413, "payload_too_large", "Image upload exceeds the 5 MB limit.");
    }

    // Cap layer 2 (bounded read): the header is client-controlled and a
    // chunked upload omits it entirely — the body itself has a hard ceiling.
    const bodyBytes = await readBodyBounded(c.req.raw, MAX_REQUEST_BYTES);
    if (bodyBytes === null) {
      return errorResponse(c, 413, "payload_too_large", "Image upload exceeds the 5 MB limit.");
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
    if (!(file instanceof File) || !file.type.startsWith("image/")) {
      return errorResponse(c, 400, "invalid_request", "Field 'file' must be an image file.");
    }
    // SVG is an XML document that executes script: served back same-origin
    // from the preview URL (session cookie present), a stored SVG would run
    // in the app's origin — refuse it outright rather than sanitize.
    if (file.type === "image/svg+xml") {
      return errorResponse(c, 400, "invalid_request", "SVG images are not supported.");
    }
    // Zero bytes is not an image (an empty upload would otherwise store an
    // unreadable blob that still counts against the owner's data).
    if (file.size === 0) {
      return errorResponse(c, 400, "invalid_request", "Field 'file' must be a non-empty image file.");
    }

    // Cap layer 3 (exact): the stored blob's own size decides.
    if (file.size > MAX_IMAGE_BYTES) {
      return errorResponse(c, 413, "payload_too_large", "Image upload exceeds the 5 MB limit.");
    }

    const stored = await insertImageBlob(db, user.id, {
      mime: file.type,
      blob: Buffer.from(await file.arrayBuffer()),
    });
    return c.json({ id: stored.id, mime: stored.mime }, 201);
  });

  app.get("/images/:id", (c) => {
    const user = currentUser(c);
    if (user === null) {
      return errorResponse(c, 401, "unauthorized", "A valid session is required.");
    }
    const row = getImageById(db, user.id, c.req.param("id"));
    if (row === null) {
      return errorResponse(c, 404, "not_found", "Image not found.");
    }
    // Full bytes in one response; the stored mime is written back as-is.
    // `nosniff` keeps the browser from re-sniffing the bytes into an executable
    // type. No Range support in v1 (same epic decision as audio playback).
    return c.body(new Uint8Array(row.blob), 200, {
      "content-type": row.mime,
      "content-length": String(row.blob.byteLength),
      "x-content-type-options": "nosniff",
    });
  });

  return app;
}
