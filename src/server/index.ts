import { serve } from "@hono/node-server";
import { APP_NAME } from "../shared/app.ts";
import app from "./app.ts";

const DEFAULT_PORT = 3000;

// PORT must be a positive integer; anything else (unset, empty, non-numeric)
// falls back to the default instead of binding a random or invalid port.
const parsedPort = Number(process.env.PORT);
const port =
  Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;

if (process.env.PORT !== undefined && parsedPort !== port) {
  console.warn(`Ignoring invalid PORT "${process.env.PORT}", using ${port}`);
}

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`${APP_NAME} listening on http://localhost:${info.port}`);
});
