import { useQueryClient } from "@tanstack/react-query";

import { applyAppEvent, appQueryKeys } from "#/lib/app-state";
import { SM } from "#/lib/db";
import { useEffect } from "react";

export function AppStateSubscriptionBridge() {
  const qc = useQueryClient();

  useEffect(() => {
    return SM.subscribe((event) => {
      applyAppEvent(qc, event);
      void qc.invalidateQueries({ queryKey: appQueryKeys.all });
    });
  }, [qc]);

  return null;
}
