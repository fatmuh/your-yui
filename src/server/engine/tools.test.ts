import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "./adapter.ts";
import {
  assertPublicAddresses,
  createYuiTools,
  fetchImage,
  fetchPage,
  guardUrl,
  htmlToText,
  ToolFetchError,
  YUI_TOOL_NAMES,
  type LookupImpl,
  type TransportImpl,
} from "./tools.ts";

// Unit proof for the SSRF guard + the two custom tools (bot-tool-calling
// epic, AD-7 revision): the URL-level matrix, the DNS-level matrix (injected
// lookup — no real network), manual redirects (each hop re-guarded), the
// connection PINNING (rebinding TOCTOU), the byte caps, and the tool
// `execute` surfaces over an injected transport.

/** A lookup that always resolves to one public v4 address. */
const publicLookup: LookupImpl = async () => [{ address: "93.184.216.34", family: 4 }];

/**
 * Transport factory for the injected seam — records every hop's URL and the
 * PINNED address the production code asked it to connect to.
 */
function mockTransport(
  handler: (url: string) => { status?: number; headers?: Record<string, string>; body?: string | Uint8Array },
): { transport: TransportImpl; calls: string[]; addresses: string[] } {
  const calls: string[] = [];
  const addresses: string[] = [];
  const transport: TransportImpl = async (hop) => {
    calls.push(hop.url.toString());
    addresses.push(hop.address);
    const plan = handler(hop.url.toString());
    return new Response(plan.body ?? "", {
      status: plan.status ?? 200,
      headers: plan.headers ?? {},
    });
  };
  return { transport, calls, addresses };
}

describe("guardUrl — URL-level matrix", () => {
  it("accepts plain http/https URLs, with or without the default port", () => {
    for (const url of ["http://example.com/", "https://example.com/path?q=1", "http://example.com:80/", "https://example.com:443/x"]) {
      expect(guardUrl(url)).toMatchObject({ ok: true });
    }
  });

  it("rejects non-http schemes", () => {
    for (const url of ["ftp://example.com/", "file:///etc/passwd", "gopher://example.com/"]) {
      expect(guardUrl(url)).toEqual({ ok: false, reason: expect.stringContaining("scheme") });
    }
  });

  it("rejects ports other than 80/443", () => {
    for (const url of ["http://example.com:8080/", "https://example.com:8443/", "http://example.com:22/"]) {
      expect(guardUrl(url)).toEqual({ ok: false, reason: expect.stringContaining("port") });
    }
  });

  it("rejects userinfo credentials and malformed hosts", () => {
    expect(guardUrl("http://user:pass@example.com/")).toEqual({ ok: false, reason: expect.stringContaining("credentials") });
    // A bare (unbracketed) v6 host with a zone id is not even a URL — the
    // parser itself refuses it, which is still a hard block.
    expect(guardUrl("http://fe80::1%eth0/")).toEqual({ ok: false, reason: expect.stringContaining("blocked:") });
    // Host-less forms never parse either.
    expect(guardUrl("http://")).toEqual({ ok: false, reason: expect.stringContaining("blocked:") });
  });

  it("rejects non-public IPv4 literals without any lookup", () => {
    for (const literal of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "169.254.169.254",
      "0.0.0.0",
      "100.64.0.1",
      "100.127.255.255",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      const guarded = guardUrl(`http://${literal}/`);
      expect(guarded, literal).toEqual({ ok: false, reason: expect.stringContaining("blocked:") });
    }
  });

  it("accepts public IPv4 literals", () => {
    for (const literal of ["93.184.216.34", "1.1.1.1", "172.32.0.1", "100.128.0.1"]) {
      expect(guardUrl(`http://${literal}/`), literal).toMatchObject({ ok: true });
    }
  });

  it("rejects non-public IPv6 literals, including mapped/NAT64/6to4/Teredo forms", () => {
    for (const literal of [
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456:789a::1",
      "ff02::1",
      "64:ff9b::127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:127.0.0.1",
      "2002:0a00:0001::1",
      "2001:db8::1",
      "2001:0:1234::1",
      "100::1",
      // Zone id: never even a URL — the parser itself refuses it.
      "fe80::1%eth0",
    ]) {
      const guarded = guardUrl(`http://[${literal}]/`);
      expect(guarded, literal).toEqual({ ok: false, reason: expect.stringContaining("blocked:") });
    }
  });

  it("accepts public IPv6 literals", () => {
    for (const literal of ["2606:4700:4700::1111", "2a00:1450:4001:81b::200e"]) {
      expect(guardUrl(`http://[${literal}]/`), literal).toMatchObject({ ok: true });
    }
  });
});

