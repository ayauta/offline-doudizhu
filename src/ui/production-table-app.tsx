import type { TargetedPointerEvent } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

import type {
  MatchView,
  ProductionControl,
  ProductionSession,
  PublicTableAction,
  SeatRole,
} from "../app/session/production-session.js";
import { asCardId, type CardId } from "../core/cards/index.js";
import type { BidDecision } from "../core/game/index.js";
import type { PlayPatternKind } from "../core/rules/index.js";
import { CardBack, HandCard, TableCard } from "./components/card-face.js";
import {
  cardsCrossedByPointerSegment,
  INITIAL_POINTER_SELECTION_STATE,
  reducePointerSelection,
  type PointerHitRegion,
  type PointerPoint,
  type PointerSelectionEvent,
  type PointerSelectionState,
} from "./input/pointer-selection.js";
import { handNaturalWidth } from "./layout/hand-layout.js";

const PATTERN_LABELS: Partial<Record<PlayPatternKind, string>> = {
  straight: "顺子",
  "consecutive-pairs": "连对",
  airplane: "飞机",
  "airplane-with-singles": "飞机",
  "airplane-with-pairs": "飞机",
  "four-with-two-cards": "四带二",
  "four-with-two-pairs": "四带二",
  bomb: "炸弹",
  rocket: "王炸",
};

const ROLE_LABELS: Readonly<Record<SeatRole, string>> = {
  farmer: "农民",
  landlord: "地主",
};

const BID_LABELS: Readonly<Record<BidDecision, string>> = {
  call: "叫地主",
  decline: "不叫",
};

interface ProductionTableAppProps {
  readonly session: ProductionSession;
}

function useProductionView(session: ProductionSession) {
  const [view, setView] = useState(session.getView());
  useEffect(
    () => session.subscribe(() => setView(session.getView())),
    [session],
  );
  return view;
}

function cardIdFromElement(element: Element | null): CardId | null {
  const rawId = (element?.closest("[data-card-id]") as HTMLElement | null)?.dataset.cardId;
  if (rawId === undefined) {
    return null;
  }
  const value = Number(rawId);
  return Number.isInteger(value) && value >= 0 && value < 54 ? asCardId(value) : null;
}

const HAND_POINTER_CORRIDOR = 16;

function handPointerHitRegions(hand: HTMLDivElement): readonly PointerHitRegion<CardId>[] {
  const cards = Array.from(hand.querySelectorAll<HTMLElement>("[data-card-id]"));
  const measured = cards.flatMap((card) => {
    const cardId = cardIdFromElement(card);
    return cardId === null ? [] : [{ cardId, rectangle: card.getBoundingClientRect() }];
  });
  if (measured.length === 0) {
    return [];
  }
  const top = Math.min(...measured.map(({ rectangle }) => rectangle.top)) - HAND_POINTER_CORRIDOR;
  const bottom = Math.max(...measured.map(({ rectangle }) => rectangle.bottom)) + HAND_POINTER_CORRIDOR;
  return measured.map(({ cardId, rectangle }, index) => ({
    bottom,
    cardId,
    left: rectangle.left,
    right: measured[index + 1]?.rectangle.left ?? rectangle.right,
    top,
  }));
}

function coalescedPointerPoints(event: TargetedPointerEvent<HTMLDivElement>): readonly PointerPoint[] {
  const coalesced = typeof event.getCoalescedEvents === "function"
    ? event.getCoalescedEvents()
    : [];
  const points = coalesced.map(({ clientX: x, clientY: y }) => ({ x, y }));
  const finalPoint = { x: event.clientX, y: event.clientY };
  const lastPoint = points.at(-1);
  if (lastPoint?.x !== finalPoint.x || lastPoint.y !== finalPoint.y) {
    points.push(finalPoint);
  }
  return points;
}

function TableAction({ action }: Readonly<{ action: PublicTableAction | null }>) {
  if (action === null) {
    return null;
  }
  if (action.type === "pass") {
    return <span class="seat-action__pass">不出</span>;
  }
  const label = action.leading ? PATTERN_LABELS[action.pattern] : undefined;
  return (
    <div
      class={`seat-action__play seat-action__play--${action.weight}`}
      data-pattern={action.pattern}
    >
      <div class="table-card-group">
        {action.cards.map((cardId) => <TableCard cardId={cardId} key={cardId} />)}
      </div>
      {label === undefined ? null : <span class="pattern-label">{label}</span>}
    </div>
  );
}

