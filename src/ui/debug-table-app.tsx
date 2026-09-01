import {
  type TargetedPointerEvent,
} from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import type { DebugAction, DebugSession, DebugState } from "../app/session/debug-state.js";
import { asCardId, type Card, type CardId } from "../core/cards/index.js";
import { CardFace } from "./components/card-face.js";
import {
  INITIAL_POINTER_SELECTION_STATE,
  reducePointerSelection,
  type PointerSelectionEvent,
  type PointerSelectionState,
  type SelectionChange,
} from "./input/pointer-selection.js";

const ACTIONS: ReadonlyArray<readonly [DebugAction, string]> = [
  ["pass", "不出"],
  ["hint", "提示"],
  ["play", "出牌"],
];

const ACTION_LABELS: Readonly<Record<DebugAction, string>> = {
  hint: "提示",
  pass: "不出",
  play: "出牌",
};

interface DebugTableAppProps {
  readonly cards: readonly Card[];
  readonly session: DebugSession;
}

function useDebugView(session: DebugSession): DebugState {
  const [view, setView] = useState(session.getView());
  useEffect(
    () => session.subscribe(() => setView(session.getView())),
    [session],
  );
  return view;
}

function cardIdFromElement(element: Element | null): CardId | null {
  const rawId = (element?.closest("[data-card-id]") as HTMLElement | null)
    ?.dataset.cardId;
  if (rawId === undefined) {
    return null;
  }
  const value = Number(rawId);
  return Number.isInteger(value) && value >= 0 && value < 54
    ? asCardId(value)
    : null;
}

export function DebugTableApp({ cards, session }: DebugTableAppProps) {
  const view = useDebugView(session);
  const [selected, setSelected] = useState<ReadonlySet<CardId>>(new Set());
  const pointerState = useRef<PointerSelectionState<CardId>>(
    INITIAL_POINTER_SELECTION_STATE,
  );

  function commit(changes: readonly SelectionChange<CardId>[]) {
    if (changes.length === 0) {
      return;
    }
    setSelected((previous) => {
      const next = new Set(previous);
      for (const change of changes) {
        if (change.selected) {
          next.add(change.cardId);
        } else {
          next.delete(change.cardId);
        }
      }
      return next;
    });
  }

  function apply(event: PointerSelectionEvent<CardId>) {
    const result = reducePointerSelection(pointerState.current, event);
    pointerState.current = result.state;
    commit(result.changes);
  }

  function startPointer(event: TargetedPointerEvent<HTMLDivElement>) {
    const cardId = cardIdFromElement(event.target as Element | null);
    if (cardId === null) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    apply({
      cardId,
      point: { x: event.clientX, y: event.clientY },
      pointerId: event.pointerId,
      selected: selected.has(cardId),
      type: "start",
    });
  }

  function movePointer(event: TargetedPointerEvent<HTMLDivElement>) {
    if (pointerState.current.active === null) {
      return;
    }
    const element = event.currentTarget.ownerDocument.elementFromPoint(
      event.clientX,
      event.clientY,
    );
    apply({
      cardId: cardIdFromElement(element),
      point: { x: event.clientX, y: event.clientY },
      pointerId: event.pointerId,
      type: "move",
    });
  }

  function finishPointer(
    event: TargetedPointerEvent<HTMLDivElement>,
    type: "end" | "cancel",
  ) {
    apply({ pointerId: event.pointerId, type });
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function toggleFromKeyboard(card: Card) {
    commit([{ cardId: card.id, selected: !selected.has(card.id) }]);
  }

  const actionMessage = view.lastAction === null
    ? "尚未执行调试动作"
    : `上次：${ACTION_LABELS[view.lastAction]}（调试）· 共 ${view.actionCount} 次`;

  return (
    <div class="app-shell">
      <section class="rotate-gate" aria-label="屏幕方向提示">
        <div class="rotate-gate__device" aria-hidden="true">↻</div>
        <h1>请旋转手机</h1>
        <p>横屏后即可继续</p>
      </section>

      <main class="table-screen" aria-label="单机斗地主架构验证桌面">
        <header class="table-header">
          <div>
            <h1>单机斗地主</h1>
            <p>架构验证 · 非正式牌局</p>
          </div>
          <span class="offline-badge">本地离线</span>
        </header>

        <section class="table-center" aria-label="对手占位信息">
          <div class="opponent"><span aria-hidden="true">电脑</span><strong>17 张</strong></div>
          <p>当前切片仅验证显示与选牌</p>
          <div class="opponent"><span aria-hidden="true">电脑</span><strong>17 张</strong></div>
        </section>

        <output class="debug-status" aria-live="polite">
          <span>{actionMessage}</span>
          <span>已选 {selected.size} 张</span>
        </output>

        <div
          class="hand"
          aria-label="你的模拟手牌"
          onPointerCancel={(event) => finishPointer(event, "cancel")}
          onPointerDown={startPointer}
          onPointerMove={movePointer}
          onPointerUp={(event) => finishPointer(event, "end")}
        >
          {cards.map((card, index) => (
            <CardFace
              card={card}
              index={index}
              key={card.id}
              onKeyboardActivate={toggleFromKeyboard}
              selected={selected.has(card.id)}
            />
          ))}
        </div>

        <nav class="table-actions" aria-label="调试动作">
          {ACTIONS.map(([action, label]) => (
            <button
              class={`action-button action-button--${action}`}
              key={action}
              onClick={() => session.dispatch(action)}
              type="button"
            >
              {label}
            </button>
          ))}
        </nav>
      </main>
    </div>
  );
}
