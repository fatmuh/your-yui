import { serve } from "@hono/node-server";
import { APP_NAME } from "../shared/app.ts";
import app from "./app.ts";

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`${APP_NAME} listening on http://localhost:${info.port}`);
});
