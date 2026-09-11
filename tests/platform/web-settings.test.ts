import { describe, expect, it } from "vitest";

import { DEFAULT_AI_SETTINGS } from "../../src/app/settings/ai-settings.js";
import {
  SETTINGS_STORAGE_KEY,
  createWebSettingsStore,
  type StringStorage,
} from "../../src/platform/web/settings-storage.js";

class MemoryStorage implements StringStorage {
  readonly values = new Map<string, string>();
  writes = 0;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes += 1;
    this.values.set(key, value);
  }
}

describe("Web settings storage", () => {
  it("saves and restores the selected AI type", () => {
    const storage = new MemoryStorage();
    const store = createWebSettingsStore(storage);

    expect(store.load()).toBe(DEFAULT_AI_SETTINGS);
    store.save({ aiType: "expert" });

    expect(createWebSettingsStore(storage).load()).toEqual({ aiType: "expert" });
    expect(storage.writes).toBe(1);
  });

  it("preserves an unsupported future document instead of overwriting it", () => {
    const storage = new MemoryStorage();
    storage.values.set(SETTINGS_STORAGE_KEY, JSON.stringify({
      schemaVersion: 7,
      data: { aiType: "master" },
    }));
    const store = createWebSettingsStore(storage);

    expect(store.load()).toBe(DEFAULT_AI_SETTINGS);
    store.save({ aiType: "casual" });

    expect(storage.writes).toBe(0);
    expect(JSON.parse(storage.values.get(SETTINGS_STORAGE_KEY)!)).toMatchObject({
      schemaVersion: 7,
    });
  });

  it("turns storage exceptions into a safe default and no-op save", () => {
    const storage: StringStorage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("full");
      },
    };
    const store = createWebSettingsStore(storage);

    expect(store.load()).toBe(DEFAULT_AI_SETTINGS);
    expect(() => store.save({ aiType: "master" })).not.toThrow();
  });
});
