// Wrapper API auth sisi client (story 4). AD-8: client hanya mengimpor
// src/shared/ dan sesama client — modul ini tidak pernah menyentuh src/server.
//
// Satu-satunya tempat parse envelope {error:{code,message}} di client: semua
// respons gagal dilempar sebagai ApiError bermuatan code+message, bukan respons
// mentah, sehingga AuthPage menampilkan pesan bersih tanpa dump JSON.

/** User sesi: body register/login `{id, username}`; /api/me menambah createdAt ISO. */
export type CurrentUser = {
  id: string;
  username: string;
  createdAt?: string;
};

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
