import { createServer, type Server } from "node:http";

// Tiruan endpoint Anthropic lokal (R4 gratis/CI): server node:http yang
// bicara protokol anthropic-messages SSE — wire format diverifikasi dari kode
// engine terpasang (dist/api/anthropic-messages.js): SDK Anthropic
// men-POST {baseUrl}/v1/messages (baseUrl TANPA /v1 — beda konvensi
// openai-completions yang menyertakan /v1), auth header `x-api-key`, SSE
// bernama-event. Tidak ada jaringan nyata — baseUrl config menunjuk ke
// 127.0.0.1 port acak.

export type MockBehavior = "ok" | "http500" | "cut-before-message-stop";

export type MockRequest = {
  method: string | undefined;
  url: string | undefined;
  /** Nilai header `x-api-key` (digabung bila dikirim berkali-kali). */
  apiKeyHeader: string | undefined;
  authorization: string | undefined;
  body: string;
};

export type MockAnthropic = {
  /** Basis URL untuk config penyedia — TANPA /v1; SDK menambahkan path-nya. */
  baseUrl: string;
  /** Provider API calls (POST /v1/messages) — for assertions such as the
   * x-api-key header that reached the wire. Background reachability probes
   * the engine fires at the origin (credential sync `GET /`) are excluded so
   * count/positional assertions never race them; see `probes`. */
  requests: MockRequest[];
  /** Non-API requests received (e.g. engine credential-sync reachability
   * probes) — recorded for visibility, never asserted. */
  probes: MockRequest[];
  close(): Promise<void>;
};

export type MockAnthropicOptions = {
  /** Teks balasan penuh; dipancarkan sebagai beberapa text_delta SSE. */
  replyText?: string;
  behavior?: MockBehavior;
  /** Jeda antar-event ms (default 15) — meniru laju streaming nyata. */
  chunkDelayMs?: number;
};

const CONTENT_CHUNK_CHARS = 12;

function sseFrame(eventName: string, payload: Record<string, unknown>): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Satu tiruan per skenario. `ok` memancarkan enam event SSE bernama yang
 * diterima engine (message_start, content_block_start, content_block_delta
 * per-potong teks, content_block_stop, message_delta, message_stop);
 * `http500` menolak dengan 500; `cut-before-message-stop` mengakhiri stream
 * setelah delta pertama TANPA message_stop → engine error "stream ended
 * before message_stop" (jalur error→settled normal).
 */
export function startMockAnthropic(options: MockAnthropicOptions = {}): Promise<MockAnthropic> {
  const replyText = options.replyText ?? "Jawaban tiruan default untuk giliran uji.";
  const behavior: MockBehavior = options.behavior ?? "ok";
  const chunkDelayMs = options.chunkDelayMs ?? 15;

  const requests: MockRequest[] = [];
  const probes: MockRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const rawApiKey = req.headers["x-api-key"];
      const record = {
        method: req.method,
        url: req.url,
        apiKeyHeader: Array.isArray(rawApiKey) ? rawApiKey.join(",") : rawApiKey,
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      // Only provider API calls belong in `requests`: the engine's credential
      // sync fires a background `GET /` reachability probe at the origin on
      // every turn, and assertions on counts/positions must not race it.
      // The path is compared query-stripped and exact so a future SDK query
      // suffix cannot misfile a real call, and sub-paths (e.g. count_tokens)
      // stay out.
      const path = (req.url ?? "").split("?")[0]!;
      if (req.method === "POST" && path === "/v1/messages") {
        requests.push(record);
      } else {
        probes.push(record);
      }

      if (behavior === "http500") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "mock provider failure" } }));
        return;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      // message_start: engine membaca id/model/usage dari sini.
      res.write(
        sseFrame("message_start", {
          type: "message_start",
          message: {
            id: "msg_yui_mock",
            type: "message",
            role: "assistant",
            model: "mock-anthropic-model",
            usage: { input_tokens: 12, output_tokens: 0 },
          },
        }),
      );
      res.write(
        sseFrame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      );

      const pieces = replyText.match(new RegExp(`.{1,${CONTENT_CHUNK_CHARS}}`, "g")) ?? [replyText];
      let index = 0;
      const timer = setInterval(() => {
        if (index < pieces.length) {
          res.write(
            sseFrame("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: pieces[index] },
            }),
          );
          if (behavior === "cut-before-message-stop" && index === 0) {
            // Stream berakhir TANPA content_block_stop/message_delta/
            // message_stop — engine menolak: "stream ended before
            // message_stop" (jalur error→settled normal).
            clearInterval(timer);
            res.end();
            return;
          }
          index += 1;
          return;
        }
        clearInterval(timer);
        res.write(sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }));
        res.write(
          sseFrame("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: replyText.length },
          }),
        );
        res.write(sseFrame("message_stop", { type: "message_stop" }));
        res.end();
      }, chunkDelayMs);
      // Bersihkan timer saat KONEKSI tertutup (event close pada req selesai
      // terlalu dini di Node dan mematikan stream jawaban).
      res.on("close", () => clearInterval(timer));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("mock server: unexpected listen address");
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        probes,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
            server.closeAllConnections();
          }),
      });
    });
  });
}
