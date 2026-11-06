/**
 * Kontrak engine Yui (AD-1, AD-4, AD-8) — BEKU.
 *
 * Modul ini murni tipe + konstanta, tanpa logika, dan diimpor client maupun
 * server. Hanya `src/server/engine/` yang boleh mengimpor paket engine; semua
 * modul lain berbicara lewat bentuk di bawah ini. Perubahan bentuk kontrak
 * memerlukan revisi spine arsitektur.
 */

/** Jenis penyedia yang dikenal v1. Story berikutnya menambah jenis kedua. */
export type ProviderKind = "openai-compatible";

/** Giliran uji v1 = teks (placeholder audio menyusul epic-voice). */
export type TurnContent = string;

/** Input kontrak `createSession` — satu sesi engine per (userId, threadId). */
export type EngineCreateSessionInput = {
  userId: string;
  threadId: string;
  /**
   * Config penyedia yang dipakai sesi ini, atau null bila pengguna belum
   * menyimpan config — prompt kemudian gagal dengan error `no_provider_config`.
   */
  providerConfigId: string | null;
};

/** Hasil `createSession` — id sesi Yui (opaque, ULID). */
export type EngineSession = {
  sessionId: string;
};

/** Input kontrak `prompt` — satu giliran penuh. */
export type EnginePromptInput = {
  sessionId: string;
  content: TurnContent;
  /** Token dari POST klien; dibawa balik di `message.final` untuk dedup pesan optimistik. */
  clientToken?: string;
};

/**
 * Union event Yui (AD-4). Nama event = `type` (dot-lowercase) di transport SSE;
 * payload = bidang selain `type`. `error` SELALU diikuti `turn.settled`.
 */
export type YuiEvent =
  | {
      type: "message.delta";
      threadId: string;
      messageId: string;
      role: "assistant";
      /** Teks KUMULATIF sejauh ini (bukan increment) — render idempoten. */
      text: string;
    }
  | {
      type: "message.final";
      threadId: string;
      messageId: string;
      role: "assistant";
      clientToken?: string;
      /** Teks final otoritatif dari pesan assistant. */
      text: string;
    }
  | {
      type: "thread.updated";
      threadId: string;
      title?: string;
      pinned?: boolean;
      unread?: boolean;
      /** ISO-8601 UTC (konvensi API; DB menyimpan epoch-ms). */
      updated_at: string;
    }
  | {
      type: "turn.settled";
      threadId: string;
    }
  | {
      type: "error";
      threadId: string;
      code: YuiErrorCode;
      /** Pesan aman untuk klien — kredensial selalu bermask. */
      message: string;
    };

/** Kode error yang dipancarkan adapter engine v1. */
export type YuiErrorCode =
  | "no_provider_config"
  | "engine_setup_failed"
  | "provider_error"
  | "turn_failed";

/** Kontrak pemanggilan adapter (AD-1) — implementasi hidup di `src/server/engine/`. */
export type EngineAdapter = {
  /** Daftarkan sesi engine untuk (userId, threadId); idempoten per pasangan. */
  createSession(input: EngineCreateSessionInput): Promise<EngineSession>;
  /**
   * Jalankan SATU giliran penuh: materialisasi config (decrypt per prompt,
   * AD-3), streaming event ke sink, dan selalu berakhir `turn.settled`.
   * Promise selesai saat giliran selesai.
   */
  prompt(input: EnginePromptInput, onEvent: (event: YuiEvent) => void): Promise<void>;
};
