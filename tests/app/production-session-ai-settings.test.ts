import { describe, expect, it } from "vitest";

import type {
  AiDecisionOutcome,
  EnhancedAiDecisionService,
  EnhancedAiType,
} from "../../src/app/ports/ai-decision-service.js";
import type { SettingsStore } from "../../src/app/ports/settings-store.js";
import {
  createProductionSession,
  type PresentationScheduler,
} from "../../src/app/session/production-session.js";
import type { AiSettings, AiType } from "../../src/app/settings/ai-settings.js";
import type { AiDecisionContext } from "../../src/core/ai/index.js";
import { createDeck } from "../../src/core/cards/index.js";

class ManualScheduler implements PresentationScheduler {
  readonly tasks: Array<{ active: boolean; at: number; callback: () => void }> = [];
  clock = 0;

  schedule(delayMs: number, callback: () => void): () => void {
    const task = { active: true, at: this.clock + delayMs, callback };
    this.tasks.push(task);
    return () => { task.active = false; };
  }

  runNext(): void {
    const next = this.tasks
      .filter(({ active }) => active)
      .sort((left, right) => left.at - right.at)[0];
    if (next === undefined) {
      throw new Error("Expected scheduled work.");
    }
    next.active = false;
    this.clock = next.at;
    next.callback();
  }
}

class MemorySettingsStore implements SettingsStore {
  settings: AiSettings;
  readonly saves: AiSettings[] = [];

  constructor(aiType: AiType) {
    this.settings = Object.freeze({ aiType });
  }

  load(): AiSettings {
    return this.settings;
  }

  save(settings: AiSettings): void {
    this.settings = Object.freeze({ ...settings });
    this.saves.push(this.settings);
  }
}

class ManualAiService implements EnhancedAiDecisionService {
  readonly requests: Array<{
    active: boolean;
    aiType: EnhancedAiType;
    context: AiDecisionContext;
    complete: (outcome: AiDecisionOutcome) => void;
  }> = [];
  disposed = false;

  request(
    aiType: EnhancedAiType,
    context: AiDecisionContext,
    complete: (outcome: AiDecisionOutcome) => void,
  ): () => void {
    const request = { active: true, aiType, context, complete };
    this.requests.push(request);
    return () => { request.active = false; };
  }

  respond(index: number, outcome: AiDecisionOutcome): void {
    const request = this.requests[index];
    if (request?.active) {
      request.active = false;
      request.complete(outcome);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const request of this.requests) {
      request.active = false;
    }
  }
}

function sessionWith(aiType: AiType) {
  const scheduler = new ManualScheduler();
  const settingsStore = new MemorySettingsStore(aiType);
  const aiDecisionService = new ManualAiService();
  const session = createProductionSession({
    aiDecisionService,
    deckSource: { nextDeck: () => createDeck() },
    scheduler,
    settingsStore,
  });
  return { aiDecisionService, scheduler, session, settingsStore };
}

describe("production AI setting and worker integration", () => {
  it("loads and immediately saves a home-only selection, then locks it for the match", () => {
    const fixture = sessionWith("expert");

    expect(fixture.session.getView()).toEqual({ screen: "home", aiType: "expert" });
    fixture.session.dispatch({ type: "set-ai-type", aiType: "casual" });
    expect(fixture.session.getView()).toEqual({ screen: "home", aiType: "casual" });
    expect(fixture.settingsStore.saves).toEqual([{ aiType: "casual" }]);

    fixture.session.dispatch({ type: "start-game" });
    fixture.session.dispatch({ type: "set-ai-type", aiType: "master" });
    fixture.session.dispatch({ type: "bid", decision: "decline" });

    expect(fixture.settingsStore.saves).toHaveLength(1);
    expect(fixture.aiDecisionService.requests[0]?.aiType).toBe("casual");
  });

  it("starts enhanced work immediately but preserves the existing presentation beat", () => {
    const fixture = sessionWith("expert");
    fixture.session.dispatch({ type: "start-game" });
    fixture.session.dispatch({ type: "bid", decision: "decline" });
    expect(fixture.aiDecisionService.requests).toHaveLength(1);
    expect(fixture.session.getView()).toMatchObject({ currentSeat: "ai-one" });

    fixture.aiDecisionService.respond(0, {
      ok: true,
      command: { type: "bid", seat: "ai-one", decision: "call" },
    });
    expect(fixture.session.getView()).toMatchObject({ currentSeat: "ai-one", landlord: null });

    fixture.scheduler.runNext();
    expect(fixture.session.getView()).toMatchObject({
      currentSeat: "ai-one",
      landlord: "ai-one",
      aiFallbackNotice: false,
    });
  });

  it("falls back without delaying the beat and shows one non-blocking notice", () => {
    const fixture = sessionWith("master");
    fixture.session.dispatch({ type: "start-game" });
    fixture.session.dispatch({ type: "bid", decision: "decline" });
    fixture.aiDecisionService.respond(0, { ok: false });

    expect(fixture.session.getView()).toMatchObject({
      currentSeat: "ai-one",
      aiFallbackNotice: true,
    });
    fixture.scheduler.runNext();
    expect(fixture.session.getView()).not.toMatchObject({ currentSeat: "ai-one" });
  });

  it("cancels a late worker request at the response deadline and still uses the original beat", () => {
    const fixture = sessionWith("master");
    fixture.session.dispatch({ type: "start-game" });
    fixture.session.dispatch({ type: "bid", decision: "decline" });
    const request = fixture.aiDecisionService.requests[0];
    expect(request?.active).toBe(true);

    fixture.scheduler.runNext();
    expect(request?.active).toBe(false);
    expect(fixture.session.getView()).toMatchObject({
      currentSeat: "ai-one",
      aiFallbackNotice: true,
    });

    fixture.scheduler.runNext();
    expect(fixture.session.getView()).not.toMatchObject({ currentSeat: "ai-one" });
  });

  it("never sends the unchanged default path or human hints to the worker", () => {
    const fixture = sessionWith("default");
    fixture.session.dispatch({ type: "start-game" });
    fixture.session.dispatch({ type: "bid", decision: "call" });
    fixture.session.dispatch({ type: "hint" });

    expect(fixture.aiDecisionService.requests).toHaveLength(0);
    expect(fixture.session.getView()).toMatchObject({ playEnabled: true });

    fixture.session.dispose();
    expect(fixture.aiDecisionService.disposed).toBe(true);
  });
});