describe("assertPublicAddresses — DNS-level matrix (injected lookup)", () => {
  it("every resolved address public → resolves", async () => {
    const lookup: LookupImpl = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ];
    await expect(assertPublicAddresses("example.com", lookup)).resolves.toBeUndefined();
  });

  it("one private record among many is still a block (rebinding shape)", async () => {
    const lookup: LookupImpl = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ];
    await expect(assertPublicAddresses("example.com", lookup)).rejects.toThrow(ToolFetchError);
    await expect(assertPublicAddresses("example.com", lookup)).rejects.toThrow(/private address/);
  });

  it("loopback/link-local/ULA v6 resolutions are blocked", async () => {
    for (const address of ["127.0.0.1", "169.254.1.2", "fe80::1", "fd00::9"]) {
      const lookup: LookupImpl = async () => [{ address, family: address.includes(":") ? 6 : 4 }];
      await expect(assertPublicAddresses("example.com", lookup), address).rejects.toThrow(ToolFetchError);
    }
  });

  it("a zone-id v6 answer fails CLOSED (isIPv6-true but unparseable is not public)", async () => {
    // node's isIPv6 accepts "fe80::1%eth0"; the group parser cannot classify
    // it — the guard must reject it, never fall through as public.
    const lookup: LookupImpl = async () => [{ address: "fe80::1%eth0", family: 6 }];
    await expect(assertPublicAddresses("example.com", lookup)).rejects.toThrow(/invalid address/);
  });

  it("lookup failure or an empty answer → host does not resolve", async () => {
    const failing: LookupImpl = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(assertPublicAddresses("nope.example", failing)).rejects.toThrow(/does not resolve/);
    const empty: LookupImpl = async () => [];
    await expect(assertPublicAddresses("nope.example", empty)).rejects.toThrow(/does not resolve/);
  });
});

