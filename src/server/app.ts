import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { APP_ID, type HealthDto } from "../shared/app.ts";
import type { YuiDatabase } from "./db/index.ts";
import { audioRoutes } from "./audio/routes.ts";
import { authRoutes } from "./auth/routes.ts";
import { conversationRoutes } from "./conversations/routes.ts";
import { engineRoutes } from "./engine/routes.ts";
import { providerConfigRoutes } from "./providers/routes.ts";

export function createApp(staticRoot = "dist", db?: YuiDatabase) {
  const app = new Hono();

  // Penutup kelas jalur error tak-tertangani (deferred review 2.3): throw
  // apa pun (mis. CryptoError saat APP_ENCRYPTION_KEY absen di PUT config)
  // dipetakan ke 500 envelope konvensi spine dengan kode stabil
  // `internal_error`. Respons sengaja generik — detail error asli (pesan +
  // stack) hanya ke log server-side; pesan CryptoError tak pernah memuat
  // kredensial, hanya nama env var.
  app.onError((err, c) => {
    console.error("Unhandled error:", err);
    return c.json(
      { error: { code: "internal_error", message: "Internal server error." } },
      500,
    );
  });

  app.get("/healthz", (c) => {
    const body: HealthDto = { app: APP_ID };
    return c.json(body);
  });

  // Dengan DB (produksi/test): API auth + engine + config penyedia + baca
  // percakapan di-mount SEBELUM serveStatic agar /api/* tidak pernah jatuh ke
  // file statis. Tanpa DB perilaku lama utuh.
  if (db !== undefined) {
    app.route("/api", authRoutes(db));
    app.route("/api", engineRoutes(db));
    app.route("/api", providerConfigRoutes(db));
    app.route("/api", conversationRoutes(db));
    app.route("/api", audioRoutes(db));
  }

  // Production: serve the built client shell from dist/. Before `npm run build`
  // has run, these paths 404 — during development vite serves the shell instead.
  app.use("*", serveStatic({ root: staticRoot }));

  return app;
}
