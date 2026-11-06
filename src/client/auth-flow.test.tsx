import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import App, { SessionGate } from "./App.tsx";
import AuthPage from "./AuthPage.tsx";
import HomePage from "./HomePage.tsx";
import { SessionContext, type SessionState } from "./SessionContext.tsx";

// Uji komponen gerbang sesi tanpa deps test baru: renderToStaticMarkup + stub
// nilai SessionContext (efek tidak pernah berjalan di static markup, jadi
// state loading adalah render awal App, dan state lain disuntik lewat provider).

const STUB_USER = {
  id: "01JCTESTTESTTESTTESTTESTTE",
  username: "arjuna",
  createdAt: "2026-11-06T10:00:00.000Z",
};

/** Render elemen dengan nilai sesi di-stub — pemakaian konteks tetap jalan. */
function renderWithSession(overrides: Partial<SessionState>, element: ReactElement): string {
  const value: SessionState = {
    status: "authenticated",
    user: null,
    refresh: () => Promise.resolve(),
    setUser: () => undefined,
    signOut: () => Promise.resolve(),
    ...overrides,
  };
  return renderToStaticMarkup(<SessionContext.Provider value={value}>{element}</SessionContext.Provider>);
}

describe("gerbang sesi (SessionGate)", () => {
  it("boot: render awal App adalah layar loading — form tidak ber-flash", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Yui");
    expect(html).toContain("Loading…");
    expect(html).not.toContain("Sign in to Yui");
    expect(html).not.toContain("Signed in as");
  });

  it("tanpa sesi: status unauthenticated → AuthPage (bukan loading/home)", () => {
    const html = renderWithSession({ status: "unauthenticated", user: null }, <SessionGate />);

    expect(html).toContain("Sign in to Yui");
    expect(html).not.toContain("Loading…");
    expect(html).not.toContain("Signed in as");
  });

  it("sesi valid: status authenticated → HomePage", () => {
    const html = renderWithSession(
      { status: "authenticated", user: STUB_USER },
      <SessionGate />,
    );

    expect(html).toContain("Signed in as");
    expect(html).not.toContain("Sign in to Yui");
    expect(html).not.toContain("Loading…");
  });
});

describe("AuthPage", () => {
  it("default: form sign-in dengan label Username dan Password + toggle ke create account", () => {
    const html = renderWithSession({ status: "unauthenticated" }, <AuthPage />);

    expect(html).toContain("Sign in to Yui");
    expect(html).toContain("Username");
    expect(html).toContain("Password");
    expect(html).toContain("Create account");
  });

  it("mode create account: heading Create account + toggle kembali ke sign in", () => {
    const html = renderWithSession(
      { status: "unauthenticated" },
      <AuthPage initialMode="register" />,
    );

    expect(html).toContain("Create account");
    expect(html).toContain("Back to sign in");
    expect(html).not.toContain("Sign in to Yui");
  });

  it("props error dirender sebagai pesan — bukan dump JSON mentah", () => {
    const html = renderWithSession(
      { status: "unauthenticated" },
      <AuthPage initialError="Username is already taken." />,
    );

    expect(html).toContain("Username is already taken.");
    expect(html).not.toContain('{"error"');
  });
});

describe("HomePage", () => {
  it("user stub: menampilkan username, info createdAt ISO, dan tombol Sign out", () => {
    const html = renderWithSession({ status: "authenticated", user: STUB_USER }, <HomePage />);

    expect(html).toContain("Signed in as");
    expect(html).toContain("arjuna");
    expect(html).toContain("Sign out");
    expect(html).toContain("2026-11-06T10:00:00.000Z");
  });

  it("tanpa createdAt (hasil register/login langsung): tetap utuh tanpa info sesi", () => {
    const html = renderWithSession(
      { status: "authenticated", user: { id: STUB_USER.id, username: STUB_USER.username } },
      <HomePage />,
    );

    expect(html).toContain("Signed in as");
    expect(html).toContain("arjuna");
    expect(html).toContain("Sign out");
    expect(html).not.toContain("Account created");
  });
});
