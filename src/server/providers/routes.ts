import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { YuiDatabase } from "../db/index.ts";
import type { SessionUser } from "../auth/service.ts";
import { sessionUser } from "../auth/service.ts";
import { SESSION_COOKIE } from "../auth/cookies.ts";
import type { ProviderConfigDto } from "../../shared/app.ts";
import { PROVIDER_KINDS, type ProviderKind } from "../../shared/engine.ts";
import {
  deleteProviderConfig,
  getProviderConfig,
  upsertProviderConfig,
  type StoredProviderConfig,
} from "./store.ts";

// API config penyedia (R1, R2, AD-3, AD-9): PUT/GET/DELETE per
// (pengguna sesi, kind) — id config TIDAK diekspos, kind saja. View bermask
// dibaca dari `masked_hint` tersimpan; route tidak pernah mendekripsi.
// Envelope error konvensi spine {error:{code,message}} dengan kode stabil
// unauthorized / invalid_request / not_found.

const MAX_API_KEY_CHARS = 4_096;
const MAX_MODEL_ID_CHARS = 200;
const MAX_BASE_URL_CHARS = 2_048;

type ErrorCode = "unauthorized" | "invalid_request" | "not_found";

function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
) {
  return c.json({ error: { code, message } }, status);
}

/** DB epoch-ms → ISO-8601 UTC di API (konvensi spine); kredensial tak ikut. */
function toView(config: StoredProviderConfig): ProviderConfigDto {
  return {
    kind: config.kind as ProviderKind,
    baseUrl: config.baseUrl,
    modelId: config.modelId,
    maskedHint: config.maskedHint,
    createdAt: new Date(config.createdAt).toISOString(),
    updatedAt: new Date(config.updatedAt).toISOString(),
  };
}

/** URL http(s) valid — ditolak: skema lain, string tak ter-parse. */
function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

type ValidatedConfig = {
  apiKey: string;
  baseUrl: string | null;
  modelId: string | null;
};

type ParseResult = { ok: true; config: ValidatedConfig } | { ok: false; message: string };

/**
 * Validasi pra-tulis (matriks "Validasi ditolak"): semua input invalid → 400
 * TANPA menyentuh penyimpanan. openai-compatible WAJIB baseUrl+modelId agar
 * config tersimpan selalu bisa dijalankan adapter; anthropic opsional keduanya
 * (punya default internal adapter).
 */
function parseConfigBody(kind: ProviderKind, body: unknown): ParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "Request body must be a JSON object." };
  }
  const { apiKey, baseUrl, modelId } = body as Record<string, unknown>;

  if (typeof apiKey !== "string" || apiKey.length === 0 || apiKey.length > MAX_API_KEY_CHARS) {
    return {
      ok: false,
      message: `"apiKey" must be a non-empty string of at most ${MAX_API_KEY_CHARS} characters.`,
    };
  }

  let parsedBaseUrl: string | null = null;
  if (baseUrl !== undefined && baseUrl !== null) {
    if (
      typeof baseUrl !== "string" ||
      baseUrl.length > MAX_BASE_URL_CHARS ||
      !isHttpUrl(baseUrl)
    ) {
      return {
        ok: false,
        message: `"baseUrl", when present, must be a valid http(s) URL of at most ${MAX_BASE_URL_CHARS} characters.`,
      };
    }
    parsedBaseUrl = baseUrl;
  }

  let parsedModelId: string | null = null;
  if (modelId !== undefined && modelId !== null) {
    if (
      typeof modelId !== "string" ||
      modelId.length === 0 ||
      modelId.length > MAX_MODEL_ID_CHARS
    ) {
      return {
        ok: false,
        message: `"modelId", when present, must be a non-empty string of at most ${MAX_MODEL_ID_CHARS} characters.`,
      };
    }
    parsedModelId = modelId;
  }

  if (kind === "openai-compatible" && (parsedBaseUrl === null || parsedModelId === null)) {
    return {
      ok: false,
      message: 'Provider kind "openai-compatible" requires both "baseUrl" and "modelId".',
    };
  }

  return { ok: true, config: { apiKey, baseUrl: parsedBaseUrl, modelId: parsedModelId } };
}

/**
 * Sub-app config penyedia — di-mount `app.route("/api", ...)` sehingga
 * endpoint menjadi /api/provider-configs/:kind (PUT upsert, GET view bermask,
 * DELETE). Semua handler di balik gerbang sesi (AD-9) dan di-scope userId.
 */
export function providerConfigRoutes(db: YuiDatabase): Hono {
  const app = new Hono();

  // AD-9: gerbang sesi — tanpa cookie valid, 401 envelope; penyimpanan tak tersentuh.
  function currentUser(c: Context): SessionUser | null {
    const token = getCookie(c, SESSION_COOKIE);
    return token !== undefined ? sessionUser(db, token) : null;
  }

  function parseKind(c: Context): ProviderKind | null {
    const raw = c.req.param("kind");
    return PROVIDER_KINDS.includes(raw as ProviderKind) ? (raw as ProviderKind) : null;
  }

  app.put("/provider-configs/:kind", async (c) => {
    const user = currentUser(c);
    if (user === null) {
      return errorResponse(c, 401, "unauthorized", "A valid session is required.");
    }
    const kind = parseKind(c);
    if (kind === null) {
      return errorResponse(
        c,
        400,
        "invalid_request",
        `"kind" path parameter must be one of: ${PROVIDER_KINDS.join(", ")}.`,
      );
    }

    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const parsed = parseConfigBody(kind, body);
    if (!parsed.ok) {
      return errorResponse(c, 400, "invalid_request", parsed.message);
    }

    // Satu-satunya momen plaintext hidup di route: masuk upsert, keluar sebagai
    // ciphertext + masked_hint (AD-3). Respons hanya view bermask.
    const stored = upsertProviderConfig(db, {
      userId: user.id,
      kind,
      baseUrl: parsed.config.baseUrl,
      modelId: parsed.config.modelId,
      apiKey: parsed.config.apiKey,
    });
    return c.json(toView(stored), 200);
  });

  app.get("/provider-configs/:kind", (c) => {
    const user = currentUser(c);
    if (user === null) {
      return errorResponse(c, 401, "unauthorized", "A valid session is required.");
    }
    const kind = parseKind(c);
    if (kind === null) {
      return errorResponse(
        c,
        400,
        "invalid_request",
        `"kind" path parameter must be one of: ${PROVIDER_KINDS.join(", ")}.`,
      );
    }

    const stored = getProviderConfig(db, user.id, kind);
    if (stored === null) {
      return errorResponse(
        c,
        404,
        "not_found",
        "No provider configuration is stored for this kind.",
      );
    }
    return c.json(toView(stored), 200);
  });

  app.delete("/provider-configs/:kind", (c) => {
    const user = currentUser(c);
    if (user === null) {
      return errorResponse(c, 401, "unauthorized", "A valid session is required.");
    }
    const kind = parseKind(c);
    if (kind === null) {
      return errorResponse(
        c,
        400,
        "invalid_request",
        `"kind" path parameter must be one of: ${PROVIDER_KINDS.join(", ")}.`,
      );
    }

    const deleted = deleteProviderConfig(db, user.id, kind);
    if (!deleted) {
      return errorResponse(
        c,
        404,
        "not_found",
        "No provider configuration is stored for this kind.",
      );
    }
    return c.body(null, 204);
  });

  return app;
}
