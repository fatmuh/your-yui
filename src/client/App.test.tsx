import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "./App.tsx";

describe("App shell", () => {
  it("renders the app name", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Yui");
  });
});
