export interface PointerPoint {
  readonly x: number;
  readonly y: number;
}

interface ActivePointerSelection<CardId> {
  readonly continuous: boolean;
  readonly desiredSelected: boolean;
  readonly pointerId: number;
  readonly startCardId: CardId;
  readonly startPoint: PointerPoint;
  readonly visited: ReadonlySet<CardId>;
}

export interface PointerSelectionState<CardId> {
  readonly active: ActivePointerSelection<CardId> | null;
}

export interface SelectionChange<CardId> {
  readonly cardId: CardId;
  readonly selected: boolean;
}

export type PointerSelectionEvent<CardId> =
  | {
      readonly cardId: CardId;
      readonly point: PointerPoint;
      readonly pointerId: number;
      readonly selected: boolean;
      readonly type: "start";
    }
  | {
      readonly cardId: CardId | null;
      readonly point: PointerPoint;
      readonly pointerId: number;
      readonly type: "move";
    }
  | {
      readonly pointerId: number;
      readonly type: "end";
    }
  | {
      readonly pointerId: number;
      readonly type: "cancel";
    };

export interface PointerSelectionResult<CardId> {
  readonly changes: readonly SelectionChange<CardId>[];
  readonly state: PointerSelectionState<CardId>;
}

export const INITIAL_POINTER_SELECTION_STATE: PointerSelectionState<never> =
  Object.freeze({ active: null });

function emptyState<CardId>(): PointerSelectionState<CardId> {
  return INITIAL_POINTER_SELECTION_STATE;
}

function unchanged<CardId>(
  state: PointerSelectionState<CardId>,
): PointerSelectionResult<CardId> {
  return { changes: [], state };
}

function visit<CardId>(
  active: ActivePointerSelection<CardId>,
  cardId: CardId,
): {
  readonly active: ActivePointerSelection<CardId>;
  readonly change: SelectionChange<CardId> | null;
} {
  if (active.visited.has(cardId)) {
    return { active, change: null };
  }

  const visited = new Set(active.visited);
  visited.add(cardId);
  return {
    active: { ...active, visited },
    change: { cardId, selected: active.desiredSelected },
  };
}

export function reducePointerSelection<CardId>(
  state: PointerSelectionState<CardId>,
  event: PointerSelectionEvent<CardId>,
  movementThreshold = 8,
): PointerSelectionResult<CardId> {
  if (event.type === "start") {
    if (state.active !== null) {
      return unchanged(state);
    }
    return {
      changes: [],
      state: {
        active: {
          continuous: false,
          desiredSelected: !event.selected,
          pointerId: event.pointerId,
          startCardId: event.cardId,
          startPoint: event.point,
          visited: new Set(),
        },
      },
    };
  }

  const active = state.active;
  if (active === null || event.pointerId !== active.pointerId) {
    return unchanged(state);
  }

  if (event.type === "cancel") {
    return { changes: [], state: emptyState() };
  }

  if (event.type === "end") {
    return {
      changes: active.continuous
        ? []
        : [{ cardId: active.startCardId, selected: active.desiredSelected }],
      state: emptyState(),
    };
  }

  let nextActive = active;
  const changes: SelectionChange<CardId>[] = [];

  if (!active.continuous) {
    const deltaX = event.point.x - active.startPoint.x;
    const deltaY = event.point.y - active.startPoint.y;
    if (deltaX * deltaX + deltaY * deltaY < movementThreshold * movementThreshold) {
      return unchanged(state);
    }

    nextActive = { ...active, continuous: true };
    const firstVisit = visit(nextActive, active.startCardId);
    nextActive = firstVisit.active;
    if (firstVisit.change !== null) {
      changes.push(firstVisit.change);
    }
  }

  if (event.cardId !== null) {
    const currentVisit = visit(nextActive, event.cardId);
    nextActive = currentVisit.active;
    if (currentVisit.change !== null) {
      changes.push(currentVisit.change);
    }
  }

  return { changes, state: { active: nextActive } };
}
