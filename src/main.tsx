import { render } from "preact";

import { createDebugHand } from "./app/session/debug-hand.js";
import { createDebugSession } from "./app/session/debug-state.js";
import { registerOfflineWorker } from "./platform/web/offline.js";
import { DebugTableApp } from "./ui/debug-table-app.js";
import "./ui/styles.css";

const root = document.querySelector("#app");
if (root === null) {
  throw new Error("Application root is missing.");
}

render(
  <DebugTableApp cards={createDebugHand()} session={createDebugSession()} />,
  root,
);
registerOfflineWorker();
