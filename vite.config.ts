import devServer, { defaultOptions } from "@hono/vite-dev-server";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    devServer({
      entry: "./src/server/app.ts",
      export: "default",
      // Default excludes keep module requests (/src/**, .ts/.tsx/.js, /@vite/*)
      // in the hands of the vite dev pipeline. `/` is added so the dev shell
      // (index.html + HMR) is served by vite; in production the same path is
      // served by serveStatic from dist/.
      exclude: [...defaultOptions.exclude, /^\/$/],
    }),
  ],
});
