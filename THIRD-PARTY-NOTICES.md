# Third-Party Notices

Atribusi pihak ketiga yang bibliundel ke artefak Yui. Dipelihara per epik yang
memasang dependensi (spine: kewajiban atribusi). File `LICENSE` di dalam
`node_modules` tidak pernah dibuang oleh repo ini.

## Engine agent (dipasang epic-penyedia, pin eksak)

Yui menyematkan engine agent sebagai library di balik satu modul adapter
(`src/server/engine/`). Paket berikut dan penerbitnya dilisensikan MIT
(hak cipta Mario Zechner / earendil-works, 2025). Mayoritas paket membawa
designasi MIT hanya lewat field `license` di `package.json`; teks lisensi
lengkap tersedia di repositori hulunya:

| Paket koordinat | Versi | Lisensi |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent` | 1.5.0 | MIT |
| `@earendil-works/pi-agent-core` | 1.5.0 | MIT |
| `@earendil-works/pi-ai` | 1.5.0 | MIT |
| `@earendil-works/pi-codemode` | 1.5.0 | MIT |
| `@earendil-works/pi-mcp` | 1.5.0 | MIT |
| `@earendil-works/pi-schema` | 1.5.0 | MIT |
| `@earendil-works/pi-telemetry` | 1.5.0 | MIT |
| `@earendil-works/pi-tui` | 1.5.0 | MIT |

Ringkasan MIT: izin tanpa biaya untuk memakai, menyalin, memodifikasi, dan
mendistribusikan perangkat lunak, dengan syarat pemberitahuan hak cipta dan
izin ini disertakan pada semua salinan atau bagian substansial. Perangkat lunak
disediakan "SEBAGAIMANA ADANYA", tanpa jaminan apa pun.

Versi engine dipin eksak dan bump wajib membaca release notes (AD-1); daftar
di atas diperbarui saat versi berubah.
