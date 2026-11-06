import { describe, expect, it } from "vitest";
import app from "./app.ts";

describe("GET /healthz", () => {
  it("returns 200 with the yui health payload", async () => {
    const res = await app.request("/healthz");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ app: "yui" });
  });
});
