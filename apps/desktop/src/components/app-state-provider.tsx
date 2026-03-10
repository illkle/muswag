import { useQueryClient } from "@tanstack/react-query";

import { appQueryKeys } from "#/lib/app-state";
import { SM } from "#/lib/db";
import { useEffect } from "react";

export function useAppEvents() {
  const qc = useQueryClient();

  useEffect(() => {
    return SM.subscribe((e) => {
      switch (e.type) {
        case "db state synced":
          void qc.invalidateQueries({ queryKey: appQueryKeys.data });
          void qc.invalidateQueries({ queryKey: appQueryKeys.userState });
          break;
        case "user update":
          void qc.invalidateQueries({ queryKey: appQueryKeys.userState });
          break;
      }
    });
  }, [qc]);
}
