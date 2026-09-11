import type { AiSettings } from "../settings/ai-settings.js";

export interface SettingsStore {
  readonly load: () => AiSettings;
  readonly save: (settings: AiSettings) => void;
}
