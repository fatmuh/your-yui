import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { YuiDatabase } from "../db/index.ts";
import type { SessionUser } from "../auth/service.ts";
import { sessionUser } from "../auth/service.ts";
import { SESSION_COOKIE } from "../auth/cookies.ts";
import type { BotDto } from "../../shared/app.ts";
import { deleteBot, getBotById, insertBot, listBots, type NewBot } from "./store.ts";

// Bot API (multi-bot harness, AD-9): GET/POST /api/bots + GET/DELETE
// /api/bots/:id — every handler behind the session gate and scoped to the
// session user in SQL (store). Bots are immutable post-creation (no PUT).
// Error envelope follows the spine convention {error:{code,message}} with the
// stable codes unauthorized / invalid_request / not_found; a foreign bot and
// an unknown bot answer the IDENTICAL 404 (anti-enumeration, like threads and
// audio blobs).

const MAX_NAME_CHARS = 64;
const MAX_PERSONA_CHARS = 8_000;

type ErrorCode = "unauthorized" | "invalid_request" | "not_found";

function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
) {
  return c.json({ error: { code, message } }, status);
}

/** DB epoch-ms → ISO-8601 UTC at the API edge (spine convention). */
function toDto(bot: { id: string; name: string; persona: string; createdAt: number }): BotDto {
  return {
    id: bot.id,
    name: bot.name,
    persona: bot.persona,
    createdAt: new Date(bot.createdAt).toISOString(),
  };
}

type ParseResult = { ok: true; bot: NewBot } | { ok: false; message: string };

/**
 * Pre-write validation (I/O matrix "Buat bot"): `name` is a non-empty string
 * of at most 64 characters after trimming (the trimmed value is stored);
 * `persona` is optional, at most 8,000 characters, empty means "default
 * persona". Anything else → 400 without touching the store.
 */
function parseBotBody(body: unknown): ParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "Request body must be a JSON object." };
  }
  const { name, persona } = body as Record<string, unknown>;

  if (typeof name !== "string" || name.trim().length === 0 || name.trim().length > MAX_NAME_CHARS) {
    return {
      ok: false,
      message: `"name" must be a non-empty string of at most ${MAX_NAME_CHARS} characters.`,
    };
  }

  let parsedPersona = "";
  if (persona !== undefined && persona !== null) {
    if (typeof persona !== "string" || persona.length > MAX_PERSONA_CHARS) {
      return {
        ok: false,
        message: `"persona", when present, must be a string of at most ${MAX_PERSONA_CHARS} characters.`,
      };
    }
    parsedPersona = persona;
  }

  return { ok: true, bot: { name: name.trim(), persona: parsedPersona } };
}

/**
 * Sub-app bots — mounted via `app.route("/api", ...)`, so the endpoints are
 * /api/bots and /api/bots/:id. Pattern follows provider-configs: session gate,
 * envelope errors, owner-scoped store calls.
 */
export function botRoutes(db: YuiDatabase): Hono {
  const app = new Hono();

  // AD-9: session gate — no valid cookie, 401 envelope; the store is untouched.
  function currentUser(c: Context): SessionUser | null {
    const token = getCookie(c, SESSION_COOKIE);
    return token !== undefined ? sessionUser(db, token) : null;
  }

  app.get("/bots", (c) => {
    const user = currentUser(c);
    if (user === null) {
      return errorResponse(c, 401, "unauthorized", "A valid session is required.");
    }
    // A user without bots gets [] — not 404 (I/O matrix "User tanpa bot").
    return c.json(listBots(db, user.id).map(toDto), 200);
  });

  app.post("/bots", async (c) => {
    const user = currentUser(c);
    if (user === null) {
      return errorResponse(c, 401, "unauthorized", "A valid session is required.");
    }

    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const parsed = parseBotBody(body);
    if (!parsed.ok) {
      return errorResponse(c, 400, "invalid_request", parsed.message);
    }

    const stored = insertBot(db, user.id, parsed.bot);
    return c.json(toDto(stored), 201);
  });

  app.get("/bots/:id", (c) => {
    const user = currentUser(c);
    if (user === null) {
      return errorResponse(c, 401, "unauthorized", "A valid session is required.");
    }
    const bot = getBotById(db, user.id, c.req.param("id"));
    if (bot === null) {
      return errorResponse(c, 404, "not_found", "Bot not found.");
    }
    return c.json(toDto(bot), 200);
  });

  app.delete("/bots/:id", (c) => {
    const user = currentUser(c);
    if (user === null) {
      return errorResponse(c, 401, "unauthorized", "A valid session is required.");
    }
    // Foreign and unknown ids share one identical 404 (anti-enumeration); a
    // successful delete cascades the bot's threads and their messages.
    const deleted = deleteBot(db, user.id, c.req.param("id"));
    if (!deleted) {
      return errorResponse(c, 404, "not_found", "Bot not found.");
    }
    return c.body(null, 204);
  });

  return app;
}
