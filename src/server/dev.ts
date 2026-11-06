import { createApp } from "./app.ts";
import { createDatabase, migrateDatabase, resolveDatabasePath } from "./db/index.ts";

// Entry dev untuk @hono/vite-dev-server (vite.config.ts) — produksi tetap
// lewat src/server/index.ts yang tak berubah. Membuka + memigrasi DB dev
// (DATA_DIR, default data/) sekali saat modul dimuat agar /api/* hidup di
// `npm run dev`; shell client tetap disajikan pipeline vite.
const db = createDatabase(resolveDatabasePath());
migrateDatabase(db);

export default createApp("dist", db);
