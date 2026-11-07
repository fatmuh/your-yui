import { expect } from "vitest";

// Helper SSE untuk test server (ekstraksi byte-identik dari
// engine-turn.test.ts — satu sumber kebenaran, bukan salinan per-file):
// parser frame event-stream + pembaca seluruh stream sampai tutup.

export type SseEvent = { event: string; data: Record<string, unknown> };

/** Baca seluruh stream SSE sampai tutup; kembalikan frame terurut. */
export async function readSse(res: Response): Promise<{ events: SseEvent[]; raw: string }> {
  expect(res.body).not.toBeNull();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = "";
  let raw = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    raw += text;
    buffer += text;
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseFrame(frame);
      if (parsed !== null) events.push(parsed);
      boundary = buffer.indexOf("\n\n");
    }
  }
  return { events, raw };
}

export function parseFrame(frame: string): SseEvent | null {
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
