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
      // An absent champion field now means **on**, not off: a document written
      // before the field existed records that the player never chose, and the
      // product default is AI-v2. The tier the player did choose is preserved.
      settings: Object.freeze({ aiType: "master", counterfactualFarmer: true, cheapLandlord: true }),
      writable: true,
    });
  });

  it("lets a document pin the champion off, and only an explicit false does", () => {
    const decode = (data: Record<string, unknown>) =>
      decodeAiSettingsDocument(JSON.stringify({ schemaVersion: 1, data })).settings;
    expect(decode({ aiType: "master", cheapLandlord: false }).cheapLandlord).toBe(false);
    expect(decode({ aiType: "master", counterfactualFarmer: false }).counterfactualFarmer).toBe(false);
    // Anything that is not the literal `false` -- absent, null, a stray string
    // -- is the default. A truthiness test here would let `0` or `""` silently
    // disable the production champion.
    expect(decode({ aiType: "master", cheapLandlord: null }).cheapLandlord).toBe(true);
    expect(decode({ aiType: "master", cheapLandlord: 0 }).cheapLandlord).toBe(true);
    expect(decode({ aiType: "master", cheapLandlord: "false" }).cheapLandlord).toBe(true);
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
        data: { aiType: "master", counterfactualFarmer: false, cheapLandlord: false },
      })),
    ).toEqual({ settings: DEFAULT_AI_SETTINGS, writable: false });
  });

  it("encodes a small versioned document independently of the app version", () => {
    expect(
      JSON.parse(encodeAiSettingsDocument({ aiType: "casual", counterfactualFarmer: false, cheapLandlord: true })),
    ).toEqual({
      schemaVersion: 1,
      data: { aiType: "casual", counterfactualFarmer: false, cheapLandlord: true },
    });
  });
});
