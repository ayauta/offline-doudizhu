import { render } from "preact";

import { createProductionSession } from "./app/session/production-session.js";
import { createDeck, shuffle } from "./core/cards/index.js";
import {
  createWebRandomSource,
  scheduleWebPresentation,
} from "./platform/web/presentation.js";
import { createWebAiDecisionService } from "./platform/web/ai-worker-client.js";
import { createBrowserSettingsStore } from "./platform/web/settings-storage.js";
import { ProductionTableApp } from "./ui/production-table-app.js";
import "./ui/styles.css";

const root = document.querySelector("#app");
if (root === null) {
  throw new Error("Application root is missing.");
}

const random = createWebRandomSource();
const session = createProductionSession({
  aiDecisionService: createWebAiDecisionService(),
  deckSource: {
    nextDeck: () => shuffle(createDeck(), random),
  },
  scheduler: {
    schedule: scheduleWebPresentation,
  },
  settingsStore: createBrowserSettingsStore(),
});

render(<ProductionTableApp session={session} />, root);
