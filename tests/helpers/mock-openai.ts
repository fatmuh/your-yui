import { createServer, type Server } from "node:http";

// Tiruan endpoint openai-compatible lokal (R4 gratis/CI): server node:http
// yang bicara protokol chat-completions SSE. Tidak ada jaringan nyata —
// basis URL config menunjuk ke 127.0.0.1 port acak.

export type MockBehavior = "ok" | "http500" | "cut-mid-stream";

export type MockRequest = {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: string;
};

export type MockOpenAI = {
  /** Basis URL untuk config penyedia (sudah termasuk /v1, konvensi engine). */
  baseUrl: string;
  /** Provider API calls (POST /v1/chat/completions) — for assertions such as
   * the Bearer key that reached the wire. Background reachability probes the
   * engine fires at the origin (credential sync `GET /`) are excluded so
   * count/positional assertions never race them; see `probes`. */
  requests: MockRequest[];
  /** Non-API requests received (e.g. engine credential-sync reachability
   * probes) — recorded for visibility, never asserted. */
  probes: MockRequest[];
  close(): Promise<void>;
};

export type MockOpenAIOptions = {
  /** Teks balasan penuh; dipancarkan sebagai beberapa delta SSE. */
  replyText?: string;
  behavior?: MockBehavior;
  /** Jeda antar-chunk ms (default 15) — meniru laju streaming nyata. */
  chunkDelayMs?: number;
  /** bot-tool-calling: the FIRST API call emits one tool_call (finish_reason
   * "tool_calls") instead of plain text — the engine executes the tool and
   * calls again, and the follow-up call streams the normal replyText. The
   * tool arguments ride one whole delta (the engine parser accumulates
   * `function.arguments` of any size). `textBefore`, when set, streams text
   * content chunks BEFORE the tool_call — the narrating preamble of a tool
   * turn. */
  toolCall?: { name: string; arguments: Record<string, unknown>; textBefore?: string };
};

const CONTENT_CHUNK_CHARS = 12;

function chunkPayload(model: string, delta: Record<string, unknown>, finishReason: string | null) {
  return JSON.stringify({
    id: "chatcmpl-yui-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

/**
 * Satu tiruan per skenario. `ok` memancarkan replyText sebagai >= 2 delta
 * lalu finish stop; `http500` menolak dengan 500; `cut-mid-stream` memutus
 * socket setelah delta pertama.
 */
export function startMockOpenAI(options: MockOpenAIOptions = {}): Promise<MockOpenAI> {
  const replyText = options.replyText ?? "Jawaban tiruan default untuk giliran uji.";
  const behavior: MockBehavior = options.behavior ?? "ok";
  const chunkDelayMs = options.chunkDelayMs ?? 15;

  const requests: MockRequest[] = [];
  const probes: MockRequest[] = [];
  // API-call ordinal for the `toolCall` option: the scripted tool_call rides
  // the FIRST provider call only; the engine's follow-up call gets the normal
  // text stream.
  let apiCalls = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const record = {
        method: req.method,
        url: req.url,
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
      let isApiCall = false;
      if (req.method === "POST" && path === "/v1/chat/completions") {
        isApiCall = true;
        apiCalls += 1;
        requests.push(record);
      } else {
        probes.push(record);
      }

      if (behavior === "http500") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock provider failure" } }));
        return;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      const model = "mock-model";
      if (isApiCall && apiCalls === 1 && options.toolCall !== undefined) {
        // Scripted tool call: optional text preamble first, then one
        // tool_calls delta carrying the whole argument JSON, then
        // finish_reason "tool_calls" — the wire shape the engine's
        // openai-completions parser accumulates into a toolCall block.
        const tool = options.toolCall;
        if (tool.textBefore !== undefined && tool.textBefore.length > 0) {
          res.write(`data: ${chunkPayload(model, { content: tool.textBefore }, null)}\n\n`);
        }
        res.write(
          `data: ${chunkPayload(model, {
            tool_calls: [
              {
                index: 0,
                id: "call_yui_mock_1",
                type: "function",
                function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
              },
            ],
          }, null)}\n\n`,
        );
        res.write(`data: ${chunkPayload(model, {}, "tool_calls")}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      const pieces = replyText.match(new RegExp(`.{1,${CONTENT_CHUNK_CHARS}}`, "g")) ?? [replyText];
      let index = 0;
      const timer = setInterval(() => {
        if (index < pieces.length) {
          res.write(`data: ${chunkPayload(model, { content: pieces[index] }, null)}\n\n`);
          if (behavior === "cut-mid-stream" && index === 0) {
            clearInterval(timer);
            res.destroy();
            return;
          }
          index += 1;
          return;
        }
        clearInterval(timer);
        res.write(`data: ${chunkPayload(model, {}, "stop")}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }, chunkDelayMs);
      // Bersihkan timer saat KONEKSI tertutup (bukan saat body request selesai —
      // event close pada req terlalu dini di Node dan mematikan stream jawaban).
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
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
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
