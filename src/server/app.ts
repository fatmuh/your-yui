import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { APP_ID, type HealthDto } from "../shared/app.ts";
import type { YuiDatabase } from "./db/index.ts";
import { authRoutes } from "./auth/routes.ts";

export function createApp(staticRoot = "dist", db?: YuiDatabase) {
  const app = new Hono();

  app.get("/healthz", (c) => {
    const body: HealthDto = { app: APP_ID };
    return c.json(body);
  });

  // Dengan DB (produksi/test): API auth di-mount SEBELUM serveStatic agar
  // /api/* tidak pernah jatuh ke file statis. Tanpa DB perilaku lama utuh.
  if (db !== undefined) {
    app.route("/api", authRoutes(db));
  }

  // Production: serve the built client shell from dist/. Before `npm run build`
  // has run, these paths 404 — during development vite serves the shell instead.
  app.use("*", serveStatic({ root: staticRoot }));

  return app;
}
