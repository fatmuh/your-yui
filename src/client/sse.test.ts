import { describe, expect, it } from "vitest";
import { createSseParser, parseSseFrame, type SseFrame } from "./sse.ts";

// Pure parser tests — no fetch, no DOM. The matrix from the story plan: whole
// frames, chunks split mid-frame, multi-line data, and events without data.

/** Feed the given raw chunks to a fresh parser; return the dispatched frames. */
function parseChunks(chunks: string[]): SseFrame[] {
  const frames: SseFrame[] = [];
  const parser = createSseParser(frame => {
    frames.push(frame);
  });
  for (const chunk of chunks) parser.push(chunk);
  return frames;
}

describe("parseSseFrame", () => {
  it("parses an event/data frame into the dispatch name and JSON payload", () => {
    expect(parseSseFrame('event: message.delta\ndata: {"text":"Hel"}')).toEqual({
      event: "message.delta",
      data: { text: "Hel" },
    });
  });

  it("defaults the dispatch name to message when no event line is present", () => {
    expect(parseSseFrame('data: {"ok":true}')).toEqual({
      event: "message",
      data: { ok: true },
    });
  });

  it("joins multi-line data with newlines before JSON parsing", () => {
    expect(parseSseFrame('data: {"text":\ndata: "two lines"}')).toEqual({
      event: "message",
      data: { text: "two lines" },
    });
  });

  it("returns null for frames without a data line", () => {
    expect(parseSseFrame("event: turn.settled")).toBeNull();
    expect(parseSseFrame("")).toBeNull();
  });
});

describe("createSseParser", () => {
  it("emits whole frames in order when one chunk carries the full stream", () => {
    const frames = parseChunks([
      'event: thread.updated\ndata: {"threadId":"01T"}\n\nevent: turn.settled\ndata: {"threadId":"01T"}\n\n',
    ]);

    expect(frames).toEqual([
      { event: "thread.updated", data: { threadId: "01T" } },
      { event: "turn.settled", data: { threadId: "01T" } },
    ]);
  });

  it("buffers partial frames split across chunks at arbitrary points", () => {
    const stream =
      'event: message.delta\ndata: {"threadId":"01T","text":"Hel"}\n\nevent: message.final\ndata: {"threadId":"01T","text":"Hello"}\n\n';
    // Split mid-event-name, mid-JSON, and inside the blank-line boundary.
    const frames = parseChunks([
      stream.slice(0, 13),
      stream.slice(13, 40),
      stream.slice(40, 41),
      stream.slice(41, 70),
      stream.slice(70),
    ]);

    expect(frames).toEqual([
      { event: "message.delta", data: { threadId: "01T", text: "Hel" } },
      { event: "message.final", data: { threadId: "01T", text: "Hello" } },
    ]);
  });

  it("still parses when every character arrives as its own chunk", () => {
    const stream = 'event: error\ndata: {"code":"provider_error"}\n\n';
    const frames = parseChunks([...stream]);

    expect(frames).toEqual([{ event: "error", data: { code: "provider_error" } }]);
  });

  it("discards a trailing frame that never reached its blank-line boundary", () => {
    const frames = parseChunks([
      'event: turn.settled\ndata: {"threadId":"01T"}\n\nevent: message.delta\ndata: {"text":"par',
    ]);

    expect(frames).toEqual([{ event: "turn.settled", data: { threadId: "01T" } }]);
  });

  it("skips data-less frames between valid ones", () => {
    const frames = parseChunks([
      'event: ping\n\n',
      'event: thread.updated\ndata: {"threadId":"01T"}\n\n',
      'event: keepalive\n\n',
      'event: turn.settled\ndata: {"threadId":"01T"}\n\n',
    ]);

    expect(frames.map(frame => frame.event)).toEqual(["thread.updated", "turn.settled"]);
  });
});
