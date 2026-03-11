import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { userStateQueryOptions } from "#/lib/app-state";
import { SM } from "#/lib/db";
import { getErrorMessage } from "#/lib/err";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";

export const Route = createFileRoute("/")({
  component: App,
});

type CredentialsForm = {
  url: string;
  username: string;
  password: string;
};

const defaultCredentials = {
  url: import.meta.env.VITE_DEFAULT_SUBSONIC_URL ?? "",
  username: import.meta.env.VITE_DEFAULT_SUBSONIC_USERNAME ?? "",
  password: import.meta.env.VITE_DEFAULT_SUBSONIC_PASSWORD ?? "",
} satisfies CredentialsForm;

function LoginScreen() {
  const loginMutation = useMutation({
    mutationFn: (values: CredentialsForm) => SM.login(values),
  });

  const form = useForm({
    defaultValues: defaultCredentials,
    onSubmit: async ({ value }) => {
      await loginMutation.mutateAsync(value);
    },
  });

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-12">
      <Card className="w-full max-w-md border-0 bg-card/95 shadow-2xl shadow-primary/5 backdrop-blur">
        <CardHeader className="gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
              <ShieldCheck className="size-5" />
            </div>
            <div>
              <CardTitle>Connect your Subsonic server</CardTitle>
              <CardDescription>Store credentials locally and unlock sync.</CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent>
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
              {loginMutation.isPending ? "Connecting..." : "Login"}
            </Button>
          </form>

          {loginMutation.isError ? (
            <Alert variant="destructive" className="mt-4">
              <AlertTitle>Login failed</AlertTitle>
              <AlertDescription>
                {getErrorMessage(loginMutation.error, "Check your credentials and try again.")}
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}

function App() {
  const userStateQuery = useQuery(userStateQueryOptions);

  if (userStateQuery.isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <div className="text-sm text-muted-foreground">Loading application state...</div>
      </main>
    );
  }

  if (!userStateQuery.data || userStateQuery.data.status === "logged_out") {
    return <LoginScreen />;
  }

  return <Navigate to="/app/albums" replace />;
}
