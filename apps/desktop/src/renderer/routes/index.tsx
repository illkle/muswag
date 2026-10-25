import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { PlaybackStep, ServerStep, SetupLoading } from "#/onboarding/onboarding";
import { finishSetup, useSetupDone } from "#/onboarding/setup-state";
import { usePlayerMpvBinary } from "#/player/hooks";
import { useUser } from "#/session/session";

export const Route = createFileRoute("/")({
  component: App,
});

/**
 * Setup's second step, for as long as mpv is missing. An mpv that is found straight away needs no
 * step: the app opens. Once the step is shown it stays, even when mpv turns up, until the user goes on.
 */
function PlaybackGate() {
  const binary = usePlayerMpvBinary();
  const [asked, setAsked] = useState(binary._tag === "Unavailable");

  useEffect(() => {
    if (binary._tag === "Unavailable") setAsked(true);
    else if (binary._tag === "Ready" && !asked) finishSetup();
  }, [asked, binary._tag]);

  return asked || binary._tag === "Unavailable" ? <PlaybackStep /> : <SetupLoading message="Looking for mpv…" />;
}

function App() {
  const userStateQuery = useUser();
  const setupDone = useSetupDone();

  if (userStateQuery.isLoading) return <SetupLoading message="Loading…" />;
  if (!userStateQuery.data) return <ServerStep expired={userStateQuery.expired} setupDone={setupDone} />;
  if (!setupDone) return <PlaybackGate />;
  return <Navigate to="/app/albums" replace />;
}
