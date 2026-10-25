import { credentials as credentialsTable, type SessionCredentials } from "@muswag/model";
import { eq } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";

import { Db } from "../db/database.js";

export class CredentialsStoreError extends Data.TaggedError("CredentialsStoreError")<{
  readonly operation: "load" | "save" | "clear";
  readonly message: string;
  readonly cause: unknown;
}> {}

/** The server and user the local data belongs to. */
export type StoredAccount = Pick<SessionCredentials, "url" | "username">;

export interface CredentialsStoreService {
  /** The credentials to restore a session with. `null` also when the account's token was forgotten. */
  readonly load: Effect.Effect<SessionCredentials | null, CredentialsStoreError>;
  /** The account last logged in with, also when its token was forgotten. */
  readonly account: Effect.Effect<StoredAccount | null, CredentialsStoreError>;
  readonly save: (credentials: SessionCredentials) => Effect.Effect<void, CredentialsStoreError>;
  /** Drops a token the server refused and keeps whose data this is, so it is not tried on every start. */
  readonly forgetToken: Effect.Effect<void, CredentialsStoreError>;
  readonly clear: Effect.Effect<void, CredentialsStoreError>;
}

export class CredentialsStore extends Context.Service<CredentialsStore, CredentialsStoreService>()("@muswag/backend/CredentialsStore") {}

const ROW_ID = 1;

/**
 * Keeps the credentials in the database's `credentials` table, which no renderer reads. What is stored
 * logs in to the one server and is not the password, so it needs no keychain to be kept in.
 */
export const CredentialsStoreSql = () =>
  Layer.effect(
    CredentialsStore,
    Effect.gen(function* () {
      const db = yield* Db;
      const failure = (operation: CredentialsStoreError["operation"], message: string) => (cause: unknown) => new CredentialsStoreError({ operation, message, cause });
      const storedRow = db
        .select()
        .from(credentialsTable)
        .where(eq(credentialsTable.id, ROW_ID))
        .pipe(Effect.map((rows) => rows[0]));

      return {
        load: storedRow.pipe(
          // A forgotten token is stored as an empty one, which no login saves.
          Effect.map((stored) => (stored && stored.token !== "" ? { url: stored.url, username: stored.username, salt: stored.salt, token: stored.token } : null)),
          Effect.mapError(failure("load", "Failed to load stored credentials")),
        ),

        account: storedRow.pipe(
          Effect.map((stored) => (stored ? { url: stored.url, username: stored.username } : null)),
          Effect.mapError(failure("load", "Failed to load the stored account")),
        ),

        save: (credentials) => {
          const row = { id: ROW_ID, url: credentials.url, username: credentials.username, salt: credentials.salt, token: credentials.token };
          return db
            .insert(credentialsTable)
            .values(row)
            .onConflictDoUpdate({ target: credentialsTable.id, set: row })
            .pipe(Effect.asVoid, Effect.mapError(failure("save", "Failed to save credentials")));
        },

        forgetToken: db
          .update(credentialsTable)
          .set({ salt: "", token: "" })
          .where(eq(credentialsTable.id, ROW_ID))
          .pipe(Effect.asVoid, Effect.mapError(failure("save", "Failed to forget the stored token"))),

        clear: db.delete(credentialsTable).pipe(Effect.asVoid, Effect.mapError(failure("clear", "Failed to clear credentials"))),
      } satisfies CredentialsStoreService;
    }),
  );
