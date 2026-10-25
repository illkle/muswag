import { SpinnerGapIcon, VinylRecordIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useState, type ComponentProps, type ReactNode } from "react";

import { MpvInstall, MpvSearch } from "#/components/settings/mpv-setup";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { getErrorMessage } from "#/lib/err";
import { finishSetup } from "#/onboarding/setup-state";
import { usePlayerMpvBinary } from "#/player/hooks";
import { Session } from "#/session/session";
import { TOP_HEIGHT } from "#/styles";

/** The window has no title bar on macOS, so a screen without the app's top bar brings its own strip to drag it by. */
const DragStrip = () => <div className="app-drag-region fixed inset-x-0 top-0 z-10" style={{ height: TOP_HEIGHT }} />;

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="font-medium text-foreground underline decoration-foreground/30 underline-offset-4 transition-colors hover:decoration-foreground" href={href} rel="noreferrer" target="_blank">
      {children}
    </a>
  );
}

/**
 * A setup screen filling the window: what the step is and why it is needed on one side, what to do on
 * the other. There is no count of steps: the one for mpv is skipped when mpv is found.
 */
function SetupPage({ title, intro, below, children }: { title: string; intro: ReactNode; below?: ReactNode; children: ReactNode }) {
  return (
    <main className="scrollbar scrollbar-flush relative h-full overflow-x-hidden overflow-y-auto">
      <DragStrip />
      <div className="relative mx-auto flex min-h-full w-full max-w-5xl flex-col px-8 pt-14 pb-10">
        <header className="flex items-center">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <VinylRecordIcon className="size-5" weight="fill" />
            </div>
            <span className="text-lg font-semibold tracking-tight">muswag</span>
          </div>
        </header>

        {/* Centred as a block, the two columns start at the same height. */}
        <div className="grid flex-1 content-center items-start gap-10 py-10 md:grid-cols-[minmax(0,1fr)_22rem] md:gap-8 lg:grid-cols-[minmax(0,1fr)_28rem] lg:gap-16">
          <div className="min-w-0 space-y-10">
            <section className="space-y-4">
              <h1 className="text-3xl font-semibold tracking-tight text-balance">{title}</h1>
              <div className="max-w-prose space-y-4 text-base text-pretty text-muted-foreground">{intro}</div>
            </section>
            {below}
          </div>
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

  const field = (name: keyof CredentialsForm, label: string, input: ComponentProps<"input">) => (
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
      intro={
        <>
          <p>
            muswag is developed using <ExternalLink href="https://www.navidrome.org">Navidrome</ExternalLink>, with occasional verification against{" "}
            <ExternalLink href="https://github.com/sentriz/gonic">gonic</ExternalLink> and <ExternalLink href="https://github.com/epoupon/lms">LMS</ExternalLink>. Other Subsonic servers will likely
            work too.
          </p>
          <p>
            muswag is sync-based: after you log in, it syncs the list of your songs, artists and albums. This makes navigation fast and search snappy, with no network round trip. Covers are downloaded
            as you go and kept. Music is always streamed.
          </p>
        </>
      }
      title={setupDone ? "Log in to your server" : "Connect your music server"}
    >
      {expired && !loginMutation.isError ? (
        <p className="mb-6 text-sm text-muted-foreground">The server no longer accepts the password of {expired.username}. Log in again: your library is kept for when you are back.</p>
      ) : null}

      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void form.handleSubmit();
        }}
      >
        {/* Text rather than `url`, which would turn down an address without its scheme. Main completes it. */}
        {field("url", "Server URL", { type: "text", inputMode: "url", placeholder: "music.example.com", autoComplete: "url", autoCapitalize: "off", spellCheck: false })}
        {field("username", "Username", { type: "text", autoComplete: "username", autoCapitalize: "off", spellCheck: false })}
        {field("password", "Password", { type: "password", autoComplete: "current-password" })}

        <Button className="w-full" disabled={loginMutation.isPending} size="lg" type="submit">
          {loginMutation.isPending ? <SpinnerGapIcon className="animate-spin" /> : null}
          {loginMutation.isPending ? "Connecting…" : setupDone ? "Log in" : "Connect"}
        </Button>
      </form>

      {loginMutation.isError ? (
        <p className="mt-3 flex gap-2 text-sm text-destructive" role="alert">
          <WarningCircleIcon className="mt-0.5 size-4 shrink-0" weight="fill" />
          <span className="[overflow-wrap:anywhere]">{getErrorMessage(loginMutation.error, "Check the address, the username and the password, and try again.")}</span>
        </p>
      ) : null}
    </SetupPage>
  );
}

/** The second step: playback needs mpv, and the app waits here until it works or the user goes on without it. */
export function PlaybackStep() {
  const ready = usePlayerMpvBinary()._tag === "Ready";

  return (
    <SetupPage
      intro={
        <>
          <p>
            muswag plays music through <ExternalLink href="https://mpv.io/">mpv</ExternalLink>, a free, open-source media player that is reliable and supports almost any format imaginable.
          </p>
          <p>If you already have mpv, muswag can use your existing installation, either from PATH or from a folder on disk.</p>
        </>
      }
      below={
        <MpvSearch
          action={
            ready ? (
              <Button onClick={finishSetup}>Continue</Button>
            ) : (
              <Button onClick={finishSetup} variant="outline">
                Skip for now
              </Button>
            )
          }
        />
      }
      title="Set up playback"
    >
      <MpvInstall />
    </SetupPage>
  );
}
