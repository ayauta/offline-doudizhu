import { describe, expect, it } from "vitest";

import {
  findWebView90CompatibilityViolations,
  findWebView90StylesheetViolations,
} from "../../scripts/webview-compatibility-rules.mjs";

describe("WebView 90 compatibility rules", () => {
  it("reports unsupported runtime built-ins and animation keyframe properties", () => {
    const source = `
      const tail = values.at(-1);
      const owned = Object.hasOwn(record, key);
      const copy = structuredClone(record);
      card.animate([{ translate: "10px 0" }, { translate: "0 0" }]);
    `;

    expect(findWebView90CompatibilityViolations(source, "src/example.ts")).toEqual([
      "src/example.ts:2:27: Array/String/TypedArray.prototype.at requires Chrome/WebView 92",
      "src/example.ts:3:28: Object.hasOwn requires Chrome/WebView 93",
      "src/example.ts:4:20: structuredClone requires Chrome/WebView 98",
      "src/example.ts:5:23: individual translate animation keyframes require Chrome/WebView 104",
      "src/example.ts:5:48: individual translate animation keyframes require Chrome/WebView 104",
    ]);
  });

  it("accepts WebView 90-compatible equivalents", () => {
    const source = `
      const tail = values[values.length - 1];
      const owned = Object.prototype.hasOwnProperty.call(record, key);
      card.animate([{ transform: "translate(10px, 0)" }, { transform: "translate(0, 0)" }]);
    `;

    expect(findWebView90CompatibilityViolations(source, "src/example.ts")).toEqual([]);
  });

  it("requires legacy viewport fallbacks and rejects individual CSS transforms", () => {
    const source = `
      .safe { min-height: 100vh; min-height: 100dvh; }
      .missing-fallback { height: 100dvh; }
      .too-new { translate: 10px 0; }
    `;

    expect(findWebView90StylesheetViolations(source, "src/example.css")).toEqual([
      "src/example.css:3:27: 100dvh requires an earlier 100vh fallback in the same rule",
      "src/example.css:4:18: individual CSS transform properties require Chrome/WebView 104",
    ]);
  });
});
