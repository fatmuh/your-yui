import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createBot,
  deleteBot,
  deleteProviderConfig,
  fetchMe,
  fetchThreadMessages,
  getProviderConfig,
  listBots,
  listThreads,
  loginUser,
  logoutUser,
  putProviderConfig,
  registerUser,
  resolveActiveKind,
  streamTurn,
  uploadAudioNote,
} from "./api.ts";
import { applyTurnEventToConversations, historyToClientMessages } from "./TemplateApp.tsx";
import type { Conversation, TurnState } from "./TemplateApp.tsx";
import type { MessageDto } from "../shared/app.ts";
import type { ProviderKind, YuiEvent } from "../shared/engine.ts";

// Wrapper API diuji dengan fetch global di-stub (vi.stubGlobal) — tanpa server
// dan tanpa deps test baru. Response global Node dipakai untuk membangun
// respons stub.

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Stub fetch global; satu respons dipakai untuk semua pemanggilan. */
function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn();
  mock.mockResolvedValue(response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

/**
 * Stub fetch global with one response per URL — for tests that fire parallel
 * GETs (resolveActiveKind). Each response is consumed exactly once.
 */
function stubFetchByUrl(routes: Record<string, Response>): ReturnType<typeof vi.fn> {
  const mock = vi.fn((url: string) => {
    const response = routes[url];
    if (response === undefined) throw new Error(`Unexpected fetch URL: ${url}`);
    return Promise.resolve(response);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** Argumen pemanggilan fetch pertama sebagai [url, init]. */
function firstCall(mock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  const [url, init] = mock.mock.calls[0] as [string, RequestInit];
  return [url, init];
}

/** Encode one SSE frame the way Hono streamSSE writes it. */
function sseFrame(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Build a 200 text/event-stream Response that emits the frames, then closes. */
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("registerUser", () => {
  it("memanggil POST /api/auth/register dengan body JSON {username,password} → user", async () => {
    const mock = stubFetch(jsonResponse({ id: "01JCTESTTESTTESTTESTTESTTE", username: "arjuna" }, 201));

    const user = await registerUser("arjuna", "password-tepat");

    expect(user).toEqual({ id: "01JCTESTTESTTESTTESTTESTTE", username: "arjuna" });
    const [url, init] = firstCall(mock);
    expect(url).toBe("/api/auth/register");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({
      username: "arjuna",
      password: "password-tepat",
    });
  });

  it("envelope 409 username_taken → ApiError bermuatan code+message envelope", async () => {
    stubFetch(
      jsonResponse(
        { error: { code: "username_taken", message: "Username is already taken." } },
        409,
      ),
    );

    await expect(registerUser("arjuna", "password-tepat")).rejects.toMatchObject({
      name: "ApiError",
      code: "username_taken",
      message: "Username is already taken.",
    });
  });
});

describe("loginUser", () => {
  it("memanggil POST /api/auth/login dengan body JSON → user", async () => {
    const mock = stubFetch(jsonResponse({ id: "01JCTESTTESTTESTTESTTESTTE", username: "arjuna" }));

    const user = await loginUser("arjuna", "password-tepat");

    expect(user).toEqual({ id: "01JCTESTTESTTESTTESTTESTTE", username: "arjuna" });
    const [url, init] = firstCall(mock);
    expect(url).toBe("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      username: "arjuna",
      password: "password-tepat",
    });
  });

  it("envelope 401 invalid_credentials → ApiError dengan pesan envelope", async () => {
    stubFetch(
      jsonResponse(
        { error: { code: "invalid_credentials", message: "Invalid username or password." } },
        401,
      ),
    );

    // Satu pemanggilan: body Response hanya bisa dibaca sekali oleh wrapper.
    const caught = await loginUser("arjuna", "password-salah").then(
      () => {
        throw new Error("loginUser expected to reject");
      },
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({
      code: "invalid_credentials",
      message: "Invalid username or password.",
    });
  });
});

describe("logoutUser", () => {
  it("memanggil POST /api/auth/logout (tanpa body) dan selesai pada 204", async () => {
    const mock = stubFetch(new Response(null, { status: 204 }));

    await expect(logoutUser()).resolves.toBeUndefined();

    const [url, init] = firstCall(mock);
    expect(url).toBe("/api/auth/logout");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });
});

describe("fetchMe", () => {
  it("memanggil GET /api/me → user dengan createdAt ISO", async () => {
    const mock = stubFetch(
      jsonResponse({
        id: "01JCTESTTESTTESTTESTTESTTE",
        username: "arjuna",
        createdAt: "2026-11-06T10:00:00.000Z",
      }),
    );

    const user = await fetchMe();

    expect(user).toEqual({
      id: "01JCTESTTESTTESTTESTTESTTE",
      username: "arjuna",
      createdAt: "2026-11-06T10:00:00.000Z",
    });
    // GET tanpa init — cookie sesi ikut lewat default same-origin.
    expect(mock).toHaveBeenCalledWith("/api/me");
  });

  it("envelope 401 unauthorized → ApiError unauthorized", async () => {
    stubFetch(
      jsonResponse(
        { error: { code: "unauthorized", message: "A valid session is required." } },
        401,
      ),
    );

    await expect(fetchMe()).rejects.toMatchObject({
      code: "unauthorized",
      message: "A valid session is required.",
    });
  });
});

describe("respons gagal tanpa envelope", () => {
  it("502 body non-JSON → ApiError code unknown dengan status di message", async () => {
    stubFetch(new Response("Bad Gateway", { status: 502 }));

    await expect(fetchMe()).rejects.toMatchObject({
      name: "ApiError",
      code: "unknown",
      message: expect.stringContaining("502"),
    });
  });

  it("500 body JSON tanpa bentuk error → ApiError unknown", async () => {
    stubFetch(jsonResponse({ unexpected: "shape" }, 500));

    await expect(fetchMe()).rejects.toMatchObject({ code: "unknown" });
  });
});

const THREAD_A = "01JCTHREADTHREADTHREADTHRE01";
const THREAD_B = "01JCTHREADTHREADTHREADTHRE02";

describe("listThreads", () => {
  it("calls GET /api/threads and returns the ThreadDto array unchanged", async () => {
    const threads = [
      {
        id: THREAD_B,
        title: "Budget review",
        createdAt: "2026-11-07T09:00:00.000Z",
        updatedAt: "2026-11-07T09:05:00.000Z",
      },
      {
        id: THREAD_A,
        title: "Hello",
        createdAt: "2026-11-06T08:00:00.000Z",
        updatedAt: "2026-11-06T08:01:00.000Z",
      },
    ];
    const mock = stubFetch(jsonResponse(threads));

    await expect(listThreads()).resolves.toEqual(threads);
    // GET without init — the session cookie rides the same-origin default.
    expect(mock).toHaveBeenCalledWith("/api/threads");
  });

  it("401 envelope → ApiError unauthorized", async () => {
    stubFetch(
      jsonResponse(
        { error: { code: "unauthorized", message: "A valid session is required." } },
        401,
      ),
    );

    await expect(listThreads()).rejects.toMatchObject({
      name: "ApiError",
      code: "unauthorized",
      message: "A valid session is required.",
    });
  });
});

describe("fetchThreadMessages", () => {
  it("calls GET /api/threads/:id/messages and returns the MessageDto array unchanged", async () => {
    const messages = [
      {
        id: "01JCMESSAGEMESSAGEMESSAGEME01",
        role: "user",
        text: "Draft a budget",
        createdAt: "2026-11-07T09:00:00.000Z",
      },
      {
        id: "01JCMESSAGEMESSAGEMESSAGEME02",
        role: "assistant",
        text: "Here is a first pass.",
        createdAt: "2026-11-07T09:00:05.000Z",
      },
    ];
    const mock = stubFetch(jsonResponse(messages));

    await expect(fetchThreadMessages(THREAD_A)).resolves.toEqual(messages);
    expect(mock).toHaveBeenCalledWith(`/api/threads/${THREAD_A}/messages`);
  });

  it("404 envelope for a foreign or missing thread → ApiError not_found", async () => {
    stubFetch(
      jsonResponse({ error: { code: "not_found", message: "Thread not found." } }, 404),
    );

    await expect(fetchThreadMessages(THREAD_B)).rejects.toMatchObject({
      name: "ApiError",
      code: "not_found",
      message: "Thread not found.",
    });
  });
});

describe("historyToClientMessages", () => {
  const VOICE_ID = "01JCVOICEVOICEVOICEVOICEVO01";

  it("maps a voice DTO to a playable client message (encoded URL + seconds duration)", () => {
    const dto: MessageDto = {
      id: "01JCMESSAGEMESSAGEMESSAGEME03",
      role: "user",
      text: "Voice note · 0:42",
      audio: { id: VOICE_ID, mime: "audio/webm;codecs=opus", durationMs: 42000 },
      createdAt: "2026-11-07T09:00:00.000Z",
    };

    const [message] = historyToClientMessages([dto]);

    // id/role/text pass through unchanged, and the DTO's ms duration lands as
    // client seconds (42000 → 42) with the audio id in the playback URL.
    expect(message).toEqual({
      id: dto.id,
      role: dto.role,
      text: dto.text,
      audio: { url: `/api/audio/${VOICE_ID}`, duration: 42 },
    });
  });

  it("omits the audio property entirely for a text-only DTO", () => {
    const dto: MessageDto = {
      id: "01JCMESSAGEMESSAGEMESSAGEME04",
      role: "assistant",
      text: "Here is a first pass.",
      createdAt: "2026-11-07T09:00:05.000Z",
    };

    const [message] = historyToClientMessages([dto]);

    expect(message).not.toHaveProperty("audio");
    expect(message).toEqual({ id: dto.id, role: dto.role, text: dto.text });
  });

  it("URI-encodes audio ids that contain reserved path characters", () => {
    const dto: MessageDto = {
      id: "01JCMESSAGEMESSAGEMESSAGEME05",
      role: "user",
      text: "Voice note · 0:03",
      audio: { id: "ab/cd%ef", mime: "audio/webm", durationMs: 3000 },
      createdAt: "2026-11-07T09:00:10.000Z",
    };

    const [message] = historyToClientMessages([dto]);

    expect(message.audio?.url).toBe("/api/audio/ab%2Fcd%25ef");
  });

  it("returns an empty array for empty history", () => {
    expect(historyToClientMessages([])).toEqual([]);
  });
});

describe("applyTurnEventToConversations", () => {
  it("thread-creating thread.updated migrates the placeholder id and the display name stays the BOT's name", () => {
    // A bot conversation before its first turn: local placeholder id
    // `bot:<botId>`, optimistic user bubble already in the transcript.
    const placeholder: Conversation = {
      id: "bot:01JBOTPLACEHOLDERBOT000001",
      botId: "01JBOTPLACEHOLDERBOT000001",
      botName: "Chef",
      messages: [{ id: "m-optimistic", role: "user", text: "What is for dinner?" }],
    };
    const turn: TurnState = { chatId: placeholder.id };
    const event: YuiEvent = {
      type: "thread.updated",
      threadId: "01JTHREADSERVERTHREAD0001",
      title: "Some derived title",
      updated_at: "2026-11-07T10:00:00.000Z",
    };

    const result = applyTurnEventToConversations([placeholder], turn, event);

    // The placeholder row is REPLACED by a server-backed row under the thread
    // id, marked loaded (its local transcript already IS the thread history).
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0].id).toBe(event.threadId);
    expect(result.conversations[0].server).toBe(true);
    expect(result.conversations[0].loaded).toBe(true);
    expect(result.conversations[0].messages).toEqual(placeholder.messages);
    // I/O matrix "display name stays the bot's name": botName is unchanged
    // and the derived title is NEVER adopted — no title-derived field is set
    // on the conversation.
    expect(result.conversations[0].botName).toBe("Chef");
    expect(result.conversations[0]).not.toHaveProperty("title");
    // The turn learns the thread id for the rest of the stream.
    expect(result.turn.chatId).toBe(placeholder.id);
    expect(result.turn.threadId).toBe(event.threadId);
  });
});

const OPENAI_CONFIG_DTO = {
  kind: "openai-compatible",
  baseUrl: "https://api.example.com/v1",
  modelId: "gpt-test",
  maskedHint: "sk-…abcd",
  createdAt: "2026-11-07T09:00:00.000Z",
  updatedAt: "2026-11-07T09:00:00.000Z",
};

const ANTHROPIC_CONFIG_DTO = {
  kind: "anthropic",
  baseUrl: null,
  modelId: null,
  maskedHint: "sk-…wxyz",
  createdAt: "2026-11-07T09:10:00.000Z",
  updatedAt: "2026-11-07T09:10:00.000Z",
};

/** Fresh 404 envelope per call — a Response body can only be read once, so a
 * shared const would break every test after its first consumer. */
function notStoredResponse(): Response {
  return jsonResponse(
    { error: { code: "not_found", message: "No provider configuration is stored for this kind." } },
    404,
  );
}

describe("getProviderConfig", () => {
  it("calls GET /api/provider-configs/:kind and returns the ProviderConfigDto unchanged", async () => {
    const mock = stubFetch(jsonResponse(OPENAI_CONFIG_DTO));

    await expect(getProviderConfig("openai-compatible")).resolves.toEqual(OPENAI_CONFIG_DTO);
    // GET without init — the session cookie rides the same-origin default.
    expect(mock).toHaveBeenCalledWith("/api/provider-configs/openai-compatible");
  });

  it("404 envelope when nothing is stored → ApiError not_found", async () => {
    stubFetch(notStoredResponse());

    await expect(getProviderConfig("anthropic")).rejects.toMatchObject({
      name: "ApiError",
      code: "not_found",
      message: "No provider configuration is stored for this kind.",
    });
  });
});

describe("putProviderConfig", () => {
  it("sends PUT with the config body and returns the masked view", async () => {
    const mock = stubFetch(jsonResponse(OPENAI_CONFIG_DTO));

    const config = await putProviderConfig("openai-compatible", {
      apiKey: "sk-live-openai-1111aaaa",
      baseUrl: "https://api.example.com/v1",
      modelId: "gpt-test",
    });

    expect(config).toEqual(OPENAI_CONFIG_DTO);
    const [url, init] = firstCall(mock);
    expect(url).toBe("/api/provider-configs/openai-compatible");
    expect(init.method).toBe("PUT");
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({
      apiKey: "sk-live-openai-1111aaaa",
      baseUrl: "https://api.example.com/v1",
      modelId: "gpt-test",
    });
  });

  it("omits absent optional fields from the JSON body (anthropic key-only save)", async () => {
    const mock = stubFetch(jsonResponse(ANTHROPIC_CONFIG_DTO));

    await putProviderConfig("anthropic", { apiKey: "sk-live-anthropic-2222bbbb" });

    const [url, init] = firstCall(mock);
    expect(url).toBe("/api/provider-configs/anthropic");
    expect(JSON.parse(String(init.body))).toStrictEqual({ apiKey: "sk-live-anthropic-2222bbbb" });
  });

  it("400 invalid_request envelope → ApiError with the server message", async () => {
    stubFetch(
      jsonResponse(
        { error: { code: "invalid_request", message: 'Provider kind "openai-compatible" requires both "baseUrl" and "modelId".' } },
        400,
      ),
    );

    await expect(
      putProviderConfig("openai-compatible", { apiKey: "sk-live-openai-1111aaaa" }),
    ).rejects.toMatchObject({
      name: "ApiError",
      code: "invalid_request",
      message: 'Provider kind "openai-compatible" requires both "baseUrl" and "modelId".',
    });
  });
});

describe("deleteProviderConfig", () => {
  it("sends DELETE and resolves on 204", async () => {
    const mock = stubFetch(new Response(null, { status: 204 }));

    await expect(deleteProviderConfig("anthropic")).resolves.toBeUndefined();

    const [url, init] = firstCall(mock);
    expect(url).toBe("/api/provider-configs/anthropic");
    expect(init.method).toBe("DELETE");
  });

  it("404 envelope when nothing is stored → ApiError not_found", async () => {
    stubFetch(notStoredResponse());

    await expect(deleteProviderConfig("openai-compatible")).rejects.toMatchObject({
      name: "ApiError",
      code: "not_found",
      message: "No provider configuration is stored for this kind.",
    });
  });
});

describe("resolveActiveKind", () => {
  it("prefers openai-compatible when both kinds are stored", async () => {
    const mock = stubFetchByUrl({
      "/api/provider-configs/openai-compatible": jsonResponse(OPENAI_CONFIG_DTO),
      "/api/provider-configs/anthropic": jsonResponse(ANTHROPIC_CONFIG_DTO),
    });

    await expect(resolveActiveKind()).resolves.toBe("openai-compatible");
    // Two parallel GETs — one per kind.
    expect(mock).toHaveBeenCalledWith("/api/provider-configs/openai-compatible");
    expect(mock).toHaveBeenCalledWith("/api/provider-configs/anthropic");
  });

  it("returns anthropic when only anthropic is stored", async () => {
    stubFetchByUrl({
      "/api/provider-configs/openai-compatible": notStoredResponse(),
      "/api/provider-configs/anthropic": jsonResponse(ANTHROPIC_CONFIG_DTO),
    });

    await expect(resolveActiveKind()).resolves.toBe("anthropic");
  });

  it("returns null when neither kind is stored", async () => {
    stubFetchByUrl({
      "/api/provider-configs/openai-compatible": notStoredResponse(),
      "/api/provider-configs/anthropic": notStoredResponse(),
    });

    await expect(resolveActiveKind()).resolves.toBeNull();
  });

  it("propagates a failure other than not_found (401 unauthorized)", async () => {
    stubFetchByUrl({
      "/api/provider-configs/openai-compatible": jsonResponse(
        { error: { code: "unauthorized", message: "A valid session is required." } },
        401,
      ),
      "/api/provider-configs/anthropic": notStoredResponse(),
    });

    await expect(resolveActiveKind()).rejects.toMatchObject({
      name: "ApiError",
      code: "unauthorized",
      message: "A valid session is required.",
    });
  });
});

const AUDIO_ID = "01JCAUDIOAUDIOAUDIOAUDIOAU01";

const BOT_DTO = {
  id: "01JCBOTBOTBOTBOTBOTBOTBOT01",
  name: "Chef",
  persona: "You are a laconic chef.",
  createdAt: "2026-11-07T09:00:00.000Z",
};

describe("listBots", () => {
  it("calls GET /api/bots and returns the BotDto array unchanged (creation order)", async () => {
    const mock = stubFetch(jsonResponse([BOT_DTO]));

    await expect(listBots()).resolves.toEqual([BOT_DTO]);
    // GET without init — the session cookie rides the same-origin default.
    expect(mock).toHaveBeenCalledWith("/api/bots");
  });

  it("401 envelope → ApiError unauthorized", async () => {
    stubFetch(
      jsonResponse(
        { error: { code: "unauthorized", message: "A valid session is required." } },
        401,
      ),
    );

    await expect(listBots()).rejects.toMatchObject({
      name: "ApiError",
      code: "unauthorized",
      message: "A valid session is required.",
    });
  });
});

describe("createBot", () => {
  it("posts {name,persona} to /api/bots and returns the 201 BotDto", async () => {
    const mock = stubFetch(jsonResponse(BOT_DTO, 201));

    const created = await createBot({ name: "Chef", persona: BOT_DTO.persona });

    expect(created).toEqual(BOT_DTO);
    const [url, init] = firstCall(mock);
    expect(url).toBe("/api/bots");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Chef",
      persona: BOT_DTO.persona,
    });
  });

  it("omits the persona key entirely when the caller provides none", async () => {
    const mock = stubFetch(jsonResponse({ ...BOT_DTO, persona: "" }, 201));

    await createBot({ name: "Chef" });

    const [, init] = firstCall(mock);
    // The server treats an absent persona as "default persona at prompt time";
    // the body never carries persona: null/"".
    expect(JSON.parse(String(init.body))).toStrictEqual({ name: "Chef" });
  });

  it("400 invalid_request envelope (empty name) → ApiError with the server message", async () => {
    stubFetch(
      jsonResponse(
        {
          error: {
            code: "invalid_request",
            message: '"name" must be a non-empty string of at most 64 characters.',
          },
        },
        400,
      ),
    );

    await expect(createBot({ name: "   " })).rejects.toMatchObject({
      name: "ApiError",
      code: "invalid_request",
      message: '"name" must be a non-empty string of at most 64 characters.',
    });
  });
});

describe("deleteBot", () => {
  it("sends DELETE /api/bots/:id and resolves on 204 (server cascades the threads)", async () => {
    const mock = stubFetch(new Response(null, { status: 204 }));

    await expect(deleteBot(BOT_DTO.id)).resolves.toBeUndefined();

    const [url, init] = firstCall(mock);
    expect(url).toBe(`/api/bots/${BOT_DTO.id}`);
    expect(init.method).toBe("DELETE");
  });

  it("404 envelope for a foreign or unknown bot → ApiError not_found", async () => {
    stubFetch(
      jsonResponse({ error: { code: "not_found", message: "Bot not found." } }, 404),
    );

    await expect(deleteBot(BOT_DTO.id)).rejects.toMatchObject({
      name: "ApiError",
      code: "not_found",
      message: "Bot not found.",
    });
  });
});

describe("uploadAudioNote", () => {
  it("posts multipart FormData (audio file + durationMs) to /api/audio and returns the stored view", async () => {
    const mock = stubFetch(
      jsonResponse(
        { id: AUDIO_ID, mime: "audio/webm;codecs=opus", durationMs: 3000 },
        201,
      ),
    );
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], {
      type: "audio/webm;codecs=opus",
    });

    const uploaded = await uploadAudioNote(blob, 3000);

    expect(uploaded).toEqual({
      id: AUDIO_ID,
      mime: "audio/webm;codecs=opus",
      durationMs: 3000,
    });
    const [url, init] = firstCall(mock);
    expect(url).toBe("/api/audio");
    expect(init.method).toBe("POST");
    // Multipart, not JSON: the browser sets the content-type with the boundary.
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers).toBeUndefined();
    const form = init.body as FormData;
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    // The blob's content type rides along — only the recording browser knows
    // the codec, so the server stores it verbatim.
    expect((file as File).type).toBe("audio/webm;codecs=opus");
    expect((file as File).size).toBe(4);
    expect(form.get("durationMs")).toBe("3000");
  });

  it("413 envelope → ApiError payload_too_large", async () => {
    stubFetch(
      jsonResponse(
        { error: { code: "payload_too_large", message: "Audio upload exceeds the 5 MB limit." } },
        413,
      ),
    );
    const blob = new Blob([new Uint8Array([1])], { type: "audio/webm" });

    await expect(uploadAudioNote(blob, 1000)).rejects.toMatchObject({
      name: "ApiError",
      code: "payload_too_large",
      message: "Audio upload exceeds the 5 MB limit.",
    });
  });

  it("401 envelope → ApiError unauthorized", async () => {
    stubFetch(
      jsonResponse(
        { error: { code: "unauthorized", message: "A valid session is required." } },
        401,
      ),
    );
    const blob = new Blob([new Uint8Array([1])], { type: "audio/webm" });

    await expect(uploadAudioNote(blob, 1000)).rejects.toMatchObject({
      name: "ApiError",
      code: "unauthorized",
      message: "A valid session is required.",
    });
  });
});

