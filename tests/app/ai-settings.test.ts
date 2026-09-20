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
      settings: Object.freeze({ aiType: "master", counterfactualFarmer: false }),
      writable: true,
    });
  });

  it("defaults every unknown tier, inherited object keys included", () => {
    // A tier is resolved by membership, never by a string-keyed lookup table:
    // `Object.prototype` is reachable by name from any plain object, so a table
    // would resolve `"constructor"` to a function and hand it back as a tier.
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
        data: { aiType: "master", counterfactualFarmer: false },
      })),
    ).toEqual({ settings: DEFAULT_AI_SETTINGS, writable: false });
  });

  it("encodes a small versioned document independently of the app version", () => {
    expect(JSON.parse(encodeAiSettingsDocument({ aiType: "casual", counterfactualFarmer: false }))).toEqual({
      schemaVersion: 1,
      data: { aiType: "casual", counterfactualFarmer: false },
    });
  });
});
