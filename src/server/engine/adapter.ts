import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulidx";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { YuiDatabase } from "../db/index.ts";
import { getProviderConfigById } from "../providers/store.ts";
import { CryptoError, decryptSecret, loadEncryptionKey, maskSecret } from "../providers/crypto.ts";
import type {
  EngineAdapter,
  EngineCreateSessionInput,
  EnginePromptInput,
  EngineSession,
  YuiErrorCode,
  YuiEvent,
} from "../../shared/engine.ts";

// SATU-SATUNYA modul yang mengimpor paket engine (AD-1). Semua detail engine
// (materialisasi, normalisasi event, direktori sekali-pakai) terkurung di sini;
// kode lain hanya mengenal kontrak `src/shared/engine.ts`.
//
// AD-3: config penyedia didekripsi HANYA di sini, saat materialisasi per
// prompt. Setiap giliran membangun runtime + sesi engine baru di direktori
// temp sekali-pakai (tanpa itu engine menyentuh direktori profil asli
// pengguna di home) lalu membuangnya — tanpa cache material terdekripsi
// maupun instance provider.
//
// AD-2/AD-6: sesi engine = in-memory, dipetakan (userId, threadId) → sessionId
// di adapter. Pilihan rehidrasi v1 tertutup di sini: tidak ada replay dari DB
// (tabel threads/messages milik epic-percakapan; giliran story ini stream-only).

/** Id penyedia di models.json sekali-pakai — internal adapter. */
const PROVIDER_ID = "yui-openai";

/**
 * Konvensi baseUrl anthropic BERBEDA dari openai-completions: TANPA `/v1` —
 * SDK Anthropic menambahkan path `/v1/messages` sendiri (distilasi kode engine
 * terpasang). Endpoint default = produksi Anthropic; tes selalu menimpa baseUrl.
 */
const ANTHROPIC_PROVIDER_ID = "yui-anthropic";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
/** Model stabil saat ini; layar config epic-percakapan bisa meng-override. */
const DEFAULT_ANTHROPIC_MODEL_ID = "claude-sonnet-4-5";

/**
 * Entry provider models.json sekali-pakai hasil materialisasi per kind.
 * Murni (tanpa I/O) — bisa diasersi unit tanpa giliran nyata (matriks
 * "baseUrl null"): anthropic jatuh ke default, openai-compatible wajib lengkap.
 */
export type ProviderEntry = {
  providerId: string;
  api: "openai-completions" | "anthropic-messages";
  baseUrl: string;
  modelId: string;
};

/**
 * Pilih entry provider per `config.kind`. Null = config openai-compatible
 * tidak lengkap (baseUrl/modelId wajib untuk kind itu; kolom anthropic nullable
 * karena punya default). Custom provider id sah untuk anthropic: engine
 * merouting lewat field `api`, bukan nama penyedia.
 */
export function resolveProviderEntry(config: {
  kind: string;
  baseUrl: string | null;
  modelId: string | null;
}): ProviderEntry | null {
  if (config.kind === "anthropic") {
    return {
      providerId: ANTHROPIC_PROVIDER_ID,
      api: "anthropic-messages",
      baseUrl: config.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL,
      modelId: config.modelId ?? DEFAULT_ANTHROPIC_MODEL_ID,
    };
  }
  if (!config.baseUrl || !config.modelId) {
    return null;
  }
  return {
    providerId: PROVIDER_ID,
    api: "openai-completions",
    baseUrl: config.baseUrl,
    modelId: config.modelId,
  };
}

/** Error adapter sebelum SSE mengalir; route memetakannya ke event error+settled. */
export class EngineAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineAdapterError";
  }
}

type SessionRecord = {
  sessionId: string;
  userId: string;
  threadId: string;
  providerConfigId: string | null;
};

function pairKey(userId: string, threadId: string): string {
  return `${userId}\n${threadId}`;
}

/** Ambil teks mentah dari pesan assistant engine (blok teks saja). */
function assistantText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/** Satu baris, tanpa kredensial: bentuk aman untuk payload error AD-4. */
function sanitizeMessage(message: string, secrets: string[]): string {
  let safe = message.replace(/\s+/g, " ").trim().slice(0, 300);
  for (const secret of secrets) {
    if (secret.length > 0) {
      safe = safe.split(secret).join(maskSecret(secret));
    }
  }
  return safe;
}

