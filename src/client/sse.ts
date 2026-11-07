// Client-side SSE frame parser for the Yui turn stream (POST /api/engine/turn).
//
// Kept as a separate client module (AD-8): the client never imports from
// tests/, so this mirrors the frame logic of tests/helpers/sse.ts (server)
// rather than sharing it. The wire format is Hono streamSSE: frames of
// `event: <type>\ndata: <json>` separated by a blank line. Network chunks may
// split a frame anywhere, so partial input stays buffered until the next
// boundary arrives.

/** One parsed SSE frame: the dispatch name plus its decoded JSON payload. */
export type SseFrame = { event: string; data: Record<string, unknown> };

/**
 * Parse one complete frame (the text between two blank-line separators).
 * Returns null for frames without a `data:` line — nothing to dispatch.
 * Multi-line data is joined with "\n" per the SSE spec before JSON parsing.
 */
export function parseSseFrame(frame: string): SseFrame | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> };
}

/**
 * Stateful stream parser: feed it decoded text chunks as they arrive from the
 * response body reader; every complete frame is passed to `onFrame` in order.
 * A trailing incomplete frame (stream ended without a final blank line) is
 * discarded, matching the SSE end-of-stream rules.
 */
export function createSseParser(onFrame: (frame: SseFrame) => void): { push(chunk: string): void } {
  let buffer = "";
  return {
    push(chunk: string): void {
      buffer += chunk;
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseFrame(frame);
        if (parsed !== null) onFrame(parsed);
        boundary = buffer.indexOf("\n\n");
      }
    },
  };
}
