import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { APP_ID, type HealthDto } from "../shared/app.ts";

const app = new Hono();

app.get("/healthz", (c) => {
  const body: HealthDto = { app: APP_ID };
  return c.json(body);
});

// Production: serve the built client shell from dist/. Before `npm run build`
// has run, these paths 404 — during development vite serves the shell instead.
app.use("*", serveStatic({ root: "dist" }));

export default app;