export function createEngineAdapter(db: YuiDatabase): EngineAdapter {
  // Registry sesi in-memory — detail internal adapter (bukan state aplikasi),
  // hidup selama instans adapter (per app/proses).
  const sessionsByKey = new Map<string, SessionRecord>();
  const sessionsById = new Map<string, SessionRecord>();

  async function createSession(input: EngineCreateSessionInput): Promise<EngineSession> {
    const key = pairKey(input.userId, input.threadId);
    const existing = sessionsByKey.get(key);
    if (existing) {
      // Idempoten per (userId, threadId), tapi binding config di-refresh bila
      // pemanggil kini memegang config (session lama bisa lahir saat pengguna
      // belum punya config — null jangan menempel selamanya).
      if (input.providerConfigId !== null) {
        existing.providerConfigId = input.providerConfigId;
      }
      return { sessionId: existing.sessionId };
    }
    const record: SessionRecord = {
      sessionId: ulid(),
      userId: input.userId,
      threadId: input.threadId,
      providerConfigId: input.providerConfigId,
    };
    sessionsByKey.set(key, record);
    sessionsById.set(record.sessionId, record);
    return { sessionId: record.sessionId };
  }

  async function prompt(input: EnginePromptInput, onEvent: (event: YuiEvent) => void): Promise<void> {
    const record = sessionsById.get(input.sessionId);
    if (!record) {
      throw new EngineAdapterError("Unknown engine session.");
    }
    const { threadId } = record;

    let settled = false;
    const emit = onEvent;
    const settle = () => {
      if (!settled) {
        settled = true;
        emit({ type: "turn.settled", threadId });
      }
    };
    const fail = (code: YuiErrorCode, message: string) => {
      emit({ type: "error", threadId, code, message });
      settle();
    };

    // Tanpa config tersimpan (baris matriks "Tanpa config"): error tanpa
    // kredensial + turn.settled — engine tak tersentuh.
    if (record.providerConfigId === null) {
      fail("no_provider_config", "No provider configuration is stored for this account.");
      return;
    }
    const config = getProviderConfigById(db, record.userId, record.providerConfigId);
    if (!config) {
      fail("no_provider_config", "No provider configuration is stored for this account.");
      return;
    }
    // Materialisasi bercabang per kind: entry anthropic memakai default
    // baseUrl/modelId bila kolomnya null; openai-compatible wajib lengkap.
    const entry = resolveProviderEntry(config);
    if (!entry) {
      fail("engine_setup_failed", "Stored provider configuration is incomplete (missing base URL or model id).");
      return;
    }

    let tempDir: string | null = null;
    try {
      tempDir = mkdtempSync(join(tmpdir(), "yui-engine-"));

      // Direktori sekali-pakai: models.json + settings.json + auth.json tidak
      // pernah jatuh ke direktori profil engine yang asli.
      writeFileSync(
        join(tempDir, "models.json"),
        JSON.stringify({
          providers: {
            [entry.providerId]: {
              api: entry.api,
              baseUrl: entry.baseUrl,
              models: [{ id: entry.modelId }],
            },
          },
        }),
      );
      // Retry dimatikan: kegagalan provider harus surfas cepat sebagai
      // error giliran, bukan loop retry bawaan.
      writeFileSync(
        join(tempDir, "settings.json"),
        JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } }),
      );

      // Materialisasi (AD-3): KEK fail-fast, decrypt hanya di stack ini.
      let apiKey: string;
      try {
        apiKey = decryptSecret(loadEncryptionKey(), config.ciphertext);
      } catch (error) {
        const message =
          error instanceof CryptoError
            ? `Credential store unavailable: ${error.message}`
            : "Credential store unavailable.";
        fail("engine_setup_failed", message);
        return;
      }

      const runtime = await ModelRuntime.create({
        authPath: join(tempDir, "auth.json"),
        modelsPath: join(tempDir, "models.json"),
      });
      await runtime.setRuntimeApiKey(entry.providerId, apiKey);
      const model = runtime.getModel(entry.providerId, entry.modelId);
      if (!model) {
        fail("engine_setup_failed", "Stored provider configuration does not resolve to a model.");
        return;
      }

      const { session } = await createAgentSession({
        model,
        modelRuntime: runtime,
        sessionManager: SessionManager.inMemory(tempDir),
        noTools: "all",
        agentDir: tempDir,
      });

      // AD-7: set tool HARUS kosong — assert, bukan asumsi.
      if (session.getActiveToolNames().length > 0) {
        fail("engine_setup_failed", "Engine session came up with active tools; refusing to run.");
        return;
      }
      // Pertahanan defensif bila tool tiba-tiba aktif di masa depan: blokir total.
      session.agent.beforeToolCall = async () => ({
        block: true,
        terminate: true,
        reason: "Yui v1 runs with tools disabled.",
      });

      const messageId = ulid();
      let cumulative = "";
      session.subscribe((event) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          // AD-4: kumulatif — klien menerima teks penuh sejauh ini, bukan delta.
          cumulative += event.assistantMessageEvent.delta;
          emit({
            type: "message.delta",
            threadId,
            messageId,
            role: "assistant",
            text: cumulative,
          });
        } else if (event.type === "message_end" && event.message.role === "assistant") {
          // Filter role assistant saja (AD-4): engine juga memancarkan
          // message_end untuk pesan system/user/toolResult.
          if (event.message.stopReason === "error") {
            const raw =
              typeof event.message.errorMessage === "string"
                ? event.message.errorMessage
                : "The provider request failed.";
            emit({
              type: "error",
              threadId,
              code: "provider_error",
              message: sanitizeMessage(raw, [apiKey]),
            });
          } else {
            emit({
              type: "message.final",
              threadId,
              messageId,
              role: "assistant",
              clientToken: input.clientToken,
              text: assistantText(event.message.content) || cumulative,
            });
          }
        } else if (event.type === "agent_settled") {
          settle();
        }
      });

      try {
        await session.prompt(input.content);
      } catch (error) {
        const raw = error instanceof Error ? error.message : "The turn failed.";
        emit({ type: "error", threadId, code: "turn_failed", message: sanitizeMessage(raw, [apiKey]) });
      } finally {
        // Jaminan AD-4: giliran SELALU berakhir turn.settled — termasuk bila
        // event settled engine tak pernah tiba.
        settle();
        session.dispose();
      }
    } finally {
      if (tempDir !== null) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }

  return { createSession, prompt };
}
