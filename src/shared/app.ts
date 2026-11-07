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
 * Thread DTO on the API wire (AD-8): GET /api/threads returns ThreadDto[]
 * (updatedAt desc). `title` defaults to '' until story 3 (server-side writer)
 * derives it from the first user message.
 * Timestamps are ISO-8601 UTC (DB stores epoch-ms; converted at the edge).
 */
export type ThreadDto = {
  id: string;
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
  /** ISO-8601 UTC (DB stores epoch-ms; converted at the edge). */
  createdAt: string;
};