describe("streamTurn", () => {
  it("posts {content,clientToken} with no threadId key for a new thread and dispatches events in stream order", async () => {
    const mock = stubFetch(
      sseResponse([
        sseFrame("thread.updated", {
          threadId: THREAD_A,
          title: "Hello",
          updated_at: "2026-11-07T10:00:00.000Z",
        }),
        sseFrame("message.delta", {
          threadId: THREAD_A,
          messageId: "01JCMESSAGEMESSAGEMESSAGEME01",
          role: "assistant",
          text: "Hel",
        }),
        sseFrame("message.delta", {
          threadId: THREAD_A,
          messageId: "01JCMESSAGEMESSAGEMESSAGEME01",
          role: "assistant",
          text: "Hello",
        }),
        sseFrame("message.final", {
          threadId: THREAD_A,
          messageId: "01JCMESSAGEMESSAGEMESSAGEME01",
          role: "assistant",
          clientToken: "01JCTOKENTOKENTOKENTOKENTOK01",
          text: "Hello!",
        }),
        sseFrame("turn.settled", { threadId: THREAD_A }),
      ]),
    );
    const events: YuiEvent[] = [];

    await streamTurn(
      // threadId is passed explicitly as undefined, mirroring the production
      // call in sendServerMessage (which always sets the key) — so the strict
      // body assertion below proves the serializer drops the key instead of
      // ever emitting "threadId": null (a guaranteed 400 server-side).
      { content: "Hello", threadId: undefined, clientToken: "01JCTOKENTOKENTOKENTOKENTOK01" },
      event => {
        events.push(event);
      },
    );

    expect(events.map(event => event.type)).toEqual([
      "thread.updated",
      "message.delta",
      "message.delta",
      "message.final",
      "turn.settled",
    ]);
    expect(events[0]).toMatchObject({
      type: "thread.updated",
      threadId: THREAD_A,
      title: "Hello",
    });
    expect(events[4]).toMatchObject({ type: "turn.settled", threadId: THREAD_A });
    const [url, init] = firstCall(mock);
    expect(url).toBe("/api/engine/turn");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      accept: "text/event-stream",
    });
    expect(JSON.parse(String(init.body))).toStrictEqual({
      content: "Hello",
      clientToken: "01JCTOKENTOKENTOKENTOKENTOK01",
    });
  });

  it("includes threadId in the JSON body for an existing thread", async () => {
    const mock = stubFetch(sseResponse([sseFrame("turn.settled", { threadId: THREAD_A })]));

    await streamTurn({ content: "Next turn", threadId: THREAD_A }, () => undefined);

    const [, init] = firstCall(mock);
    expect(JSON.parse(String(init.body))).toStrictEqual({
      content: "Next turn",
      threadId: THREAD_A,
    });
  });

  it("sends botId for a new-thread turn and drops the key when it resolves undefined", async () => {
    const mock = stubFetch(sseResponse([sseFrame("turn.settled", { threadId: THREAD_A })]));

    await streamTurn(
      // Mirrors the production call for a bot placeholder conversation: the
      // thread does not exist yet, so the turn names the bot instead.
      { content: "Hello", threadId: undefined, botId: BOT_DTO.id },
      () => undefined,
    );

    const [, init] = firstCall(mock);
    expect(JSON.parse(String(init.body))).toStrictEqual({
      content: "Hello",
      botId: BOT_DTO.id,
    });

    const dropped = stubFetch(sseResponse([sseFrame("turn.settled", { threadId: THREAD_A })]));
    // Mirrors the production call for a server conversation: the thread's own
    // bot governs, so botId resolves undefined — the serializer must drop the
    // key (a "botId": null would be a guaranteed 400 server-side).
    const resolved: string | undefined = undefined;
    await streamTurn({ content: "Next turn", threadId: THREAD_A, botId: resolved }, () => undefined);
    const [, secondInit] = firstCall(dropped);
    expect(JSON.parse(String(secondInit.body))).toStrictEqual({
      content: "Next turn",
      threadId: THREAD_A,
    });
  });

  it("includes kind in the JSON body when a provider kind is given, and drops it when null resolves", async () => {
    const mock = stubFetch(sseResponse([sseFrame("turn.settled", { threadId: THREAD_A })]));

    await streamTurn({ content: "Next turn", threadId: THREAD_A, kind: "anthropic" }, () => undefined);

    const [, init] = firstCall(mock);
    expect(JSON.parse(String(init.body))).toStrictEqual({
      content: "Next turn",
      threadId: THREAD_A,
      kind: "anthropic",
    });

    const nullKind = stubFetch(sseResponse([sseFrame("turn.settled", { threadId: THREAD_A })]));
    // Mirrors the production call in sendServerMessage: kind ?? undefined —
    // the serializer must drop the key, never emit "kind": null.
    const resolved: ProviderKind | null = null;
    await streamTurn({ content: "Next turn", threadId: THREAD_A, kind: resolved ?? undefined }, () => undefined);
    const [, secondInit] = firstCall(nullKind);
    expect(JSON.parse(String(secondInit.body))).toStrictEqual({
      content: "Next turn",
      threadId: THREAD_A,
    });
  });

  it("sends audioId with no content key for a voice turn", async () => {
    const mock = stubFetch(sseResponse([sseFrame("turn.settled", { threadId: THREAD_A })]));

    await streamTurn(
      { audioId: AUDIO_ID, threadId: THREAD_A, clientToken: "01JCTOKENTOKENTOKENTOKENTOK01" },
      () => undefined,
    );

    const [, init] = firstCall(mock);
    // The server enforces content XOR audioId: the serialized body carries the
    // audio id and no content key at all (never null, never "").
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toStrictEqual({
      audioId: AUDIO_ID,
      threadId: THREAD_A,
      clientToken: "01JCTOKENTOKENTOKENTOKENTOK01",
    });
    expect("content" in body).toBe(false);
  });

  it("rejects with the envelope ApiError on a pre-stream 4xx response", async () => {
    stubFetch(
      jsonResponse({ error: { code: "not_found", message: "Thread not found." } }, 404),
    );

    await expect(
      streamTurn({ content: "Next turn", threadId: THREAD_B }, () => undefined),
    ).rejects.toMatchObject({
      name: "ApiError",
      code: "not_found",
      message: "Thread not found.",
    });
  });

  it("stops dispatching events and rejects when the stream breaks mid-way", async () => {
    const encoder = new TextEncoder();
    // Pull-based stream: the first read delivers one delta, the second read
    // errors (controller.error would discard chunks queued via start).
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(
            encoder.encode(
              sseFrame("message.delta", {
                threadId: THREAD_A,
                messageId: "01JCMESSAGEMESSAGEMESSAGEME01",
                role: "assistant",
                text: "Par",
              }),
            ),
          );
        } else {
          controller.error(new Error("connection dropped"));
        }
      },
    });
    stubFetch(
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const events: YuiEvent[] = [];

    await expect(
      streamTurn({ content: "Next turn", threadId: THREAD_A }, event => {
        events.push(event);
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(events.map(event => event.type)).toEqual(["message.delta"]);
  });
});