describe("fetchPage / fetchImage over an injected fetch", () => {
  it("happy path: HTML is stripped to text and prefixed with the final URL", async () => {
    const { transport } = mockTransport(() => ({
      headers: { "content-type": "text/html; charset=utf-8" },
      body: "<html><head><style>.x{color:red}</style></head><body><!-- note --><h1>Title</h1><p>Hello &amp; welcome</p><script>alert(1)</script></body></html>",
    }));
    const page = await fetchPage("http://example.com/page", { transport, lookup: publicLookup });
    expect(page.url).toBe("http://example.com/page");
    expect(page.truncated).toBe(false);
    expect(page.text).toContain("Title");
    expect(page.text).toContain("Hello & welcome");
    expect(page.text).not.toContain("alert");
    expect(page.text).not.toContain("color:red");
    expect(page.text).not.toContain("<");
  });

  it("follows up to 3 redirects, re-guarding every hop", async () => {
    const { transport, calls } = mockTransport((url) =>
      url === "http://example.com/a"
        ? { status: 302, headers: { location: "http://example.com/b" } }
        : url === "http://example.com/b"
          ? { status: 301, headers: { location: "http://example.com/c" } }
          : url === "http://example.com/c"
            ? { status: 308, headers: { location: "http://example.com/final" } }
            : { body: "landed" },
    );
    const page = await fetchPage("http://example.com/a", { transport, lookup: publicLookup });
    expect(page.text).toContain("landed");
    expect(calls).toEqual(["http://example.com/a", "http://example.com/b", "http://example.com/c", "http://example.com/final"]);
  });

  it("a RELATIVE Location resolves against the current hop's URL", async () => {
    const { transport, calls } = mockTransport((url) =>
      url === "http://example.com/rel" ? { status: 302, headers: { location: "/final" } } : { body: "landed-rel" },
    );
    const page = await fetchPage("http://example.com/rel", { transport, lookup: publicLookup });
    expect(calls).toEqual(["http://example.com/rel", "http://example.com/final"]);
    expect(page.text).toContain("landed-rel");
  });

  it("the 4th redirect hop is refused — no connection to it", async () => {
    const { transport, calls } = mockTransport((url) =>
      url.startsWith("http://example.com/stop")
        ? { status: 302, headers: { location: `${url}x` } }
        : { status: 302, headers: { location: `${url}x` } },
    );
    await expect(fetchPage("http://example.com/hop", { transport, lookup: publicLookup })).rejects.toThrow(
      /too many redirects/,
    );
    // Exactly the allowed hops were attempted (A, A→…): the 5th URL is never fetched.
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  it("a redirect to a private host is blocked BEFORE the connection", async () => {
    const { transport, calls } = mockTransport(() => ({
      status: 302,
      headers: { location: "http://192.168.0.10/admin" },
      body: "",
    }));
    await expect(fetchPage("http://example.com/redirect", { transport, lookup: publicLookup })).rejects.toThrow(
      /private address/,
    );
    // Only the first (public) hop was ever fetched; 192.168.0.10 never saw a request.
    expect(calls).toEqual(["http://example.com/redirect"]);
  });

  it("text bodies are truncated at 256 KB with a marker", async () => {
    const big = "a".repeat(300 * 1024);
    const { transport } = mockTransport(() => ({ headers: { "content-type": "text/plain" }, body: big }));
    const page = await fetchPage("http://example.com/big", { transport, lookup: publicLookup });
    expect(page.truncated).toBe(true);
    expect(page.text.endsWith("[truncated at 256 KB]")).toBe(true);
    expect(page.text.length).toBeLessThan(big.length);
  });

  it("an HTTP error status is a ToolFetchError, not content", async () => {
    const { transport } = mockTransport(() => ({ status: 404, body: "gone" }));
    await expect(fetchPage("http://example.com/missing", { transport, lookup: publicLookup })).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it("fetchImage: image mime → base64 payload with byte count", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const { transport } = mockTransport(() => ({ headers: { "content-type": "image/png" }, body: bytes }));
    const image = await fetchImage("http://example.com/cat.png", { transport, lookup: publicLookup });
    expect(image.mimeType).toBe("image/png");
    expect(image.bytes).toBe(5);
    expect(image.data).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("fetchImage: a non-image mime is refused", async () => {
    const { transport } = mockTransport(() => ({ headers: { "content-type": "text/html" }, body: "<p>nope</p>" }));
    await expect(fetchImage("http://example.com/cat", { transport, lookup: publicLookup })).rejects.toThrow(
      /not an image/,
    );
  });

  it("fetchImage: a body over 5 MB is a hard failure (no truncation)", async () => {
    const huge = new Uint8Array(5 * 1024 * 1024 + 1);
    const { transport } = mockTransport(() => ({ headers: { "content-type": "image/png" }, body: huge }));
    await expect(fetchImage("http://example.com/huge.png", { transport, lookup: publicLookup })).rejects.toThrow(
      /5 MB limit/,
    );
  });

  it("fetchImage: an empty body is refused (0 bytes is not an image)", async () => {
    const { transport } = mockTransport(() => ({ headers: { "content-type": "image/png" }, body: "" }));
    await expect(fetchImage("http://example.com/empty.png", { transport, lookup: publicLookup })).rejects.toThrow(
      /5 MB limit/,
    );
  });
});

describe("connection pinning — DNS rebinding (TOCTOU)", () => {
  it("the transport connects to the VETTED address only; a rebinder's later answers are never used", async () => {
    // Attacker DNS: the guard's (first) answer is public; every later answer
    // flips private — the classic rebinding shape that a re-resolving fetch
    // would follow straight to loopback/LAN.
    let lookups = 0;
    const lookup: LookupImpl = async () => {
      lookups += 1;
      return lookups === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    };
    const connections: Array<{ url: string; address: string }> = [];
    const transport: TransportImpl = async (hop) => {
      connections.push({ url: hop.url.toString(), address: hop.address });
      // The pinned PUBLIC address is not the attacker's box: nothing answers.
      throw new Error("connect ECONNREFUSED");
    };
    const webFetch = createYuiTools({ transport, lookup }).find((tool) => tool.name === "web_fetch")!;
    const result = await webFetch.execute("call-rebind", { url: "http://rebind.example/x" } as never, undefined, undefined, {} as never);
    expect(result.isError).toBe(true);
    // The ONE connection attempt went to the vetted public address — the
    // private answer was never connected to...
    expect(connections).toEqual([{ url: "http://rebind.example/x", address: "93.184.216.34" }]);
    // ...because DNS is consulted exactly once per hop: there is no second,
    // connect-time resolution left for the rebinder to poison.
    expect(lookups).toBe(1);
  });
});

describe("htmlToText", () => {
  it("drops scripts, styles, and comments; block tags become line breaks; entities decode", () => {
    const html = [
      "<!-- c -->",
      "<script>var x = 1;</script>",
      "<style>a{}</style>",
      "<div><p>One</p><p>Two &amp; three</p></div>",
      "<ul><li>alpha</li><li>beta</li></ul>",
      "<p>&#65;&#x42;&quot;quoted&quot;</p>",
    ].join("");
    const text = htmlToText(html);
    expect(text).not.toMatch(/var x|c \{|\{\}|<!--/);
    expect(text).toContain("One");
    expect(text).toContain("Two & three");
    expect(text).toContain("alpha");
    expect(text).toContain('AB"quoted"');
    expect(text.split("\n").length).toBeGreaterThan(1);
  });
});

describe("createYuiTools — the engine-facing tools", () => {
  it("registers exactly the two allowlisted tools", () => {
    const tools = createYuiTools();
    expect(tools.map((tool) => tool.name)).toEqual([...YUI_TOOL_NAMES]);
  });

  async function run(tool: ToolDefinition, url: string) {
    return tool.execute("call-test", { url } as never, undefined, undefined, {} as never);
  }

  it("web_fetch returns text content built from the fetched page", async () => {
    const { transport } = mockTransport(() => ({
      headers: { "content-type": "text/html" },
      body: "<html><body><p>Fresh facts</p></body></html>",
    }));
    const webFetch = createYuiTools({ transport, lookup: publicLookup }).find((tool) => tool.name === "web_fetch")!;
    const result = await run(webFetch, "http://example.com/facts");
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain("Fresh facts");
    expect((result.content[0] as { text: string }).text).toContain("http://example.com/facts");
  });

  it("view_image returns image content (base64 + mime) for the model", async () => {
    const bytes = new Uint8Array([9, 9, 9]);
    const { transport } = mockTransport(() => ({ headers: { "content-type": "image/webp" }, body: bytes }));
    const viewImage = createYuiTools({ transport, lookup: publicLookup }).find((tool) => tool.name === "view_image")!;
    const result = await run(viewImage, "http://example.com/pic.webp");
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toEqual({
      type: "image",
      data: Buffer.from(bytes).toString("base64"),
      mimeType: "image/webp",
    });
  });

  it("a blocked URL surfaces as an isError result the model can read, not a throw", async () => {
    const { transport, calls } = mockTransport(() => ({ body: "never" }));
    const webFetch = createYuiTools({ transport, lookup: publicLookup }).find((tool) => tool.name === "web_fetch")!;
    const blocked = await run(webFetch, "http://127.0.0.1:80/secret");
    expect(blocked.isError).toBe(true);
    expect((blocked.content[0] as { text: string }).text).toMatch(/loopback address/);
    // The guard refuses BEFORE any connection: the injected fetch never ran.
    expect(calls).toEqual([]);
  });
});
