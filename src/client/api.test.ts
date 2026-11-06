import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchMe, loginUser, logoutUser, registerUser } from "./api.ts";

// Wrapper API diuji dengan fetch global di-stub (vi.stubGlobal) — tanpa server
// dan tanpa deps test baru. Response global Node dipakai untuk membangun
// respons stub.

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Stub fetch global; satu respons dipakai untuk semua pemanggilan. */
function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn();
  mock.mockResolvedValue(response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** Argumen pemanggilan fetch pertama sebagai [url, init]. */
function firstCall(mock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  const [url, init] = mock.mock.calls[0] as [string, RequestInit];
  return [url, init];
}

describe("registerUser", () => {
  it("memanggil POST /api/auth/register dengan body JSON {username,password} → user", async () => {
    const mock = stubFetch(jsonResponse({ id: "01JCTESTTESTTESTTESTTESTTE", username: "arjuna" }, 201));

    const user = await registerUser("arjuna", "password-tepat");

    expect(user).toEqual({ id: "01JCTESTTESTTESTTESTTESTTE", username: "arjuna" });
    const [url, init] = firstCall(mock);
    expect(url).toBe("/api/auth/register");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({
      username: "arjuna",
      password: "password-tepat",
    });
  });

  it("envelope 409 username_taken → ApiError bermuatan code+message envelope", async () => {
    stubFetch(
      jsonResponse(
        { error: { code: "username_taken", message: "Username is already taken." } },
        409,
      ),
    );

    await expect(registerUser("arjuna", "password-tepat")).rejects.toMatchObject({
      name: "ApiError",
      code: "username_taken",
      message: "Username is already taken.",
    });
  });
});

describe("loginUser", () => {
  it("memanggil POST /api/auth/login dengan body JSON → user", async () => {
    const mock = stubFetch(jsonResponse({ id: "01JCTESTTESTTESTTESTTESTTE", username: "arjuna" }));

    const user = await loginUser("arjuna", "password-tepat");

    expect(user).toEqual({ id: "01JCTESTTESTTESTTESTTESTTE", username: "arjuna" });
    const [url, init] = firstCall(mock);
    expect(url).toBe("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      username: "arjuna",
      password: "password-tepat",
    });
  });

  it("envelope 401 invalid_credentials → ApiError dengan pesan envelope", async () => {
    stubFetch(
      jsonResponse(
        { error: { code: "invalid_credentials", message: "Invalid username or password." } },
        401,
      ),
    );

    // Satu pemanggilan: body Response hanya bisa dibaca sekali oleh wrapper.
    const caught = await loginUser("arjuna", "password-salah").then(
      () => {
        throw new Error("loginUser expected to reject");
      },
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({
      code: "invalid_credentials",
      message: "Invalid username or password.",
    });
  });
});

describe("logoutUser", () => {
  it("memanggil POST /api/auth/logout (tanpa body) dan selesai pada 204", async () => {
    const mock = stubFetch(new Response(null, { status: 204 }));

    await expect(logoutUser()).resolves.toBeUndefined();

    const [url, init] = firstCall(mock);
    expect(url).toBe("/api/auth/logout");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });
});

describe("fetchMe", () => {
  it("memanggil GET /api/me → user dengan createdAt ISO", async () => {
    const mock = stubFetch(
      jsonResponse({
        id: "01JCTESTTESTTESTTESTTESTTE",
        username: "arjuna",
        createdAt: "2026-11-06T10:00:00.000Z",
      }),
    );

    const user = await fetchMe();

    expect(user).toEqual({
      id: "01JCTESTTESTTESTTESTTESTTE",
      username: "arjuna",
      createdAt: "2026-11-06T10:00:00.000Z",
    });
    // GET tanpa init — cookie sesi ikut lewat default same-origin.
    expect(mock).toHaveBeenCalledWith("/api/me");
  });

  it("envelope 401 unauthorized → ApiError unauthorized", async () => {
    stubFetch(
      jsonResponse(
        { error: { code: "unauthorized", message: "A valid session is required." } },
        401,
      ),
    );

    await expect(fetchMe()).rejects.toMatchObject({
      code: "unauthorized",
      message: "A valid session is required.",
    });
  });
});

describe("respons gagal tanpa envelope", () => {
  it("502 body non-JSON → ApiError code unknown dengan status di message", async () => {
    stubFetch(new Response("Bad Gateway", { status: 502 }));

    await expect(fetchMe()).rejects.toMatchObject({
      name: "ApiError",
      code: "unknown",
      message: expect.stringContaining("502"),
    });
  });

  it("500 body JSON tanpa bentuk error → ApiError unknown", async () => {
    stubFetch(jsonResponse({ unexpected: "shape" }, 500));

    await expect(fetchMe()).rejects.toMatchObject({ code: "unknown" });
  });
});
