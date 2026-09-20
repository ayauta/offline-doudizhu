export const AI_TYPES = Object.freeze([
  "casual",
  "default",
  "master",
] as const);

export type AiType = (typeof AI_TYPES)[number];

export type AiSettings = Readonly<{
  aiType: AiType;
  /**
   * Experimental. Enables the frozen counterfactual farmer selector for
   * Master-level seats.
   *
   * It is a settings field rather than a build flag so that the validated build
   * and the measured build are the same artifact, and it defaults to false so
   * that stored settings written before this field existed decode to the
   * shipped behaviour. There is deliberately no UI: the mechanism is not a
   * product KEEP until the independent validation says so, and after that
   * decision the field either becomes the default or is deleted.
   */
  counterfactualFarmer: boolean;
}>;

export type DecodedAiSettings = Readonly<{
  settings: AiSettings;
  writable: boolean;
}>;

export const AI_SETTINGS_SCHEMA_VERSION = 1;

export const DEFAULT_AI_SETTINGS: AiSettings = Object.freeze({
  aiType: "default",
  counterfactualFarmer: false,
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
  // Absent means false, so stored settings written before the field existed
  // keep decoding to shipped behaviour rather than becoming unreadable.
  const counterfactualFarmer = isRecord(data) && data.counterfactualFarmer === true;
  return Object.freeze({
    settings: Object.freeze({ aiType, counterfactualFarmer }),
    writable: true,
  });
}

export function encodeAiSettingsDocument(settings: AiSettings): string {
  return JSON.stringify({
    schemaVersion: AI_SETTINGS_SCHEMA_VERSION,
    data: {
      aiType: settings.aiType,
      counterfactualFarmer: settings.counterfactualFarmer,
    },
  });
}
