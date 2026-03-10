import { useEffect, useRef, useState } from "react";

import { playerActions, playerStore } from "#/lib/player-store";
import type { PlayerState } from "#/shared/player";

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    playerStore.initialize();
  }, []);

  return children;
}

export function usePlayer() {
  const state = usePlayerSelector((nextState) => nextState);

  return {
    state,
    ...playerActions,
  };
}

export function usePlayerSelector<T>(
  selector: (state: PlayerState) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const [selectedState, setSelectedState] = useState(() => selector(playerStore.getState()));
  const selectorRef = useRef(selector);
  const isEqualRef = useRef(isEqual);

  selectorRef.current = selector;
  isEqualRef.current = isEqual;

  useEffect(() => {
    playerStore.initialize();

    setSelectedState((previousState) => {
      const nextSelectedState = selectorRef.current(playerStore.getState());
      return isEqualRef.current(previousState, nextSelectedState) ? previousState : nextSelectedState;
    });

    return playerStore.subscribe(() => {
      const nextSelectedState = selectorRef.current(playerStore.getState());
      setSelectedState((previousState) =>
        isEqualRef.current(previousState, nextSelectedState) ? previousState : nextSelectedState,
      );
    });
  }, []);

  return selectedState;
}
