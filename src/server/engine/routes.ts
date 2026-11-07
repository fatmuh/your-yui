import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { ulid } from "ulidx";
import type { YuiDatabase } from "../db/index.ts";
import { sessionUser } from "../auth/service.ts";
import { SESSION_COOKIE } from "../auth/cookies.ts";
import { getProviderConfig } from "../providers/store.ts";
import { createEngineAdapter, EngineAdapterError } from "./adapter.ts";
import type { ProviderKind, YuiEvent } from "../../shared/engine.ts";

// Route SSE giliran uji (R4, AD-9): satu POST = satu giliran penuh, respons
// SSE memancarkan union event AD-4. Envelope error konvensi spine
// {error:{code,message}} untuk kegagalan pra-stream (auth, validasi body);
// kegagalan giliran mengalir sebagai event `error` + `turn.settled`.

const MAX_CONTENT_CHARS = 8_000;

/** Nilai union `ProviderKind` kontrak — validasi `body.kind` pra-stream. */
const PROVIDER_KINDS: readonly ProviderKind[] = ["openai-compatible", "anthropic"];
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

    // threadId opsional: giliran uji boleh membuat thread ephemeral baru.
    const rawThreadId = body?.threadId;
    const threadId =
      typeof rawThreadId === "string" && rawThreadId.length > 0 && rawThreadId.length <= 64
        ? rawThreadId
        : ulid();
    const rawClientToken = body?.clientToken;
    const clientToken =
      typeof rawClientToken === "string" && rawClientToken.length > 0 && rawClientToken.length <= 128
        ? rawClientToken
        : undefined;

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

    const config = getProviderConfig(db, user.id, kind);
    const { sessionId } = await adapter.createSession({
      userId: user.id,
      threadId,
      providerConfigId: config?.id ?? null,
    });

    return streamSSE(c, async (stream) => {
      // Penulisan SSE diserialkan (satu antrean promise) agar event tak
      // saling mengalahkan; kegagalan tulus (klien putus) berhenti diam.
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

      try {
        await adapter.prompt({ sessionId, content, clientToken }, sink);
      } catch (error) {
        // Defensive: error di luar jaminan adapter tetap berakhir settled (AD-4).
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
