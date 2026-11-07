import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIPv4, isIPv6 } from "node:net";
import { Readable } from "node:stream";
// The engine's tool type via the adapter's type-only re-export (AD-1: the
// adapter stays the only module naming the engine package). The engine's
// `defineTool` helper is a pure identity function, so plain literals annotated
// with the same type are equivalent.
import type { ToolDefinition } from "./adapter.ts";
import { Type } from "typebox";

// Custom tools for the engine seam (AD-1/AD-7 revision): the ONLY execution
// surface v1 exposes is two fetch-shaped tools — `web_fetch` (page → text) and
// `view_image` (image → model-visible content). The engine's built-in coding
// tools stay disabled (`noTools: "builtin"` in the adapter); everything here is
// static fetching behind a strict SSRF guard, with no shell and no filesystem.
//
// `typebox` is the schema library the pinned engine itself uses for tool
// parameters — the same 1.3.27 pin, declared as a DIRECT dependency in
// package.json so the import below is never a phantom.

/** The exact tool allowlist — asserted active by the adapter, enforced deny-only by `beforeToolCall`. */
export const YUI_TOOL_NAMES = ["web_fetch", "view_image"] as const;

// ---------------------------------------------------------------------------
// SSRF guard (plan Always: every address must be a PUBLIC IP).
// ---------------------------------------------------------------------------

/** Ports the tools may talk to — plan Always: http/https on 80/443 only. */
const ALLOWED_PORTS = new Set(["80", "443"]);
/** Per-request timeout (plan Always: ≤10 s). */
const DEFAULT_TIMEOUT_MS = 10_000;
/** Body caps (plan Always): text 256 KB, image 5 MB. */
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Redirect budget (plan Always): manual redirects, ≤3 hops, each hop re-validated. */
const MAX_REDIRECTS = 3;

/** Error raised by the guard/fetchers; its message is safe for the model AND the `tool.activity` detail. */
export class ToolFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolFetchError";
  }
}

export type GuardResult = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Pure URL-level guard (no DNS, no connection): scheme http/https, a host,
 * no credentials in the URL, no IPv6 zone id, port 80/443 (or scheme default),
 * and — cheaply, before any resolution — no PRIVATE IP literal (literals are
 * knowable without a lookup; names still go through `assertPublicAddresses`).
 */
export function guardUrl(rawUrl: string): GuardResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "blocked: invalid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "blocked: scheme must be http or https" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "blocked: credentials in URL are not allowed" };
  }
  // Node's URL keeps the brackets on an IPv6 hostname ("[::1]") — strip them
  // so the literal classification (and every later host consumer, including
  // dns.lookup) sees the bare address.
  const host = stripBrackets(url.hostname);
  if (host.length === 0 || host.includes("%")) {
    return { ok: false, reason: "blocked: invalid host" };
  }
  if (url.port !== "" && !ALLOWED_PORTS.has(url.port)) {
    return { ok: false, reason: "blocked: port must be 80 or 443" };
  }
  // Literal IPs are classifiable without a lookup — reject non-public ones
  // here so a literal never reaches the fetch layer.
  if (isIPv4(host) || isIPv6(host)) {
    const violation = nonPublicReason(host);
    if (violation !== null) {
      return { ok: false, reason: `blocked: ${violation}` };
    }
  }
  return { ok: true, url };
}

