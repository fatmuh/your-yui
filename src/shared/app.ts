/**
 * Shared constants and DTO types for Yui.
 *
 * This module is the concrete client → shared ← server dependency edge (AD-8):
 * it contains types and constants only — no logic — and is imported by both
 * src/client and src/server.
 */

/** Display name of the application. */
export const APP_NAME = "Yui";

/** Machine-readable app identity used in payloads such as /healthz. */
export const APP_ID = "yui";

/** DTO returned by GET /healthz. */
export type HealthDto = {
  app: string;
};
