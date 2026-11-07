import devServer, { defaultOptions } from "@hono/vite-dev-server";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    devServer({
      // dev.ts membuka + memigrasi DB dev lalu men-export app — sehingga
      // /api/* hidup di `npm run dev`; produksi tetap lewat src/server/index.ts.
      entry: "./src/server/dev.ts",
      export: "default",
      // Default excludes keep module requests (/src/**, .ts/.tsx/.js, /@vite/*)
      // in the hands of the vite dev pipeline. `/` is added so the dev shell
      // (index.html + HMR) is served by vite; in production the same path is
      // served by serveStatic from dist/.
      exclude: [...defaultOptions.exclude, /^\/$/],
    }),
    // PWA support for the PRODUCTION build only: emits dist/manifest.webmanifest
    // + dist/sw.js (generateSW default) and injects the manifest link + SW
    // registration into the built shell. devOptions is intentionally absent, so
    // `npm run dev` serves no service worker and its behavior is unchanged.
    // Static-only by construction: no runtimeCaching at all, and the navigation
    // fallback denies /api/* (AD-10 — every API path, including audio blobs and
    // SSE, stays network-only).
    VitePWA({
      manifest: {
        name: "Yui",
        short_name: "Yui",
        description: "A quiet space for your ideas — a responsive, dark chat interface.",
        theme_color: "#111111",
        background_color: "#111111",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "pwa-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          {
            src: "pwa-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      includeAssets: ["favicon.svg", "pwa-192.png", "pwa-512.png", "pwa-maskable-512.png"],
      workbox: {
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
});
