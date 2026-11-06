import { defineConfig } from "drizzle-kit";

// Dev-only config for `npm run db:generate`. Runtime never invokes drizzle-kit;
// migrations are applied by the drizzle migrator in src/server/db/index.ts.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db/schema.ts",
  out: "./src/server/db/migrations",
});
