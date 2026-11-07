import { expect } from "vitest";
import type { Hono } from "hono";
import { SESSION_COOKIE } from "../../src/server/auth/cookies.ts";

// Helper API in-process (ekstraksi byte-identik dari engine-turn.test.ts):
// register + POST giliran lewat `app.request` — dipakai file test yang
// menimbus app Hono langsung (bukan soket nyata seperti served-probe).

/** Register + ambil token cookie mentah dari Set-Cookie beserta userId. */
export async function registerUser(app: Hono, username: string): Promise<{ token: string; userId: string }> {
  const res = await app.request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, password: "password-tepat" }),
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(201);
  const cookie = res.headers
    .getSetCookie()
    .find((entry) => entry.startsWith(`${SESSION_COOKIE}=`));
  expect(cookie).toBeDefined();
  const body = (await res.json()) as { id: string };
  return { token: cookie!.split(";")[0]!.slice(SESSION_COOKIE.length + 1), userId: body.id };
}

export async function postTurn(
  app: Hono,
  token: string | undefined,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request("/api/engine/turn", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { cookie: `${SESSION_COOKIE}=${token}` }),
    },
  });
}