/** "[::1]" → "::1"; any other host passes through unchanged. */
function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** The one-line reason an address is not public, or null when it is public. */
function nonPublicReason(address: string): string | null {
  const v4 = toIPv4(address);
  if (v4 !== null) {
    return v4Violation(v4[0], v4[1]);
  }
  if (isIPv6(address)) {
    const groups = parseIPv6Groups(address);
    // Fail CLOSED: node's isIPv6 accepts strings the group parser rejects
    // (e.g. zone ids like "fe80::1%eth0" from scoped resolvers) — anything
    // unclassifiable is not public.
    if (groups === null) {
      return "invalid address";
    }
    {
      // ::1 (loopback) and :: (unspecified): everything zero except at most
      // the last group. slice(0, 7) matters — the earlier slice(2) form let a
      // non-zero LAST group break the "all zero" test, passing ::1 as public.
      // Any other address in that shape (::2, ::3, …) is reserved.
      if (groups.slice(0, 7).every((g) => g === 0)) {
        return groups[7] === 1 ? "loopback address" : "reserved address";
      }
      // v4-mapped ::ffff:0:0/96 — the URL parser normalizes the dotted form
      // ("::ffff:10.0.0.1") to hex groups, so classify on the EMBEDDED v4
      // (groups 6-7), not the textual form toIPv4 regexes for.
      if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
        return v4Violation(groups[6]! >> 8, groups[6]! & 0xff);
      }
      if (groups[0] === 0x2001 && (groups[1] & 0xfff0) === 0) return "private address"; // Teredo 2001:0::/32
      if (groups[0] === 0x2001 && groups[1] === 0x0db8) return "private address"; // documentation
      if (groups[0] === 0x2002) return "private address"; // 6to4 (embedded IPv4)
      if (groups[0] === 0x64 && groups[1] === 0xff9b) return "private address"; // NAT64
      if (groups[0] === 0x0100 && (groups[1] & 0xc000) === 0) return "private address"; // discard 100::/64
      if ((groups[0] & 0xfe00) === 0xfc00) return "private address"; // ULA fc00::/7
      if ((groups[0] & 0xffc0) === 0xfe80) return "link-local address";
      if ((groups[0] & 0xff00) === 0xff00) return "multicast address";
    }
    return null;
  }
  return "invalid address";
}

/** v4 range classification from the first two octets (shared by the mapped-v6 path). */
function v4Violation(a: number, b: number): string | null {
  if (a === 0) return "private address";
  if (a === 10) return "private address";
  if (a === 100 && b >= 64 && b <= 127) return "private address"; // CGNAT / tailnet
  if (a === 127) return "loopback address";
  if (a === 169 && b === 254) return "link-local address";
  if (a === 172 && b >= 16 && b <= 31) return "private address";
  if (a === 192 && b === 168) return "private address";
  if (a === 198 && (b === 18 || b === 19)) return "private address"; // benchmarking
  if ((a & 0xf0) === 224) return "multicast address";
  if ((a & 0xf0) === 240) return "reserved address";
  return null;
}

/** v4 octets for a plain v4 literal or a v4-mapped v6 literal; null otherwise. */
function toIPv4(address: string): [number, number] | null {
  if (isIPv4(address)) {
    const [a, b] = address.split(".");
    return [Number(a), Number(b)];
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped !== null) {
    const [a, b] = mapped[1]!.split(".");
    return [Number(a), Number(b)];
  }
  return null;
}

/** The 8 hex groups of a v6 literal (expanded, embedded dotted-quad included), or null. */
function parseIPv6Groups(address: string): number[] | null {
  if (address.split("::").length > 2) return null;
  const [head, tail] = address.split("::");
  const expand = (part: string): number[] | null => {
    if (part === "") return [];
    const pieces = part.split(":");
    const groups: number[] = [];
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i]!;
      // An embedded IPv4 tail ("::ffff:1.2.3.4") is only legal as the LAST
      // piece and expands to two groups — without this a NAT64/mapped literal
      // with a private embedded v4 would slip past the range checks.
      if (i === pieces.length - 1 && isIPv4(piece)) {
        const [a, b, c, d] = piece.split(".").map(Number) as [number, number, number, number];
        groups.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };
  const headGroups = expand(head);
  if (headGroups === null) return null;
  if (tail === undefined) {
    return headGroups.length === 8 ? headGroups : null;
  }
  const tailGroups = expand(tail);
  if (tailGroups === null) return null;
  if (headGroups.length + tailGroups.length > 8) return null;
  while (headGroups.length + tailGroups.length < 8) headGroups.push(0);
  return [...headGroups, ...tailGroups];
}

/** Injectable DNS resolution: every address a name resolves to must be public. */
export type LookupImpl = (host: string) => Promise<Array<{ address: string; family: number }>>;

