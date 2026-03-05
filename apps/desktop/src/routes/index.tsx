import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { db, SM } from "#/lib/db";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: App });

type UsernamePasswordAuth = {
  username: string;
  password: string;
  url: string;
};

function App() {
  const connectMutation = useMutation({
    mutationFn: async (v: UsernamePasswordAuth) => {
      return SM.connect(v);
    },
  });

  const albumsQ = useQuery({
    queryKey: ["a"],
    queryFn: async () => {
      return db.query.albums.findMany();
    },
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      return SM.sync();
    },
    onSuccess: () => {
      albumsQ.refetch();
    },
  });

  const form = useForm({
    defaultValues: {
      url: "",
      username: "",
      password: "",
    } satisfies UsernamePasswordAuth,
    onSubmit: async ({ value }) => {
      await connectMutation.mutateAsync(value);
    },
  });

  const errorMessage = (() => {
    const error = connectMutation.error;

    if (error instanceof Error) {
      return error.message;
    }

    if (typeof error === "object" && error !== null && "message" in error) {
      const message = (error as { message?: unknown }).message;

      if (typeof message === "string" && message.length > 0) {
        return message;
      }
    }

    return "Connection failed. Check your details and try again.";
  })();

  return (
    <main className="min-h-screen bg-background p-6 md:p-10">
      <div className="mx-auto flex w-full max-w-md flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Connect Subsonic Server</CardTitle>
            <CardDescription>
              Enter your server credentials to start syncing your library.
            </CardDescription>
          </CardHeader>

          <CardContent>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                e.stopPropagation();
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
                      required
                      autoComplete="url"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
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
                      required
                      autoComplete="username"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
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
                      required
                      autoComplete="current-password"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                    />
                  </div>
                )}
              </form.Field>

              <Button type="submit" className="w-full" disabled={connectMutation.isPending}>
                {connectMutation.isPending ? "Connecting..." : "Connect"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {connectMutation.isError ? (
          <Alert variant="destructive">
            <AlertTitle>Connection failed</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        {connectMutation.isSuccess ? (
          <Alert>
            <AlertTitle>Connected</AlertTitle>
            <AlertDescription>
              The server is reachable. You can continue with sync.
            </AlertDescription>
          </Alert>
        ) : null}
      </div>

      <div className="mx-auto">
        <Button onClick={() => syncMutation.mutate()}>Sync</Button>

        {syncMutation.isError ? (
          <Alert variant="destructive">
            <AlertTitle>Sync failed</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        {syncMutation.isSuccess ? (
          <Alert>
            <AlertTitle>Synced</AlertTitle>
            <AlertDescription>Data should be in db</AlertDescription>
          </Alert>
        ) : null}
      </div>

      <div>
        {albumsQ.status} {albumsQ.data?.length}{" "}
      </div>

      <div>
        {albumsQ.data?.map((v) => {
          return (
            <div>
              {v.artist} {v.name}
            </div>
          );
        })}
      </div>
    </main>
  );
}
