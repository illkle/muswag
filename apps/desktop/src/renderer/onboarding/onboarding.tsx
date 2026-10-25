import {
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  BroadcastIcon,
  CheckIcon,
  EyeSlashIcon,
  HardDrivesIcon,
  ShieldCheckIcon,
  SpinnerGapIcon,
  VinylRecordIcon,
  WaveformIcon,
  type Icon,
} from "@phosphor-icons/react";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { MpvSetup } from "#/components/settings/mpv-setup";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { getErrorMessage } from "#/lib/err";
import { cn } from "#/lib/utils";
import { finishSetup } from "#/onboarding/setup-state";
import { usePlayerMpvBinary } from "#/player/hooks";
import { Session } from "#/session/session";
import { TOP_HEIGHT } from "#/styles";

/** The window has no title bar on macOS, so a screen without the app's top bar brings its own strip to drag it by. */
const DragStrip = () => <div className="app-drag-region fixed inset-x-0 top-0 z-10" style={{ height: TOP_HEIGHT }} />;

const STEPS = ["Connect your server", "Set up playback"] as const;
type Step = 1 | 2;

function Steps({ current }: { current: Step }) {
  return (
    <ol aria-label="Setup" className="flex items-center gap-3 text-sm">
      {STEPS.map((label, index) => {
        const step = index + 1;
        const done = step < current;
        const active = step === current;
        return (
          <li aria-current={active ? "step" : undefined} className="flex items-center gap-3" key={label}>
            {index > 0 ? <span aria-hidden className={cn("h-px w-6 sm:w-10", done || active ? "bg-brand/60" : "bg-border")} /> : null}
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums",
                done && "border-brand bg-brand text-primary-foreground",
                active && "border-brand text-brand",
                !done && !active && "text-muted-foreground",
              )}
            >
              {done ? <CheckIcon aria-label="Done" className="size-3.5" weight="bold" /> : step}
            </span>
            <span className={cn("hidden sm:inline", active ? "font-medium text-foreground" : "text-muted-foreground")}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Point({ icon: PointIcon, title, children }: { icon: Icon; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
        <PointIcon className="size-5" />
      </span>
      <div className="min-w-0 space-y-0.5">
        <div className="font-medium">{title}</div>
        <p className="text-sm text-muted-foreground">{children}</p>
      </div>
    </li>
  );
}

/**
 * A setup screen filling the window: what the step is and why it is needed on one side, what to do on
 * the other. `step` is left out for a returning user, who only logs in again.
 */
function SetupPage({ step, title, lead, points, children }: { step: Step | null; title: string; lead: ReactNode; points: ReactNode; children: ReactNode }) {
  return (
    <main className="scrollbar scrollbar-flush relative h-full overflow-x-hidden overflow-y-auto">
      <DragStrip />
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-radial-[at_0%_0%] from-brand/12 via-transparent via-45% to-transparent" />
      <div className="relative mx-auto flex min-h-full w-full max-w-5xl flex-col px-8 pt-14 pb-10">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <VinylRecordIcon className="size-5" weight="fill" />
            </div>
            <span className="text-lg font-semibold tracking-tight">Muswag</span>
          </div>
          {step ? <Steps current={step} /> : null}
        </header>

        <div className="grid flex-1 items-center gap-10 py-10 md:grid-cols-[minmax(0,1fr)_22rem] md:gap-8 lg:grid-cols-[minmax(0,1fr)_28rem] lg:gap-16">
          <section className="min-w-0 space-y-6">
            <div className="space-y-3">
              {step ? <div className="text-sm font-medium text-brand">Step {step} of 2</div> : null}
              <h1 className="text-3xl font-semibold tracking-tight text-balance">{title}</h1>
              <p className="max-w-prose text-base text-pretty text-muted-foreground">{lead}</p>
            </div>
            <ul className="space-y-4">{points}</ul>
          </section>
          <div className="min-w-0">{children}</div>
        </div>
      </div>
    </main>
  );
}

/** While something the setup needs is being found out. */
export function SetupLoading({ message }: { message: string }) {
  return (
    <main className="flex h-full items-center justify-center gap-2 px-6 text-sm text-muted-foreground">
      <DragStrip />
      <SpinnerGapIcon className="size-4 animate-spin" />
      {message}
    </main>
  );
}

type CredentialsForm = {
  url: string;
  username: string;
  password: string;
};

// Read in development only. A production build replaces `import.meta.env.DEV` by `false` and drops
// the branch with it, so a filled `.env` cannot put a password into the bundle.
const defaultCredentials: CredentialsForm = import.meta.env.DEV
  ? {
      url: import.meta.env.VITE_DEFAULT_SUBSONIC_URL ?? "",
      username: import.meta.env.VITE_DEFAULT_SUBSONIC_USERNAME ?? "",
      password: import.meta.env.VITE_DEFAULT_SUBSONIC_PASSWORD ?? "",
    }
  : { url: "", username: "", password: "" };

/**
 * The first step, and the login of a returning user (`setupDone`). `expired` is the account of a
 * session that ended because the server no longer accepts its password.
 */
export function ServerStep({ expired, setupDone }: { expired: Pick<CredentialsForm, "url" | "username"> | undefined; setupDone: boolean }) {
  const loginMutation = useMutation({
    mutationFn: async (values: CredentialsForm) => {
      await Session.login(values);
    },
  });

  // The library of an expired session is kept for a login to the same server as the same user. Taken
  // once: the form must not start over when the session's state is published again.
  const [defaultValues] = useState<CredentialsForm>(() => (expired ? { url: expired.url, username: expired.username, password: "" } : defaultCredentials));
  const form = useForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      // A failed login is shown from the mutation's state; the form only waits for it.
      await loginMutation.mutateAsync(value).catch(() => undefined);
    },
  });

  const field = (name: keyof CredentialsForm, label: string, input: { type: string; placeholder?: string; autoComplete: string }) => (
    <form.Field name={name}>
      {(field) => (
        <div className="space-y-2">
          <Label htmlFor={field.name}>{label}</Label>
          <Input {...input} id={field.name} name={field.name} required value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} />
        </div>
      )}
    </form.Field>
  );

  return (
    <SetupPage
      lead="Muswag is a desktop player for the music on your own server. It works with Navidrome, gonic, LMS and other Subsonic-compatible servers."
      points={
        <>
          <Point icon={HardDrivesIcon} title="Your library on this computer">
            Albums, artists and playlists are synced here, so browsing and search are instant.
          </Point>
          <Point icon={BroadcastIcon} title="Music streams from your server">
            Nothing is downloaded ahead of time: a track plays straight from the server when you pick it.
          </Point>
          <Point icon={ArrowsClockwiseIcon} title="Stays in step with the server">
            Playlists you edit here are saved on the server, and new albums arrive when the library syncs.
          </Point>
        </>
      }
      step={setupDone ? null : 1}
      title={setupDone ? "Log in to your server" : "Connect your music server"}
    >
      <Card className="shadow-xl shadow-black/5">
        <CardHeader>
          <CardTitle>Server</CardTitle>
          <CardDescription>The address you open your server at in a browser, and your account on it.</CardDescription>
        </CardHeader>
        <CardContent>
          {expired && !loginMutation.isError ? (
            <Alert className="mb-4">
              <AlertTitle>Log in again</AlertTitle>
              <AlertDescription>The server no longer accepts the password of {expired.username}. Your library is kept for when you are back.</AlertDescription>
            </Alert>
          ) : null}

          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void form.handleSubmit();
            }}
          >
            {field("url", "Server URL", { type: "url", placeholder: "https://music.example.com", autoComplete: "url" })}
            {field("username", "Username", { type: "text", autoComplete: "username" })}
            {field("password", "Password", { type: "password", autoComplete: "current-password" })}

            <Button className="w-full" disabled={loginMutation.isPending} size="lg" type="submit">
              {loginMutation.isPending ? <SpinnerGapIcon className="animate-spin" /> : null}
              {loginMutation.isPending ? "Connecting…" : setupDone ? "Log in" : "Connect"}
              {loginMutation.isPending || setupDone ? null : <ArrowRightIcon />}
            </Button>
          </form>

          {loginMutation.isError ? (
            <Alert className="mt-4" variant="destructive">
              <AlertTitle>Could not log in</AlertTitle>
              <AlertDescription>{getErrorMessage(loginMutation.error, "Check the address, the username and the password, and try again.")}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </SetupPage>
  );
}

