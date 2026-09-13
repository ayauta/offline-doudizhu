export const AI_TYPES = Object.freeze([
  "casual",
  "default",
  "master",
] as const);

export type AiType = (typeof AI_TYPES)[number];

/**
 * Tiers that a shipped version persisted and a later version removed.
 *
 * Stored documents still carry these ids. Decoding them onto their surviving
 * tier keeps the player's choice; falling back to `DEFAULT_AI_SETTINGS` would
 * silently demote them. Bumping `AI_SETTINGS_SCHEMA_VERSION` is not an option:
 * the version guard below resets *every* stored tier, including the ones that
 * did not change.
 */
const LEGACY_AI_TYPE_ALIASES: Readonly<Record<string, AiType>> = Object.freeze({
  // Spec 055 merged the expert and master tiers; master's search survived.
  expert: "master",
});

export type AiSettings = Readonly<{
  aiType: AiType;
}>;

export type DecodedAiSettings = Readonly<{
  settings: AiSettings;
  writable: boolean;
}>;

export const AI_SETTINGS_SCHEMA_VERSION = 1;

export const DEFAULT_AI_SETTINGS: AiSettings = Object.freeze({
  aiType: "default",
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAiType(value: unknown): value is AiType {
  return typeof value === "string" && (AI_TYPES as readonly string[]).includes(value);
}

function resolveAiType(value: unknown): AiType {
  if (isAiType(value)) {
    return value;
  }
  const alias = typeof value === "string" ? LEGACY_AI_TYPE_ALIASES[value] : undefined;
  return alias ?? DEFAULT_AI_SETTINGS.aiType;
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
  const aiType = isRecord(data) ? resolveAiType(data.aiType) : DEFAULT_AI_SETTINGS.aiType;
  return Object.freeze({
    settings: Object.freeze({ aiType }),
    writable: true,
  });
}

export function encodeAiSettingsDocument(settings: AiSettings): string {
  return JSON.stringify({
    schemaVersion: AI_SETTINGS_SCHEMA_VERSION,
    data: { aiType: settings.aiType },
  });
}
