# Yui

Yui adalah multi-bot AI teammate harness yang mandiri dan local-first: percakapan bergaya kontak obrolan, kartu aksi interaktif, dan BYOK provider dengan penyimpanan SQLite in-process.

> Repo baru diinisialisasi ulang dari nol pada 2026-11-05. Kontribusi dan dokumentasi menyusul.

## Menjalankan

Prasyarat: Node.js >= 22.19 (lihat `engines` di `package.json`).

```sh
npm install
npm run dev         # dev server vite; API /api/* ikut hidup di dev
npm run build       # build shell klien ke dist/
npm run typecheck   # tsc -b
npm test            # seluruh suite vitest
npm run db:generate # regenerasi migrasi setelah ubah skema (drizzle-kit)
node src/server/index.ts  # produksi: API + shell dist/ di PORT
```

### Environment

| Variabel | Wajib? | Default | Keterangan |
| --- | --- | --- | --- |
| `APP_ENCRYPTION_KEY` | Ya saat fitur penyedia (BYOK) dipakai | — | KEK AES-256: string base64 atau hex yang tepat 32 byte. Tanpa ini, menyimpan/membaca kredensial penyedia gagal fail-fast tanpa fallback. Contoh generate: `head -c 32 /dev/urandom \| base64`. |
| `DATA_DIR` | Tidak | `data/` | Direktori file SQLite; dibuat otomatis bila belum ada. |
| `PORT` | Tidak | `3000` | Harus bilangan bulat > 0; nilai lain (kosong, non-numerik) diabaikan dan jatuh ke default. |

### Arsitektur (ringkas)

Satu proses Node: server Hono (`src/server`) menyajikan API di bawah `/api` — sesi login berbasis cookie, config penyedia BYOK (kredensial dienkripsi AES-256-GCM at-rest dan hanya pernah keluar sebagai bentuk bermask), serta giliran percakapan engine ber-protokol SSE — dan menyajikan shell klien statis dari `dist/` hasil `npm run build`. Seluruh state hidup di satu file SQLite di `DATA_DIR`, dibuka dan dimigrasi otomatis saat boot. Engine percakapan berjalan in-process di server; kredensial penyedia didekripsi hanya sekejap saat dipakai.