/** One hop after ALL validation: the request URL plus the vetted IP the connection is pinned to. */
export type ValidatedHop = { url: URL; address: string };

/**
 * Injectable transport (tests): perform one HTTP GET, connecting to
 * `hop.address` — NOT to a re-resolution of the hostname.
 */
export type TransportImpl = (
  hop: ValidatedHop,
  options: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>;

const defaultLookup: LookupImpl = async (host) => {
  // `verbatim: false` makes getaddrinfo apply RFC 3484 ordering; `all: true`
  // returns EVERY address, and the guard must vet them all — one private A
  // record among many is still an SSRF win for a rebinding attacker.
  const results = await dnsLookup(host, { all: true, verbatim: false });
  return results.map((entry) => ({ address: entry.address, family: entry.family }));
};

/**
 * Resolve `host` and require EVERY resulting address to be a public IP
 * (private/loopback/link-local/ULA/multicast/reserved, v4 and v6, literals
 * and names alike). Returns the vetted address list for connection pinning.
 * Throws `ToolFetchError` — never connects on its own.
 */
export async function resolvePublicAddresses(
  host: string,
  lookup: LookupImpl = defaultLookup,
): Promise<Array<{ address: string; family: number }>> {
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(host);
  } catch {
    throw new ToolFetchError(`blocked: host does not resolve (${host})`);
  }
  if (addresses.length === 0) {
    throw new ToolFetchError(`blocked: host does not resolve (${host})`);
  }
  for (const { address } of addresses) {
    const violation = nonPublicReason(address);
    if (violation !== null) {
      throw new ToolFetchError(`blocked: ${violation} (${address})`);
    }
    // A v6 literal that merely LOOKS like an address string but failed to
    // classify is rejected above via "invalid address"; a public v4 or global
    // v6 passes.
    if (!isIPv4(address) && !isIPv6(address) && !/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(address)) {
      throw new ToolFetchError(`blocked: invalid address (${address})`);
    }
  }
  return addresses;
}

/** Void-returning wrapper: the plain assertion, without the vetted list. */
export async function assertPublicAddresses(host: string, lookup: LookupImpl = defaultLookup): Promise<void> {
  await resolvePublicAddresses(host, lookup);
}

// ---------------------------------------------------------------------------
// Fetchers: manual redirects (each hop re-guarded), timeout, byte caps.
// ---------------------------------------------------------------------------

/**
 * Guard + resolve ONE hop and return its connection target: the VETTED IP the
 * transport must connect to. A literal host is pinned to itself (already
 * classified public by guardUrl); a name is pinned to the first address of the
 * vetted resolution. This closes the guard→connection gap — the rebinding
 * (TOCTOU) fix: the transport never re-resolves DNS, so a short-TTL rebinder
 * cannot answer public-to-guard and private-to-connect.
 */
async function guardedHop(rawUrl: string, lookup: LookupImpl): Promise<ValidatedHop> {
  const guarded = guardUrl(rawUrl);
  if (!guarded.ok) {
    throw new ToolFetchError(guarded.reason);
  }
  const host = stripBrackets(guarded.url.hostname);
  if (isIPv4(host) || isIPv6(host)) {
    return { url: guarded.url, address: host };
  }
  const addresses = await resolvePublicAddresses(host, lookup);
  return { url: guarded.url, address: addresses[0]!.address };
}

/**
 * Production transport (node:http/https): the connection is PINNED to the
 * vetted address — `host` is the IP, so no second DNS resolution exists for a
 * rebinder to poison. TLS SNI and certificate identity still use the ORIGINAL
 * host (`servername`), and the `Host` header carries the original host[:port].
 */
