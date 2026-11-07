/**
 * Shared constants and DTO types for Yui.
 *
 * This module is the concrete client → shared ← server dependency edge (AD-8):
 * it contains types and constants only — no logic — and is imported by both
 * src/client and src/server.
 */

import type { ProviderKind } from "./engine.ts";

/** Display name of the application. */
export const APP_NAME = "Yui";

/** Machine-readable app identity used in payloads such as /healthz. */
export const APP_ID = "yui";

/** DTO returned by GET /healthz. */
export type HealthDto = {
  app: string;
};

/**
 * User DTO on the API wire (AD-8 contract): register/login return `{id, username}`;
 * GET /api/me adds `createdAt` as ISO-8601 UTC (DB stores epoch-ms; converted at the edge).
 */
export type UserDto = {
  id: string;
  username: string;
  createdAt?: string;
};

/**
 * Provider config DTO on the API wire (AD-8): PUT/GET /api/provider-configs/:kind.
 * `maskedHint` is the one-way `sk-…abcd` mask computed at upsert and stored as
 * `masked_hint` — the raw credential NEVER appears in any response (AD-3).
 * No config id is exposed: one config per (user, kind), addressed by `kind`.
 */
export type ProviderConfigDto = {
  kind: ProviderKind;
  baseUrl: string | null;
  modelId: string | null;
  maskedHint: string;
  /** ISO-8601 UTC (DB stores epoch-ms; converted at the edge). */
  createdAt: string;
  /** ISO-8601 UTC. */
  updatedAt: string;
};

/**
 * Peran pesan percakapan — selaras tipe Message template client
 * ('user' | 'assistant'); disimpan apa adanya di kolom `messages.role`.
 */
export type MessageRole = "user" | "assistant";

/**
 * Bot DTO on the API wire (AD-8): GET /api/bots returns BotDto[] (createdAt
 * asc — creation order, the shortcut-row order), POST /api/bots returns one.
 * `persona` is the full system-prompt replacement for the bot's turns; an
 * empty persona means "use DEFAULT_BOT_PERSONA" (resolved at the engine edge,
 * never stored expanded). No edit endpoint exists in v1 — bots are immutable
 * after creation.
 */
export type BotDto = {
  id: string;
  name: string;
  persona: string;
  /** ISO-8601 UTC (DB stores epoch-ms; converted at the edge). */
  createdAt: string;
};

/**
 * Fallback persona for bots stored with an empty persona (plan Design Notes,
 * verbatim — English, frozen): the bot behaves as a general personal
 * assistant instead of the engine's default coding-agent prompt. The migration
 * backfill (0005) embeds the same text for pre-multi-bot threads.
 */
export const DEFAULT_BOT_PERSONA =
  "You are a personal assistant. Help with everyday tasks: answering questions, planning, drafting, summarizing, research, and casual conversation. Be warm, direct, and concise. You are not a coding agent — do not assume software tasks unless explicitly asked.";

/**
 * Thread DTO on the API wire (AD-8): GET /api/threads returns ThreadDto[]
 * (updatedAt desc). `title` defaults to '' until story 3 (server-side writer)
 * derives it from the first user message. `title` is internal (future search);
 * the client displays the BOT name, never this title.
 * `botId` is the bot the thread is bound to at creation (nullable only for
 * rows predating migration 0005).
 * Timestamps are ISO-8601 UTC (DB stores epoch-ms; converted at the edge).
 */
export type ThreadDto = {
  id: string;
  botId: string | null;
  title: string;
  /** ISO-8601 UTC. */
  createdAt: string;
  /** ISO-8601 UTC. */
  updatedAt: string;
};

/**
 * Message DTO on the API wire (AD-8): GET /api/threads/:id/messages returns
 * MessageDto[] (createdAt asc). The client consumes it in story 4.
 */
export type MessageDto = {
  id: string;
  role: MessageRole;
  text: string;
  /**
   * Attached voice note (epic-voice): present only on user messages stored
   * from an audio turn. The client renders `durationMs` from here — it never
   * re-derives the placeholder text. Omitted when the message has no audio or
   * the blob is no longer resolvable; `text` then still carries the stored
   * placeholder.
   */
  audio?: { id: string; mime: string; durationMs: number };
  /** ISO-8601 UTC (DB stores epoch-ms; converted at the edge). */
  createdAt: string;
};
