import { useQueryClient } from "@tanstack/react-query";

import { appQueryKeys } from "#/lib/app-state";
import { SM } from "#/lib/db";
import { useEffect } from "react";

export function useAppEvents() {
  const qc = useQueryClient();

  useEffect(() => {
    console.log("subscribe effect");

    return SM.subscribe((e) => {
      console.log("event", e);
      switch (e) {
        case "data_invalidate":
          void qc.invalidateQueries({ queryKey: appQueryKeys.data });
          break;
        case "user_invalidate":
          void qc.invalidateQueries({ queryKey: appQueryKeys.userState });
          break;
      }
    });
  }, [qc]);
}
