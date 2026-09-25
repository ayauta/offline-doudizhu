export const AI_TYPES = Object.freeze([
  "casual",
  "default",
  "master",
] as const);

export type AiType = (typeof AI_TYPES)[number];

/**
 * AI-v2, the promoted production champion, is exactly these two fields.
 *
 *   - `cheapLandlord`  the CHEAP full-action landlord policy, confirmed on a
 *                      fresh pool in two environments (`+9.400pp` against
 *                      π1/π1 farmers, `+3.450pp` against default/default) and
 *                      qualified on a physical phone through the shipped
 *                      Worker.
 *   - `counterfactualFarmer`  the π1 farmer selector, Spec 063 final
 *                      validation (farmer `+10.583pp`, combined `+5.292pp`).
 *
 * Both act on the master tier only. `casual` and `default` are untouched: the
 * tier a player picks is a difficulty decision, and it is not this field's job.
 *
 * **Both default to true, and both decode an absent value as true.** That is an
 * inversion of what this file used to do, and it is the point of the change: a
 * stored record that predates a field says only that the player never chose,
 * and the product default is now the champion. `aiType` is untouched by it, so
 * a player who picked a tier keeps it.
 *
 * There is still deliberately no UI. These are not preferences; they are which
 * policy is production, and a control that could silently turn the champion off
 * would make "the validated build and the measured build are the same artifact"
 * false again.
 */
export type AiSettings = Readonly<{
  aiType: AiType;
  counterfactualFarmer: boolean;
  cheapLandlord: boolean;
}>;

export type DecodedAiSettings = Readonly<{
  settings: AiSettings;
  writable: boolean;
}>;

export const AI_SETTINGS_SCHEMA_VERSION = 1;

export const DEFAULT_AI_SETTINGS: AiSettings = Object.freeze({
  aiType: "default",
  counterfactualFarmer: true,
  cheapLandlord: true,
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAiType(value: unknown): value is AiType {
  return typeof value === "string" && (AI_TYPES as readonly string[]).includes(value);
}

export function decodeAiSettingsDocument(raw: string | null): DecodedAiSettings {
  if (raw === null) {
    return Object.freeze({ settings: DEFAULT_AI_SETTINGS, writable: true });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return Object.freeze({ settings: DEFAULT_AI_SETTINGS, writable: true });
  }

  if (!isRecord(payload)) {
    return Object.freeze({ settings: DEFAULT_AI_SETTINGS, writable: true });
  }
  if (payload.schemaVersion !== AI_SETTINGS_SCHEMA_VERSION) {
    return Object.freeze({
      settings: DEFAULT_AI_SETTINGS,
      writable: payload.schemaVersion !== undefined &&
        typeof payload.schemaVersion === "number" &&
        payload.schemaVersion > AI_SETTINGS_SCHEMA_VERSION
        ? false
        : true,
    });
  }

  const data = payload.data;
  const aiType = isRecord(data) && isAiType(data.aiType)
    ? data.aiType
    : DEFAULT_AI_SETTINGS.aiType;
  // Absent means **the default**, which is now `true` for both champion fields:
  // a stored settings blob written before the field existed says only that the
  // chose, and the product default is AI-v2. An explicit `false` is still
  // honoured, so a stored value can still pin the old behaviour.
  const counterfactualFarmer = !(isRecord(data) && data.counterfactualFarmer === false);
  const cheapLandlord = !(isRecord(data) && data.cheapLandlord === false);
  return Object.freeze({
    settings: Object.freeze({ aiType, counterfactualFarmer, cheapLandlord }),
    writable: true,
  });
}

export function encodeAiSettingsDocument(settings: AiSettings): string {
  return JSON.stringify({
    schemaVersion: AI_SETTINGS_SCHEMA_VERSION,
    data: {
      aiType: settings.aiType,
      counterfactualFarmer: settings.counterfactualFarmer,
      cheapLandlord: settings.cheapLandlord,
    },
  });
}