const nodeTransport: TransportImpl = (hop, { signal, headers }) =>
  new Promise<Response>((resolve, reject) => {
    const url = hop.url;
    const secure = url.protocol === "https:";
    const host = stripBrackets(url.hostname);
    const hostHeader = url.port === "" ? url.hostname : `${url.hostname}:${url.port}`;
    const base = {
      host: hop.address,
      port: url.port === "" ? undefined : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: "GET" as const,
      headers: { ...headers, host: hostHeader },
      signal,
    };
    const req = secure
      ? httpsRequest(
          isIPv4(host) || isIPv6(host)
            ? base
            : { ...base, servername: host }, // SNI + cert identity = the original name
        )
      : httpRequest(base);
    req.on("response", (res) => {
      // IncomingHttpHeaders allows string | string[] | undefined per key;
      // flatten to the plain record the Response constructor takes (repeated
      // headers — set-cookie — join with ", ").
      const headerInit: Record<string, string> = {};
      for (const [key, value] of Object.entries(res.headers)) {
        if (typeof value === "string") headerInit[key] = value;
        else if (Array.isArray(value)) headerInit[key] = value.join(", ");
      }
      resolve(
        new Response(Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>, {
          status: res.statusCode ?? 200,
          headers: headerInit,
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });

/** Fetch with manual redirects ≤3; every hop re-validated by the guard. Returns the FINAL response. */
async function fetchWithRedirects(
  rawUrl: string,
  transport: TransportImpl,
  lookup: LookupImpl,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Response> {
  let current = rawUrl;
  for (let redirects = 0; ; redirects += 1) {
    if (redirects > MAX_REDIRECTS) {
      throw new ToolFetchError("blocked: too many redirects");
    }
    const hop = await guardedHop(current, lookup);
    let response: Response;
    try {
      response = await transport(hop, {
        signal: combineSignals(signal, timeoutMs),
        headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
      });
    } catch (error) {
      if (signal?.aborted) throw new ToolFetchError("aborted");
      throw new ToolFetchError(`fetch failed: ${oneLine(error instanceof Error ? error.message : "network error")}`);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (location === null || location === "") {
        throw new ToolFetchError("fetch failed: redirect without a location");
      }
      current = new URL(location, hop.url).toString();
      continue;
    }
    return response;
  }
}

/** AbortSignal.any over the agent signal and a per-request timeout (Node 22). */
function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (signal !== undefined) signals.push(signal);
  return AbortSignal.any(signals);
}

/** Read the body up to `cap` bytes; `truncated` true when more remained. */
async function readBodyCapped(response: Response, cap: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return { bytes: new Uint8Array(0), truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > cap) {
      const room = cap - total;
      if (room > 0) chunks.push(value.slice(0, room));
      total = cap;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    total += value.byteLength;
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

export type FetchedPage = { url: string; text: string; truncated: boolean };

/**
 * `web_fetch` backend: fetch a public page and return its text (naive HTML
 * strip, no deps). Body capped at 256 KB — an oversized page is TRUNCATED with
 * a marker rather than failed (partial text still answers the model's need).
 */
export async function fetchPage(
  rawUrl: string,
  deps: { transport?: TransportImpl; lookup?: LookupImpl; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<FetchedPage> {
  const transport = deps.transport ?? nodeTransport;
  const lookup = deps.lookup ?? defaultLookup;
  const response = await fetchWithRedirects(rawUrl, transport, lookup, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, deps.signal);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ToolFetchError(`fetch failed: HTTP ${response.status}`);
  }
  const { bytes, truncated } = await readBodyCapped(response, MAX_TEXT_BYTES);
  const charset = /charset=([\w-]+)/i.exec(response.headers.get("content-type") ?? "")?.[1] ?? "utf-8";
  let text: string;
  try {
    text = new TextDecoder(charset).decode(bytes);
  } catch {
    text = new TextDecoder("utf-8").decode(bytes);
  }
  const body = htmlToText(text);
  const suffix = truncated ? "\n\n[truncated at 256 KB]" : "";
  return { url: response.url || rawUrl, text: body + suffix, truncated };
}

export type FetchedImage = { url: string; data: string; mimeType: string; bytes: number };

/**
 * `view_image` backend: fetch a public image and return base64 content for
 * the model. Cap 5 MB is a hard FAIL (a truncated image is corrupt input),
 * and the response must declare an `image/*` content type.
 */
export async function fetchImage(
  rawUrl: string,
  deps: { transport?: TransportImpl; lookup?: LookupImpl; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<FetchedImage> {
  const transport = deps.transport ?? nodeTransport;
  const lookup = deps.lookup ?? defaultLookup;
  const response = await fetchWithRedirects(rawUrl, transport, lookup, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, deps.signal);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ToolFetchError(`fetch failed: HTTP ${response.status}`);
  }
  const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!mimeType.startsWith("image/")) {
    await response.body?.cancel().catch(() => {});
    throw new ToolFetchError("fetch failed: response is not an image");
  }
  const { bytes, truncated } = await readBodyCapped(response, MAX_IMAGE_BYTES);
  if (truncated || bytes.byteLength === 0) {
    throw new ToolFetchError(`blocked: image exceeds the 5 MB limit`);
  }
  return { url: response.url || rawUrl, data: Buffer.from(bytes).toString("base64"), mimeType, bytes: bytes.byteLength };
}

// ---------------------------------------------------------------------------
// Naive HTML → text (Design Notes: strip tags without a dependency; a JS-only
// SPA renders empty by design — no headless browser in v1).
// ---------------------------------------------------------------------------

/** Collapse a string to one line (whitespace → single spaces), for errors/details. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const BLOCK_TAGS = /<\/?(?:p|div|br|li|tr|h[1-6]|section|article|blockquote|pre|ul|ol|table|hr)\b[^>]*>/gi;

export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(BLOCK_TAGS, "\n")
    .replace(/<[^>]+>/g, " ");
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&(?:apos|#39|#x27);/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeFromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCodePoint(Number(dec)));
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** String.fromCodePoint that leaves malformed references as-is instead of throwing. */
function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Tool definitions (Type from the engine's schema library; errors come back
// as `isError` results so the model can recover without data, per plan).
// ---------------------------------------------------------------------------

const URL_SCHEMA = Type.Object({
  url: Type.String({ description: "Absolute http:// or https:// URL (port 80/443 only)" }),
});

function errorContent(error: unknown): { content: [{ type: "text"; text: string }]; details: {}; isError: true } {
  const message = error instanceof ToolFetchError ? error.message : `tool failed: ${oneLine(error instanceof Error ? error.message : String(error))}`;
  return { content: [{ type: "text", text: message }], details: {}, isError: true };
}

/** Build the two allowlisted custom tools; deps injectable for tests. */
export function createYuiTools(
  deps: { transport?: TransportImpl; lookup?: LookupImpl; timeoutMs?: number } = {},
): ToolDefinition[] {
  const webFetch: ToolDefinition<typeof URL_SCHEMA> = {
    name: "web_fetch",
    label: "web_fetch",
    description:
      "Fetch a public web page by URL and return its readable text (HTML tags stripped, up to 256 KB). Use it when answering needs fresh information from the web. Only public http/https URLs on port 80/443; redirects are followed up to 3 hops.",
    promptSnippet: "Fetch a public web page and read its text",
    parameters: URL_SCHEMA,
    async execute(_toolCallId, params, signal) {
      try {
        const page = await fetchPage(params.url, { ...deps, signal });
        return {
          content: [{ type: "text", text: `URL: ${page.url}\n\n${page.text}` }],
          details: { url: page.url, truncated: page.truncated },
        };
      } catch (error) {
        return errorContent(error);
      }
    },
  };

  const viewImage: ToolDefinition<typeof URL_SCHEMA> = {
    name: "view_image",
    label: "view_image",
    description:
      "Fetch a public image by URL (png/jpg/gif/webp, up to 5 MB) and attach it so you can see it. Use it to look at a photo, screenshot, or diagram referenced by a URL.",
    promptSnippet: "Fetch a public image and view it",
    parameters: URL_SCHEMA,
    async execute(_toolCallId, params, signal) {
      try {
        const image = await fetchImage(params.url, { ...deps, signal });
        return {
          content: [{ type: "image", data: image.data, mimeType: image.mimeType }],
          details: { url: image.url, mimeType: image.mimeType, bytes: image.bytes },
        };
      } catch (error) {
        return errorContent(error);
      }
    },
  };

  return [webFetch, viewImage];
}
