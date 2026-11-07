import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App, { SessionGate } from "./App.tsx";
import AuthPage from "./AuthPage.tsx";
import { CreateBotDialog } from "./CreateBotDialog.tsx";
import { BotsEmptyState } from "./TemplateApp.tsx";
import { SessionContext, type SessionState } from "./SessionContext.tsx";
import { DEFAULT_BOT_PERSONA } from "../shared/app.ts";

// Uji komponen gerbang sesi tanpa deps test baru: renderToStaticMarkup + stub
// nilai SessionContext (efek tidak pernah berjalan di static markup, jadi
// state loading adalah render awal App, dan state lain disuntik lewat provider).

// Aplikasi template membaca matchMedia saat render (lebar viewport menentukan
// layout sidebar/panel) — Node tidak memilikinya, jadi stub untuk render statis.
function stubMatchMedia(): void {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    expect(html).not.toContain("Connect apps");
  });

  it("tanpa sesi: status unauthenticated → AuthPage (bukan loading/home)", () => {
    const html = renderWithSession({ status: "unauthenticated", user: null }, <SessionGate />);

    expect(html).toContain("Sign in to Yui");
    expect(html).not.toContain("Loading…");
    expect(html).not.toContain("Connect apps");
  });

  it("sesi valid: status authenticated → aplikasi template (bukan auth/loading)", () => {
    stubMatchMedia();
    const html = renderWithSession(
      { status: "authenticated", user: STUB_USER },
      <SessionGate />,
    );

    expect(html).toContain("Connect apps");
    // Multi-bot harness: the demo seed bots are GONE — chat starts empty until
    // the user creates bots. The static (pre-effect) render is the loading
    // pane: no seed names, and the empty state only appears after the mount
    // fetch settles (never flashes for a user who HAS bots).
    expect(html).not.toContain("CFO");
    expect(html).not.toContain("Create your first bot");
    expect(html).not.toContain("Sign in to Yui");
    expect(html).not.toContain("Loading…");
  });
});

// Multi-bot harness: the two pieces of UI a signed-in user meets first — the
// "no bots yet" empty state and the create dialog whose persona textarea
// prefills DEFAULT_BOT_PERSONA (so "just a name" still yields a personal
// assistant). Static markup is enough: both are plain render output.
describe("BotsEmptyState", () => {
  it("renders the create-your-first-bot empty state with a create action", () => {
    const html = renderToStaticMarkup(<BotsEmptyState onCreate={() => undefined} />);

    expect(html).toContain("Create your first bot");
    expect(html).toContain("Create a bot");
    expect(html).toContain("bots-empty-cta");
    // panel-empty pattern: the same class family the other empty states use.
    expect(html).toContain("panel-empty");
  });
});

describe("CreateBotDialog", () => {
  it("prefills the persona textarea with DEFAULT_BOT_PERSONA and caps name/persona inputs", () => {
    const html = renderToStaticMarkup(
      <CreateBotDialog onClose={() => undefined} onCreated={() => undefined} />,
    );

    expect(html).toContain("Create New Bot");
    // The persona input starts at the default personal-assistant persona —
    // the full-replacement system prompt the bot will run.
    expect(html).toContain(DEFAULT_BOT_PERSONA);
    expect(html).toMatch(/maxLength="64"/);
    expect(html).toMatch(/maxLength="8000"/);
    // Create is disabled until a name is typed (initial state: empty name).
    expect(html).toMatch(/<button[^>]*class="bot-create"[^>]*disabled/);
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
