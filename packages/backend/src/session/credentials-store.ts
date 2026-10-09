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
  /** The credentials to restore a session with. `null` also when the account's password was forgotten. */
  readonly load: Effect.Effect<SessionCredentials | null, CredentialsStoreError>;
  /** The account last logged in with, also when its password was forgotten or cannot be decrypted. */
  readonly account: Effect.Effect<StoredAccount | null, CredentialsStoreError>;
  readonly save: (credentials: SessionCredentials) => Effect.Effect<void, CredentialsStoreError>;
  /** Drops a password the server refused and keeps whose data this is, so it is not tried on every start. */
  readonly forgetPassword: Effect.Effect<void, CredentialsStoreError>;
  readonly clear: Effect.Effect<void, CredentialsStoreError>;
}

export class CredentialsStore extends Context.Service<CredentialsStore, CredentialsStoreService>()("@muswag/backend/CredentialsStore") {}

/** Encrypts the stored password, e.g. with Electron's `safeStorage`. */
export interface CredentialsCipher {
  /** False when the platform has no usable keychain; the password is then stored as is. */
  readonly isAvailable: () => boolean;
  readonly encrypt: (plain: string) => string;
  readonly decrypt: (encrypted: string) => string;
}

const ROW_ID = 1;

/** Keeps the credentials in the database's `credentials` table, which is never mirrored. */
export const CredentialsStoreSql = (cipher?: CredentialsCipher) =>
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
        load: Effect.gen(function* () {
          const stored = yield* storedRow;
          // A forgotten password is stored as an empty one, which no login saves.
          if (!stored || stored.password === "") return null;
          const password = stored.encrypted ? yield* Effect.try(() => cipher!.decrypt(stored.password)) : stored.password;
          return { url: stored.url, username: stored.username, password };
        }).pipe(Effect.mapError(failure("load", "Failed to load stored credentials"))),

        account: storedRow.pipe(
          Effect.map((stored) => (stored ? { url: stored.url, username: stored.username } : null)),
          Effect.mapError(failure("load", "Failed to load the stored account")),
        ),

        save: (credentials) =>
          Effect.gen(function* () {
            const encrypted = cipher?.isAvailable() ?? false;
            const password = encrypted ? yield* Effect.try(() => cipher!.encrypt(credentials.password)) : credentials.password;
            const row = { id: ROW_ID, url: credentials.url, username: credentials.username, password, encrypted };
            yield* db.insert(credentialsTable).values(row).onConflictDoUpdate({ target: credentialsTable.id, set: row });
          }).pipe(Effect.mapError(failure("save", "Failed to save credentials"))),

        forgetPassword: db
          .update(credentialsTable)
          .set({ password: "", encrypted: false })
          .where(eq(credentialsTable.id, ROW_ID))
          .pipe(Effect.asVoid, Effect.mapError(failure("save", "Failed to forget the stored password"))),

        clear: db.delete(credentialsTable).pipe(Effect.asVoid, Effect.mapError(failure("clear", "Failed to clear credentials"))),
      } satisfies CredentialsStoreService;
    }),
  );
