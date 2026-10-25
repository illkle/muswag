import { useEffect, useRef } from "react";

import { MpvIPC } from "#/player/commands";
import { usePlayerMpvBinary } from "#/player/hooks";

/**
 * Looks for mpv again whenever the window comes back to the front while mpv is missing: after an
 * install in a terminal, say. For as long as the app runs, not only while setup is on screen: someone
 * who skipped it may install mpv later.
 */
export function useRediscoverMpvOnFocus() {
  const missing = usePlayerMpvBinary()._tag === "Unavailable";
  const missingRef = useRef(missing);
  missingRef.current = missing;
  useEffect(() => {
    const rediscover = () => {
      if (missingRef.current) void MpvIPC.recheck().catch(() => {});
    };
    window.addEventListener("focus", rediscover);
    return () => window.removeEventListener("focus", rediscover);
  }, []);
}
