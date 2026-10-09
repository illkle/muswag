import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { getErrorMessage } from "#/lib/err";
import { useUser, Session } from "#/session/session";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { VinylRecordIcon } from "@phosphor-icons/react";
import { useState } from "react";

export const Route = createFileRoute("/")({
  component: App,
});

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

/** `expired` is the account of a session that ended because the server no longer accepts its password. */
function LoginScreen({ expired }: { expired: Pick<CredentialsForm, "url" | "username"> | undefined }) {
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

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-12">
      <Card className="w-full max-w-md border-0 bg-card/95 shadow-2xl shadow-primary/5 backdrop-blur">
        <CardHeader className="gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
              <VinylRecordIcon weight="fill" className="size-6" />
            </div>
            <div>
              <CardTitle>Muswag</CardTitle>
              <CardDescription>Connect to your Subsonic server.</CardDescription>
            </div>
          </div>
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
            <form.Field name="url">
              {(field) => (
                <div className="space-y-2">
                  <Label htmlFor={field.name}>Server URL</Label>
                  <Input
                    id={field.name}
                    name={field.name}
                    type="url"
                    placeholder="https://demo.navidrome.org"
                    autoComplete="url"
                    required
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                </div>
              )}
            </form.Field>

            <form.Field name="username">
              {(field) => (
                <div className="space-y-2">
                  <Label htmlFor={field.name}>Username</Label>
                  <Input
                    id={field.name}
                    name={field.name}
                    type="text"
                    placeholder="admin"
                    autoComplete="username"
                    required
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                </div>
              )}
            </form.Field>

            <form.Field name="password">
              {(field) => (
                <div className="space-y-2">
                  <Label htmlFor={field.name}>Password</Label>
                  <Input
                    id={field.name}
                    name={field.name}
                    type="password"
                    autoComplete="current-password"
                    required
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                </div>
              )}
            </form.Field>

            <Button className="w-full" type="submit" disabled={loginMutation.isPending}>
              {loginMutation.isPending ? "Connecting…" : "Connect"}
            </Button>
          </form>

          {loginMutation.isError ? (
            <Alert variant="destructive" className="mt-4">
              <AlertTitle>Could not log in</AlertTitle>
              <AlertDescription>{getErrorMessage(loginMutation.error, "Check the address, the username and the password, and try again.")}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}

function App() {
  const userStateQuery = useUser();

  if (userStateQuery.isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <div className="text-sm text-muted-foreground">Loading application state...</div>
      </main>
    );
  }

  if (!userStateQuery.data) {
    return <LoginScreen expired={userStateQuery.expired} />;
  }

  return <Navigate to="/app/albums" replace />;
}
