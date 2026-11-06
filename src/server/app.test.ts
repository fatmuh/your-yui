import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";

describe("GET /healthz", () => {
  it("returns 200 with the yui health payload", async () => {
    const res = await createApp().request("/healthz");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ app: "yui" });
  });
});

describe("GET / (static shell)", () => {
  it("serves index.html when the static root has a build", async () => {
    const res = await createApp("src/server/__fixtures__/shell").request("/");

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain("<div id=\"root\"></div>");
  });

  it("returns 404 when the static root has no build yet", async () => {
    const res = await createApp("src/server/__fixtures__/empty").request("/");

    expect(res.status).toBe(404);
  });
});
