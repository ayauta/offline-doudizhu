import type { SettingsStore } from "../../app/ports/settings-store.js";
import {
  DEFAULT_AI_SETTINGS,
  decodeAiSettingsDocument,
  encodeAiSettingsDocument,
  type AiSettings,
} from "../../app/settings/ai-settings.js";

export const SETTINGS_STORAGE_KEY = "offline-doudizhu.settings";

export interface StringStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

export function createWebSettingsStore(storage: StringStorage): SettingsStore {
  let writable = true;
  return Object.freeze({
    load() {
      try {
        const decoded = decodeAiSettingsDocument(storage.getItem(SETTINGS_STORAGE_KEY));
        writable = decoded.writable;
        return decoded.settings;
      } catch {
        writable = true;
        return DEFAULT_AI_SETTINGS;
      }
    },
    save(settings: AiSettings) {
      if (!writable) {
        return;
      }
      try {
        storage.setItem(SETTINGS_STORAGE_KEY, encodeAiSettingsDocument(settings));
      } catch {
        // Storage is an optional convenience; private mode/quota failures never
        // prevent a local game from continuing with the in-memory selection.
      }
    },
  });
}

export function createBrowserSettingsStore(): SettingsStore {
  return createWebSettingsStore({
    getItem(key) {
      return globalThis.localStorage.getItem(key);
    },
    setItem(key, value) {
      globalThis.localStorage.setItem(key, value);
    },
  });
}
