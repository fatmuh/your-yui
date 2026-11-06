import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { YuiDatabase } from "../db/index.ts";
import {
  AuthError,
  deleteSession,
  loginUser,
  registerUser,
  sessionUser,
  type AuthErrorCode,
} from "./service.ts";
import { SESSION_COOKIE, clearSessionCookie, setSessionCookie } from "./cookies.ts";

// Permukaan API story ini: POST /api/auth/register|login|logout + GET /api/me.
// Envelope error konvensi spine: {error:{code,message}}.

const ERROR_STATUS: Record<AuthErrorCode, ContentfulStatusCode> = {
  invalid_request: 400,
  username_taken: 409,
  invalid_credentials: 401,
  unauthorized: 401,
};

const ERROR_MESSAGE: Record<AuthErrorCode, string> = {
  invalid_request:
    "Invalid request: username must be 3-32 characters [a-z0-9_-] and password at least 8 characters.",
  username_taken: "Username is already taken.",
  invalid_credentials: "Invalid username or password.",
  unauthorized: "A valid session is required.",
};

function errorResponse(c: Context, status: ContentfulStatusCode, code: AuthErrorCode) {
  return c.json({ error: { code, message: ERROR_MESSAGE[code] } }, status);
}

/** AuthError service → status + envelope; error lain dibiarkan menggelembung (500). */
function toErrorResponse(c: Context, error: unknown) {
  if (error instanceof AuthError) {
    return errorResponse(c, ERROR_STATUS[error.code], error.code);
  }
  throw error;
}

/** Body JSON `{username,password}`; null bila body bukan JSON/object valid. */
async function readCredentials(c: Context): Promise<{ username: unknown; password: unknown } | null> {
  try {
    const body: unknown = await c.req.json();
    if (typeof body !== "object" || body === null) return null;
    const { username, password } = body as Record<string, unknown>;
    return { username, password };
  } catch {
    return null;
  }
}

/**
 * Sub-app auth — di-mount `app.route("/api", ...)` sehingga endpoint menjadi
 * /api/auth/register, /api/auth/login, /api/auth/logout, /api/me.
 */
export function authRoutes(db: YuiDatabase): Hono {
  const app = new Hono();

  app.post("/auth/register", async (c) => {
    const credentials = await readCredentials(c);
    if (credentials === null) {
      return errorResponse(c, 400, "invalid_request");
    }
    try {
      const { user, token } = await registerUser(db, credentials);
      setSessionCookie(c, token);
      return c.json(user, 201);
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });

  app.post("/auth/login", async (c) => {
    const credentials = await readCredentials(c);
    if (credentials === null) {
      return errorResponse(c, 400, "invalid_request");
    }
    try {
      const { user, token } = await loginUser(db, credentials);
      setSessionCookie(c, token);
      return c.json(user, 200);
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });

  app.post("/auth/logout", (c) => {
    // Idempoten: tanpa cookie tetap 204 — tidak membocorkan ada/tidaknya sesi.
    const token = getCookie(c, SESSION_COOKIE);
    if (token !== undefined) {
      deleteSession(db, token);
    }
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  app.get("/me", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    const user = token !== undefined ? sessionUser(db, token) : null;
    if (user === null) {
      return errorResponse(c, 401, "unauthorized");
    }
    // DB epoch-ms → ISO-8601 UTC di API (konvensi spine).
    return c.json({
      id: user.id,
      username: user.username,
      createdAt: new Date(user.createdAt).toISOString(),
    });
  });

  return app;
}