/** The second step: playback needs mpv, and the app waits here until it works or the user goes on without it. */
export function PlaybackStep() {
  const ready = usePlayerMpvBinary()._tag === "Ready";

  return (
    <SetupPage
      lead="Muswag plays your music through mpv, a free and open-source media player. It is a program of its own, so it is installed once on this computer, and Muswag can do that for you."
      points={
        <>
          <Point icon={WaveformIcon} title="Plays what your server has">
            FLAC, Opus, AAC, MP3 and almost any other format, just as the server sends it.
          </Point>
          <Point icon={EyeSlashIcon} title="Stays out of sight">
            mpv opens no window: Muswag starts it, controls it and stops it for you.
          </Point>
          <Point icon={ShieldCheckIcon} title="Installed the usual way">
            Your system’s package manager installs it from the official source and keeps it up to date.
          </Point>
        </>
      }
      step={2}
      title="Set up playback"
    >
      <Card className="shadow-xl shadow-black/5">
        <CardHeader>
          <CardTitle>mpv</CardTitle>
          <CardDescription>{ready ? "Everything is in place. Enjoy your music." : "Install mpv, or point Muswag to the one you have."}</CardDescription>
        </CardHeader>
        <CardContent>
          <MpvSetup />
        </CardContent>
        <CardFooter className="flex-col items-stretch gap-2 border-t">
          <Button disabled={!ready} onClick={finishSetup} size="lg">
            Start listening
            <ArrowRightIcon />
          </Button>
          {ready ? null : (
            <>
              <Button onClick={finishSetup} variant="ghost">
                Skip for now
              </Button>
              <p className="text-center text-xs text-muted-foreground">You can browse your library without mpv, and set it up later from the server menu.</p>
            </>
          )}
        </CardFooter>
      </Card>
    </SetupPage>
  );
}
