import { describe, expect, it } from "vitest";

import {
  DEFAULT_AI_SETTINGS,
  decodeAiSettingsDocument,
  encodeAiSettingsDocument,
} from "../../src/app/settings/ai-settings.js";

describe("AI settings document", () => {
  it("defaults missing, corrupt, and unknown AI values without a migration", () => {
    expect(decodeAiSettingsDocument(null)).toEqual({
      settings: DEFAULT_AI_SETTINGS,
      writable: true,
    });
    expect(decodeAiSettingsDocument("not-json")).toEqual({
      settings: DEFAULT_AI_SETTINGS,
      writable: true,
    });
    expect(
      decodeAiSettingsDocument(JSON.stringify({
        schemaVersion: 1,
        data: { aiType: "future-level", laterField: true },
      })),
    ).toEqual({ settings: DEFAULT_AI_SETTINGS, writable: true });
  });

  it("accepts stable values and ignores additive fields", () => {
    expect(
      decodeAiSettingsDocument(JSON.stringify({
        schemaVersion: 1,
        data: { aiType: "master", futureDisplayOption: "quiet" },
        futureEnvelopeField: 2,
      })),
    ).toEqual({
      settings: Object.freeze({ aiType: "master" }),
      writable: true,
    });
  });

  it("decodes a removed tier onto its surviving tier instead of the default", () => {
    expect(
      decodeAiSettingsDocument(JSON.stringify({
        schemaVersion: 1,
        data: { aiType: "expert" },
      })),
    ).toEqual({
      settings: Object.freeze({ aiType: "master" }),
      writable: true,
    });
  });

  it("does not resolve an inherited object key as a removed tier", () => {
    // `Object.prototype` is reachable by name from any plain object literal, so
    // a bare index would return `Object` here and hand it back typed as a tier.
    for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(
        decodeAiSettingsDocument(JSON.stringify({
          schemaVersion: 1,
          data: { aiType: key },
        })),
      ).toEqual({ settings: DEFAULT_AI_SETTINGS, writable: true });
    }
  });

  it("does not authorize overwriting an unsupported future schema", () => {
    expect(
      decodeAiSettingsDocument(JSON.stringify({
        schemaVersion: 99,
        data: { aiType: "master" },
      })),
    ).toEqual({ settings: DEFAULT_AI_SETTINGS, writable: false });
  });

  it("encodes a small versioned document independently of the app version", () => {
    expect(JSON.parse(encodeAiSettingsDocument({ aiType: "casual" }))).toEqual({
      schemaVersion: 1,
      data: { aiType: "casual" },
    });
  });
});
