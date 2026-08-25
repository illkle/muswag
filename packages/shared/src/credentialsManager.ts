import { Context, Effect, Ref } from "effect";
import SubsonicAPI, { SubsonicAPILive } from "./api/subsonic-api.js";

type SessionState = { readonly _tag: "LoggedOut" } | { readonly _tag: "LoggedIn"; readonly api: typeof SubsonicAPI.Service };

export interface AuthCredentials {
  url: string;
  auth: {
    username: string;
    password: string;
  };
}

export class SessionManager extends Context.Service<SessionManager>()("SessionManager", {
  make: Effect.gen(function* () {
    const state = yield* Ref.make<SessionState>({
      _tag: "LoggedOut",
    });

    const login = (credentials: AuthCredentials) =>
      Effect.gen(function* () {
        const layer = SubsonicAPILive(credentials);

        const api = yield* Effect.gen(function* () {
          const api = yield* SubsonicAPI;
          yield* api.ping;
          return api;
        }).pipe(Effect.provide(layer));

        yield* Ref.set(state, {
          _tag: "LoggedIn",
          api: api,
        });
      });

    const logout = Ref.set(state, {
      _tag: "LoggedOut",
    });

    return {
      login,
      logout,
      state,
    };
  }),
}) {}