function SeatAction({
  action,
  bid,
}: Readonly<{
  action: PublicTableAction | null;
  bid: BidDecision | null;
}>) {
  if (bid !== null) {
    return <span class="seat-action__bid">{BID_LABELS[bid]}</span>;
  }
  return <TableAction action={action} />;
}

function RemainingCount({
  count,
  low,
}: Readonly<{ count: number; low: boolean }>) {
  return (
    <strong class={`remaining-count${low ? " remaining-count--low" : ""}`}>
      {count}
    </strong>
  );
}

function OpponentSeat({
  side,
  seat,
  view,
}: Readonly<{
  side: "left" | "right";
  seat: "ai-one" | "ai-two";
  view: MatchView;
}>) {
  const count = view.remainingCardCounts[seat];
  const low = view.lowCardSeats.includes(seat);
  const role = view.roles[seat];
  return (
    <section
      aria-label={`${side === "left" ? "左侧" : "右侧"}玩家，剩余${count}张牌${role === null ? "" : `，${ROLE_LABELS[role]}`}`}
      class={`opponent-seat opponent-seat--${side}${view.currentSeat === seat ? " is-current" : ""}`}
    >
      <div class="opponent-status" aria-hidden="true">
        <div class="opponent-stack">
          <CardBack />
          <CardBack />
          <CardBack />
          <RemainingCount count={count} low={low} />
        </div>
        {role === null ? null : <span class="opponent-role">{ROLE_LABELS[role]}</span>}
      </div>
      <span aria-atomic="true" aria-live="polite" class="opponent-low-announcement">
        {low ? `${side === "left" ? "左侧" : "右侧"}玩家只剩${count}张牌` : ""}
      </span>
      <div class="seat-action">
        <SeatAction action={view.tableActions[seat]} bid={view.biddingActions[seat]} />
      </div>
    </section>
  );
}

function BottomCards({ view }: Readonly<{ view: MatchView }>) {
  return (
    <div class={`bottom-cards${view.bottomCards === null ? "" : " bottom-cards--revealed"}`} aria-label="三张底牌">
      {view.bottomCards === null
        ? Array.from({ length: view.bottomCardCount }, (_, index) => (
            <CardBack label={`未揭晓底牌${index + 1}`} key={index} />
          ))
        : view.bottomCards.map((cardId) => <TableCard cardId={cardId} key={cardId} />)}
    </div>
  );
}

