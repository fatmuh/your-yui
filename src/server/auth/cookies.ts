import { deleteCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import { SESSION_TTL_MS } from "./service.ts";

// Satu-satunya tempat nama cookie sesi dan atributnya didefinisikan (AD-9).

export const SESSION_COOKIE = "yui_session";

/** Umur cookie sesi — DITURUNKAN dari SESSION_TTL_MS service (satu sumber kebenaran). */
const SESSION_MAX_AGE_SECONDS = SESSION_TTL_MS / 1000;

const COOKIE_ATTRIBUTES = {
  httpOnly: true,
  sameSite: "Lax",
  path: "/",
  secure: true,
} as const;

/** Taruh token sesi sebagai cookie httpOnly (dipanggil saat register/login). */
export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    ...COOKIE_ATTRIBUTES,
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

/**
 * Bersihkan cookie sesi: nilai kosong + Max-Age=0 sehingga browser langsung
 * membuangnya (dipanggil saat logout).
 */
export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { ...COOKIE_ATTRIBUTES });
}
