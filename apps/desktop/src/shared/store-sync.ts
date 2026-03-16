import { createStore } from "@tanstack/react-store";
import type { Subscription } from "@tanstack/react-store";

type StoreLike<TState> = {
  state: TState;
  subscribe: (listener: (state: TState) => void) => Subscription;
};

type MainStoreBridgeOptions<TState, TEvent> = {
  createEvent: (state: TState) => TEvent;
  emitEvent: (event: TEvent) => void;
  isEqual?: (nextState: TState, previousState: TState) => boolean;
  shouldThrottle?: (nextState: TState, previousState: TState) => boolean;
  store: StoreLike<TState>;
  throttleMs?: number;
};

type MirroredRendererStoreOptions<TState, TSnapshot, TEvent> = {
  defaultState: TState;
  getEventState: (event: TEvent) => TState | undefined;
  getSnapshot: () => Promise<TSnapshot>;
  getSnapshotState: (snapshot: TSnapshot) => TState;
  subscribe: (listener: (event: TEvent) => void) => () => void;
};

export function bridgeMainStoreToEvent<TState, TEvent>(
  options: MainStoreBridgeOptions<TState, TEvent>,
): () => void {
  const isEqual = options.isEqual ?? Object.is;
  let previousState = options.store.state;
  let lastEmitAt = 0;
  let scheduledEvent: ReturnType<typeof setTimeout> | undefined;
  let scheduledState: TState | undefined;

  const emit = (state: TState) => {
    if (scheduledEvent) {
      clearTimeout(scheduledEvent);
      scheduledEvent = undefined;
      scheduledState = undefined;
    }

    lastEmitAt = Date.now();
    options.emitEvent(options.createEvent(state));
  };

  const subscription = options.store.subscribe(() => {
    const nextState = options.store.state;
    const lastState = previousState;

    if (isEqual(nextState, lastState)) {
      return;
    }

    previousState = nextState;

    if (
      options.throttleMs &&
      options.shouldThrottle &&
      options.shouldThrottle(nextState, lastState)
    ) {
      const elapsed = Date.now() - lastEmitAt;
      if (elapsed >= options.throttleMs) {
        emit(nextState);
        return;
      }

      scheduledState = nextState;
      if (scheduledEvent) {
        return;
      }

      scheduledEvent = setTimeout(() => {
        const stateToEmit = scheduledState ?? options.store.state;
        emit(stateToEmit);
      }, options.throttleMs - elapsed);
      return;
    }

    emit(nextState);
  });

  return () => {
    if (scheduledEvent) {
      clearTimeout(scheduledEvent);
    }
    subscription.unsubscribe();
  };
}

export function createMirroredRendererStore<TState, TSnapshot, TEvent>(
  options: MirroredRendererStoreOptions<TState, TSnapshot, TEvent>,
) {
  const store = createStore(options.defaultState);

  void options
    .getSnapshot()
    .then((snapshot) => {
      store.setState(() => options.getSnapshotState(snapshot));
    })
    .catch((cause) => {
      console.error(cause);
    });

  options.subscribe((event) => {
    const nextState = options.getEventState(event);
    if (nextState === undefined) {
      return;
    }

    store.setState(() => nextState);
  });

  return store;
}