function ActionButton({
  control,
  disabled = false,
  label,
  onClick,
  tone = "secondary",
}: Readonly<{
  control: ProductionControl | "cancel-exit" | "confirm-exit";
  disabled?: boolean;
  label: string;
  onClick: () => void;
  tone?: "primary" | "secondary" | "destructive";
}>) {
  return (
    <button
      class={`action-button action-button--${tone}`}
      data-control={control}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function MatchControls({ session, view }: Readonly<ProductionTableAppProps & { view: MatchView }>) {
  if (view.controls.length === 0) {
    return <div class="match-controls" aria-hidden="true" />;
  }
  return (
    <nav class={`match-controls match-controls--${view.controls.length}`} aria-label="当前操作">
      {view.controls.map((control) => {
        switch (control) {
          case "bid-decline":
            return <ActionButton control={control} key={control} label="不叫" onClick={() => session.dispatch({ type: "bid", decision: "decline" })} />;
          case "bid-call":
            return <ActionButton control={control} key={control} label="叫地主" onClick={() => session.dispatch({ type: "bid", decision: "call" })} tone="primary" />;
          case "pass":
            return <ActionButton control={control} key={control} label="不出" onClick={() => session.dispatch({ type: "pass" })} />;
          case "hint":
            return <ActionButton control={control} key={control} label="提示" onClick={() => session.dispatch({ type: "hint" })} />;
          case "play":
            return <ActionButton control={control} disabled={!view.playEnabled} key={control} label="出牌" onClick={() => session.dispatch({ type: "play" })} tone="primary" />;
          case "home":
            return <ActionButton control={control} key={control} label="返回首页" onClick={() => session.dispatch({ type: "request-exit" })} />;
          case "restart":
            return <ActionButton control={control} key={control} label="再来一局" onClick={() => session.dispatch({ type: "restart" })} tone="primary" />;
        }
      })}
    </nav>
  );
}

function HumanHand({ session, view }: Readonly<ProductionTableAppProps & { view: MatchView }>) {
  const handElement = useRef<HTMLDivElement>(null);
  const activePointer = useRef<{
    readonly hitRegions: readonly PointerHitRegion<CardId>[];
    readonly point: PointerPoint;
    readonly pointerId: number;
  } | null>(null);
  const previousCardPositions = useRef<ReadonlyMap<CardId, number>>(new Map());
  const previousHandCount = useRef<number | null>(null);
  const pointerState = useRef<PointerSelectionState<CardId>>(INITIAL_POINTER_SELECTION_STATE);
  const selected = new Set(view.selectedCardIds);

  useLayoutEffect(() => {
    const hand = handElement.current;
    if (hand === null) {
      return;
    }
    const currentPositions = new Map<CardId, number>();
    for (const card of hand.querySelectorAll<HTMLElement>("[data-card-id]")) {
      const cardId = cardIdFromElement(card);
      if (cardId !== null) {
        currentPositions.set(cardId, card.getBoundingClientRect().left);
      }
    }

    const previousCount = previousHandCount.current;
    const reducedMotion = hand.ownerDocument.defaultView
      ?.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
    if (previousCount !== null && view.humanHand.length < previousCount && !reducedMotion) {
      const regroupEasing = getComputedStyle(hand).getPropertyValue("--ease-in-out").trim();
      for (const card of hand.querySelectorAll<HTMLElement>("[data-card-id]")) {
        const cardId = cardIdFromElement(card);
        const previousLeft = cardId === null ? undefined : previousCardPositions.current.get(cardId);
        const currentLeft = cardId === null ? undefined : currentPositions.get(cardId);
        if (previousLeft === undefined || currentLeft === undefined) {
          continue;
        }
        const offset = previousLeft - currentLeft;
        if (Math.abs(offset) < 0.5) {
          continue;
        }
        const animation = card.animate(
          [{ translate: `${offset}px 0` }, { translate: "0 0" }],
          { duration: 180, easing: regroupEasing },
        );
        animation.id = "hand-regroup";
      }
    }
    previousCardPositions.current = currentPositions;
    previousHandCount.current = view.humanHand.length;
  });

  function apply(event: PointerSelectionEvent<CardId>) {
    const result = reducePointerSelection(pointerState.current, event);
    pointerState.current = result.state;
    if (result.changes.length > 0) {
      session.dispatch({ type: "selection-change", changes: result.changes });
    }
  }

  function startPointer(event: TargetedPointerEvent<HTMLDivElement>) {
    if (pointerState.current.active !== null) {
      return;
    }
    const cardId = cardIdFromElement(event.target as Element | null);
    if (cardId === null) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointer.current = {
      hitRegions: handPointerHitRegions(event.currentTarget),
      point: { x: event.clientX, y: event.clientY },
      pointerId: event.pointerId,
    };
    apply({
      cardId,
      point: { x: event.clientX, y: event.clientY },
      pointerId: event.pointerId,
      selected: selected.has(cardId),
      type: "start",
    });
  }

  function movePointer(event: TargetedPointerEvent<HTMLDivElement>) {
    const active = pointerState.current.active;
    const previous = activePointer.current;
    if (active === null || previous === null || active.pointerId !== event.pointerId) {
      return;
    }
    let previousPoint = previous.point;
    for (const point of coalescedPointerPoints(event)) {
      const crossedCardIds = cardsCrossedByPointerSegment(
        previousPoint,
        point,
        previous.hitRegions,
      );
      if (crossedCardIds.length === 0) {
        apply({ cardId: null, point, pointerId: event.pointerId, type: "move" });
      } else {
        for (const cardId of crossedCardIds) {
          apply({ cardId, point, pointerId: event.pointerId, type: "move" });
        }
      }
      previousPoint = point;
    }
    activePointer.current = { ...previous, point: previousPoint };
  }

  function finishPointer(event: TargetedPointerEvent<HTMLDivElement>, type: "end" | "cancel") {
    apply({ pointerId: event.pointerId, type });
    if (activePointer.current?.pointerId === event.pointerId) {
      activePointer.current = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (type === "end") {
      session.dispatch({ type: "selection-complete" });
    }
  }

  return (
    <div
      aria-label="你的手牌"
      class="human-hand"
      onPointerCancel={(event) => finishPointer(event, "cancel")}
      onPointerDown={startPointer}
      onPointerMove={movePointer}
      onPointerUp={(event) => finishPointer(event, "end")}
      ref={handElement}
      style={{
        "--hand-count": Math.max(view.humanHand.length, 1),
        "--hand-natural-width": handNaturalWidth(view.humanHand.length),
      } as never}
    >
      {view.humanHand.map((cardId, index) => (
        <HandCard
          cardId={cardId}
          index={index}
          key={cardId}
          received={view.landlord === "human" && view.bottomCards?.includes(cardId) === true}
          selected={selected.has(cardId)}
        />
      ))}
    </div>
  );
}

function LiveFeedback({ view }: Readonly<{ view: MatchView }>) {
  const message = view.selectionError === "unsupported-selection"
    ? "这些牌不能这样出"
    : view.selectionError === "does-not-beat"
      ? "这手牌压不过桌上的牌"
      : view.selectionError === "retry-selection"
        ? "这手牌暂时不能出，请重新选择"
        : view.feedback === "no-response"
          ? "没有可以压过的牌"
          : view.feedback === "all-pass"
            ? "都不叫，重新发牌"
            : "";
  return <output class="live-feedback" aria-live="polite">{message}</output>;
}

function ExitConfirmation({ session, view }: Readonly<ProductionTableAppProps & { view: MatchView }>) {
  return (
    <div class={`exit-layer${view.exitConfirmation ? " is-open" : ""}`} aria-hidden={!view.exitConfirmation}>
      <div class="exit-layer__scrim" />
      <section aria-label="结束本局确认" aria-modal="true" class="exit-dialog" role="dialog">
        <h2>要结束这一局吗？</h2>
        <p>返回首页后，本局进度不会保留。</p>
        <div class="exit-dialog__actions">
          <ActionButton control="cancel-exit" label="继续游戏" onClick={() => session.dispatch({ type: "cancel-exit" })} />
          <ActionButton control="confirm-exit" label="结束本局" onClick={() => session.dispatch({ type: "confirm-exit" })} tone="destructive" />
        </div>
      </section>
    </div>
  );
}

function ResultMessage({ view }: Readonly<{ view: MatchView }>) {
  if (view.stage !== "result" || view.result === null) {
    return null;
  }
  return (
    <section class="result-message" aria-live="polite">
      <h1>{view.result.humanOutcome === "win" ? "胜利" : "失败"}</h1>
      <p>{view.result.winningSide === "landlord" ? "地主获胜" : "农民获胜"}</p>
    </section>
  );
}

function HomeScreen({ session }: ProductionTableAppProps) {
  return (
    <main class="home-screen">
      <section class="home-content">
        <div class="home-hero" aria-label="三张牌背">
          <CardBack />
          <CardBack />
          <CardBack />
        </div>
        <div class="home-copy">
          <h1>单机斗地主</h1>
          <p>一人 · 两位本地 AI · 完全离线</p>
        </div>
        <button class="start-button" onClick={() => session.dispatch({ type: "start-game" })} type="button">
          开始游戏
        </button>
      </section>
    </main>
  );
}

function MatchScreen({ session, view }: Readonly<ProductionTableAppProps & { view: MatchView }>) {
  const humanRole = view.roles.human;
  return (
    <main class={`match-screen${view.stage === "result" ? " is-result" : ""}`}>
      <header class="match-topbar">
        <button class="back-button" onClick={() => session.dispatch({ type: "request-exit" })} type="button">返回</button>
        <BottomCards view={view} />
        <span aria-hidden="true" class="topbar-balance" />
      </header>

      <OpponentSeat side="left" seat="ai-two" view={view} />
      <OpponentSeat side="right" seat="ai-one" view={view} />

      <section class="human-play-zone" aria-label="你的出牌区域">
        <SeatAction action={view.tableActions.human} bid={view.biddingActions.human} />
      </section>
      <ResultMessage view={view} />

      <section class={`human-identity${view.currentSeat === "human" ? " is-current" : ""}`} aria-label="你的牌数和角色">
        <RemainingCount count={view.remainingCardCounts.human} low={false} />
        {humanRole === null ? null : <span>{ROLE_LABELS[humanRole]}</span>}
      </section>

      <LiveFeedback view={view} />
      <MatchControls session={session} view={view} />
      <HumanHand session={session} view={view} />
      <ExitConfirmation session={session} view={view} />
    </main>
  );
}

export function ProductionTableApp({ session }: ProductionTableAppProps) {
  const view = useProductionView(session);
  return (
    <div class="app-shell">
      <section class="rotate-gate" aria-label="屏幕方向提示">
        <div class="rotate-gate__device" aria-hidden="true"><span /></div>
        <h1>请旋转手机</h1>
        <p>横屏后即可继续</p>
      </section>
      <div class="landscape-surface">
        {view.screen === "home"
          ? <HomeScreen session={session} />
          : <MatchScreen session={session} view={view} />}
      </div>
    </div>
  );
}
