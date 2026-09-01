export type DebugAction = "pass" | "hint" | "play";

export interface DebugState {
  readonly actionCount: number;
  readonly lastAction: DebugAction | null;
}

export const INITIAL_DEBUG_STATE: DebugState = Object.freeze({
  actionCount: 0,
  lastAction: null,
});

export function reduceDebugState(
  state: DebugState,
  action: DebugAction,
): DebugState {
  return {
    actionCount: state.actionCount + 1,
    lastAction: action,
  };
}

export interface DebugSession {
  readonly dispatch: (action: DebugAction) => void;
  readonly getView: () => DebugState;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createDebugSession(): DebugSession {
  let state = INITIAL_DEBUG_STATE;
  const listeners = new Set<() => void>();

  return {
    dispatch(action) {
      state = reduceDebugState(state, action);
      for (const listener of listeners) {
        listener();
      }
    },
    getView() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
