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

  advanceTo(target: number): void {
    for (;;) {
      const next = this.tasks
        .filter(({ active, at }) => active && at <= target)
        .sort((left, right) => left.at - right.at)[0];
      if (next === undefined) {
        this.clock = target;
        return;
      }
      next.active = false;
      this.clock = next.at;
      next.callback();
    }
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
  beginMatchCalls = 0;

  beginMatch(): void {
    this.beginMatchCalls += 1;
  }

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

  it("uses Default for the rest of a match only when the Worker is unavailable", () => {
    const fixture = sessionWith("master");
    fixture.session.dispatch({ type: "start-game" });
    fixture.session.dispatch({ type: "bid", decision: "decline" });
    fixture.aiDecisionService.respond(0, { ok: false, reason: "unavailable" });

    expect(fixture.session.getView()).toMatchObject({
      currentSeat: "ai-one",
      aiFallbackNotice: false,
    });
    fixture.scheduler.runNext();
    expect(fixture.session.getView()).not.toMatchObject({ currentSeat: "ai-one" });
    expect(fixture.session.getView()).toMatchObject({ aiFallbackNotice: true });
    expect(fixture.aiDecisionService.requests).toHaveLength(1);

    fixture.session.dispatch({ type: "request-exit" });
    fixture.session.dispatch({ type: "confirm-exit" });
    fixture.session.dispatch({ type: "start-game" });
    expect(fixture.aiDecisionService.beginMatchCalls).toBe(2);
  });

  it("silently falls back for one transient request failure and keeps the enhanced level", () => {
    const fixture = sessionWith("master");
    fixture.session.dispatch({ type: "start-game" });
    fixture.session.dispatch({ type: "bid", decision: "decline" });
    fixture.aiDecisionService.respond(0, { ok: false, reason: "failed" });

    fixture.scheduler.runNext();
    expect(fixture.session.getView()).toMatchObject({ aiFallbackNotice: false });
    expect(fixture.aiDecisionService.requests.length).toBeGreaterThan(1);
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
      aiFallbackNotice: false,
    });

    fixture.scheduler.runNext();
    expect(fixture.session.getView()).not.toMatchObject({ currentSeat: "ai-one" });
  });

  it("accepts a cold worker response after 180 ms without changing the presentation beat", () => {
    const fixture = sessionWith("master");
    fixture.session.dispatch({ type: "start-game" });
    fixture.session.dispatch({ type: "bid", decision: "decline" });

    fixture.scheduler.advanceTo(300);
    fixture.aiDecisionService.respond(0, {
      ok: true,
      command: { type: "bid", seat: "ai-one", decision: "call" },
    });

    expect(fixture.session.getView()).toMatchObject({
      currentSeat: "ai-one",
      aiFallbackNotice: false,
    });
    fixture.scheduler.runNext();
    expect(fixture.scheduler.clock).toBe(520);
    expect(fixture.session.getView()).toMatchObject({
      landlord: "ai-one",
      aiFallbackNotice: false,
    });
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
