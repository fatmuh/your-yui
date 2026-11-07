// Wrapper API auth sisi client (story 4). AD-8: client hanya mengimpor
// src/shared/ dan sesama client — modul ini tidak pernah menyentuh src/server.
//
// Satu-satunya tempat parse envelope {error:{code,message}} di client: semua
// respons gagal dilempar sebagai ApiError bermuatan code+message, bukan respons
// mentah, sehingga AuthPage menampilkan pesan bersih tanpa dump JSON.

import type { MessageDto, ThreadDto, UserDto } from "../shared/app.ts";
import type { YuiEvent } from "../shared/engine.ts";
import { createSseParser } from "./sse.ts";

/** User sesi di wire API — turunan kontrak shared (AD-8), bukan definisi lepas. */
export type CurrentUser = UserDto;

/**
 * Error API — dibedakan dari Error biasa agar UI bisa menampilkan `message`
 * tanpa membocorkan detail internal. `code` = code envelope, atau "unknown"
 * bila respons gagal tanpa envelope.
 */
export class ApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

/**
 * Respons non-2xx → ApiError. Body JSON berbentuk {error:{code,message}}
 * dipakai apa adanya; selain itu (termasuk body non-JSON) jatuh ke
 * code "unknown" dengan message berisi status respons.
 */
async function toApiError(response: Response): Promise<ApiError> {
  let code = "unknown";
  let message = `Unexpected response status ${response.status}`;
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const { error } = body as { error: unknown };
      if (
        typeof error === "object" &&
        error !== null &&
        typeof (error as Record<string, unknown>).code === "string" &&
        typeof (error as Record<string, unknown>).message === "string"
      ) {
        const envelope = error as { code: string; message: string };
        code = envelope.code;
        message = envelope.message;
      }
    }
  } catch {
    // Body bukan JSON — fallback unknown di atas sudah cukup.
  }
  return new ApiError(code, message);
}

async function postJson(path: string, body?: unknown): Promise<Response> {
  // Cookie sesi same-origin ikut otomatis: fetch default credentials
  // "same-origin" mengirim cookie untuk permintaan same-origin ini.
  const init: RequestInit =
    body === undefined
      ? { method: "POST" }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  return fetch(path, init);
}

/** POST /api/auth/register → sesi aktif (cookie di-set server) + user. */
export async function registerUser(username: string, password: string): Promise<CurrentUser> {
  const response = await postJson("/api/auth/register", { username, password });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as CurrentUser;
}

/** POST /api/auth/login → sesi aktif + user. */
export async function loginUser(username: string, password: string): Promise<CurrentUser> {
  const response = await postJson("/api/auth/login", { username, password });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as CurrentUser;
}

/** POST /api/auth/logout — idempoten; cabut sesi + bersihkan cookie. */
export async function logoutUser(): Promise<void> {
  const response = await postJson("/api/auth/logout");
  if (!response.ok) throw await toApiError(response);
}

/** GET /api/me — user pemilik sesi (401 envelope bila tanpa sesi). */
export async function fetchMe(): Promise<CurrentUser> {
  const response = await fetch("/api/me");
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as CurrentUser;
}

/**
 * GET /api/threads — the session's threads, newest first (ThreadDto[]).
 * GET without init: the session cookie rides fetch's same-origin default.
 */
export async function listThreads(): Promise<ThreadDto[]> {
  const response = await fetch("/api/threads");
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as ThreadDto[];
}

/** GET /api/threads/:id/messages — one thread's history, oldest first. */
export async function fetchThreadMessages(threadId: string): Promise<MessageDto[]> {
  const response = await fetch(
    `/api/threads/${encodeURIComponent(threadId)}/messages`,
  );
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as MessageDto[];
}

/** Body for POST /api/engine/turn — omit `threadId` to start a new thread. */
export type StreamTurnInput = {
  content: string;
  threadId?: string;
  clientToken?: string;
};

/**
 * POST /api/engine/turn and dispatch every streamed event to `onEvent` in
 * stream order (thread.updated → message.delta* → message.final →
 * turn.settled), typed as YuiEvent from the shared contract (AD-8). A
 * pre-stream failure (4xx envelope) throws ApiError before any event is
 * dispatched; a stream that breaks mid-way stops dispatching and rejects, so
 * the caller can release the composer without a hang.
 */
export async function streamTurn(
  input: StreamTurnInput,
  onEvent: (event: YuiEvent) => void,
): Promise<void> {
  const response = await fetch("/api/engine/turn", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await toApiError(response);
  if (response.body === null) {
    throw new ApiError("unknown", "The turn response has no event stream.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  // The server strips `type` from the payload and puts it on the frame's
  // dispatch name (see src/server/engine/routes.ts) — restore it so the event
  // matches the YuiEvent contract in src/shared/engine.ts.
  const parser = createSseParser(frame => {
    onEvent({ type: frame.event, ...frame.data } as YuiEvent);
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
  } catch (error) {
    // Network drop or malformed frame mid-stream: cancel the reader first so
    // the body is not left locked and the connection hanging open (the server
    // would stall on backpressure until unload), then surface the failure as
    // an ApiError like every other miss. No further events are dispatched.
    await reader.cancel().catch(() => undefined);
    throw new ApiError(
      "unknown",
      error instanceof Error ? error.message : "The turn stream ended unexpectedly.",
    );
  }
}
