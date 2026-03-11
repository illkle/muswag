import {
  createContext,
  useContextSelector,
  useHasParentContext,
} from "@fluentui/react-context-selector";
import { type ReactNode, useEffect, useState } from "react";

import { Player } from "#/lib/db";
import type { PlayerState } from "#/shared/player";
import { createDefaultPlayerState } from "#/shared/player";

type PlayerContextValue = {
  state: PlayerState;
};

const defaultState = createDefaultPlayerState();

const PlayerContext = createContext<PlayerContextValue>({
  state: defaultState,
});

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(defaultState);

  useEffect(() => {
    let isMounted = true;

    void Player.getState()
      .then((nextState) => {
        if (isMounted) {
          setState(nextState);
        }
      })
      .catch((cause) => {
        console.error(cause);
      });

    const unsubscribe = Player.subscribe((event) => {
      if (isMounted && event.type === "state") {
        setState(event.state);
      }
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  return <PlayerContext.Provider value={{ state }}>{children}</PlayerContext.Provider>;
}

export function usePlayer() {
  useAssertPlayerProvider();

  const state = useContextSelector(PlayerContext, (context) => context.state);

  return {
    state,
  };
}

export function usePlayerSelector<T>(selector: (state: PlayerState) => T): T {
  useAssertPlayerProvider();

  return useContextSelector(PlayerContext, (context) => selector(context.state));
}

function useAssertPlayerProvider(): void {
  if (!useHasParentContext(PlayerContext)) {
    throw new Error("PlayerProvider is missing.");
  }
}
