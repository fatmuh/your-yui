import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulidx";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
// AD-1 keeps this the only module naming the engine package. `tools.ts` (the
// custom-tool definitions the adapter wires in) consumes the engine's tool
// type through this type-only re-export, so the package name appears nowhere
// else in the repo.
export type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { YuiDatabase } from "../db/index.ts";
import { getProviderConfigById } from "../providers/store.ts";
import { CryptoError, decryptSecret, loadEncryptionKey, maskSecret } from "../providers/crypto.ts";
import { createYuiTools, YUI_TOOL_NAMES } from "./tools.ts";
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

/** Detail cap for tool events (Design Notes: a summary of at most 200 chars). */
const TOOL_DETAIL_MAX_CHARS = 200;

/** `tool.activity` detail for a start: the URL the model asked for, when the args carry one. */
function toolStartDetail(args: unknown): string | undefined {
  if (typeof args === "object" && args !== null && typeof (args as { url?: unknown }).url === "string") {
    return (args as { url: string }).url.replace(/\s+/g, " ").trim().slice(0, TOOL_DETAIL_MAX_CHARS);
  }
  return undefined;
}

/** `tool.activity` detail for an end: the result's text (guard reason on error), else the duration. */
function toolEndDetail(result: unknown, isError: boolean, durationMs: number | undefined): string | undefined {
  if (isError) {
    const blocks =
      typeof result === "object" && result !== null && Array.isArray((result as { content?: unknown }).content)
        ? (result as { content: Array<{ type: string; text?: unknown }> }).content
        : [];
    const textBlock = blocks.find((block) => block.type === "text" && typeof block.text === "string");
    const line = (typeof textBlock?.text === "string" ? textBlock.text : "").replace(/\s+/g, " ").trim();
    if (line.length > 0) return line.slice(0, TOOL_DETAIL_MAX_CHARS);
  }
  return durationMs === undefined ? "done" : `${durationMs}ms`;
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
      // Idempoten per (userId, threadId); binding config SELALU di-refresh
      // dari panggilan terkini, termasuk null (latest-call-wins): giliran
      // kind lain yang belum punya config tak boleh mewarisi config kind
      // sebelumnya di thread yang sama.
      existing.providerConfigId = input.providerConfigId;
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
              // `input` must include "image": the engine defaults it to
              // ["text"] and then silently swaps user images for an
              // "(image omitted...)" placeholder on non-vision models.
              models: [{ id: entry.modelId, input: ["text", "image"] }],
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
      // Multi-bot harness: the bot persona is a FULL-REPLACEMENT system
      // prompt. The engine resolves it via DefaultResourceLoader's
      // discoverSystemPromptFile(), which reads `agentDir/SYSTEM.md` — and
      // tempDir IS the agentDir passed to createAgentSession below, so this
      // one file replaces the engine's default coding-agent prompt (AD-1
      // stays intact: the seam lives entirely inside this adapter). The
      // contract guarantees a non-empty persona; an empty one would simply
      // leave the engine default in place (defensive, never expected).
      if (input.persona.trim().length > 0) {
        writeFileSync(join(tempDir, "SYSTEM.md"), input.persona);
      }

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
        // AD-7 revision (bot tool calling): built-in coding tools stay OFF —
        // only the two custom fetch tools from ./tools.ts are registered.
        noTools: "builtin",
        customTools: createYuiTools(),
        agentDir: tempDir,
      });

      // Two-layer allowlist, layer 1 — assert, don't assume: the ACTIVE set
      // must be exactly {web_fetch, view_image}. Anything else active (a
      // built-in that survived, an extension tool) refuses the whole turn.
      const activeTools = [...session.getActiveToolNames()].sort().join(",");
      const expectedTools = [...YUI_TOOL_NAMES].sort().join(",");
      if (activeTools !== expectedTools) {
        fail(
          "engine_setup_failed",
          `Engine session came up with tools [${activeTools}]; refusing to run (expected [${expectedTools}]).`,
        );
        return;
      }
      // Layer 2 — deny-only hook: allowlisted names pass, ANY other name is
      // blocked with an error result (the model sees the reason and continues).
      session.agent.beforeToolCall = async ({ toolCall }) => {
        if ((YUI_TOOL_NAMES as readonly string[]).includes(toolCall.name)) {
          return undefined;
        }
        return { block: true, reason: `Tool "${toolCall.name}" is not allowed.` };
      };

      const messageId = ulid();
      let cumulative = "";
      // Per-hop texts: each provider response of the turn contributes its own
      // entry; the FINAL assembly joins them with a paragraph break instead of
      // jamming them together.
      const hopTexts: string[] = [];
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
          } else if (event.message.stopReason === "toolUse") {
            // Tool-call turn, intermediate assistant message: the loop is about
            // to execute tools and call the provider again — this is NOT the
            // turn's final message, so no `message.final` here (tool activity
            // events stream in its place; the real final follows the last hop).
            hopTexts.push(assistantText(event.message.content));
            return;
          } else {
            hopTexts.push(assistantText(event.message.content));
            // Hop texts joined, not jammed: a narrating tool turn streams a
            // preamble hop ("Let me check that.") followed by the answer hop —
            // the persisted final keeps both, separated by a paragraph break.
            // (Streaming deltas stay cumulative by design.)
            const joined = hopTexts.filter((text) => text.length > 0).join("\n\n");
            emit({
              type: "message.final",
              threadId,
              messageId,
              role: "assistant",
              clientToken: input.clientToken,
              text: joined,
            });
          }
        } else if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
          // Tool activity (AD-4 extension): transient, pre-settle, ≤200-char
          // sanitized detail — the URL on start, the outcome text on end.
          // Page/image bodies NEVER flow here (only guard reasons and sizes).
          const detail =
            event.type === "tool_execution_start"
              ? toolStartDetail(event.args)
              : toolEndDetail(event.result, event.isError, event.durationMs);
          emit({
            type: "tool.activity",
            threadId,
            tool: event.toolName,
            phase: event.type === "tool_execution_start" ? "start" : "end",
            ...(detail === undefined ? {} : { detail }),
            ...(event.type === "tool_execution_end" && event.isError ? { isError: true } : {}),
          });
        } else if (event.type === "agent_settled") {
          settle();
        }
      });

      try {
        // Multimodal turn: engine-native image content is built HERE (AD-1 —
        // the engine's types never leak past this module).
        const promptOptions =
          input.images === undefined || input.images.length === 0
            ? undefined
            : {
                images: input.images.map((image) => ({
                  type: "image" as const,
                  data: image.data,
                  mimeType: image.mimeType,
                })),
              };
        await session.prompt(input.content, promptOptions);
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
