import { credentials as credentialsTable, type SessionCredentials } from "@muswag/model";
import { eq } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";

import { Db } from "../db/database.js";

export class CredentialsStoreError extends Data.TaggedError("CredentialsStoreError")<{
  readonly operation: "load" | "save" | "clear";
  readonly message: string;
  readonly cause: unknown;
}> {}

export interface CredentialsStoreService {
  readonly load: Effect.Effect<SessionCredentials | null, CredentialsStoreError>;
  readonly save: (credentials: SessionCredentials) => Effect.Effect<void, CredentialsStoreError>;
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

      return {
        load: Effect.gen(function* () {
          const [row] = yield* db.select().from(credentialsTable).where(eq(credentialsTable.id, ROW_ID));
          if (!row) return null;
          const password = row.encrypted ? yield* Effect.try(() => cipher!.decrypt(row.password)) : row.password;
          return { url: row.url, username: row.username, password };
        }).pipe(Effect.mapError(failure("load", "Failed to load stored credentials"))),

        save: (credentials) =>
          Effect.gen(function* () {
            const encrypted = cipher?.isAvailable() ?? false;
            const password = encrypted ? yield* Effect.try(() => cipher!.encrypt(credentials.password)) : credentials.password;
            const row = { id: ROW_ID, url: credentials.url, username: credentials.username, password, encrypted };
            yield* db.insert(credentialsTable).values(row).onConflictDoUpdate({ target: credentialsTable.id, set: row });
          }).pipe(Effect.mapError(failure("save", "Failed to save credentials"))),

        clear: db.delete(credentialsTable).pipe(Effect.asVoid, Effect.mapError(failure("clear", "Failed to clear credentials"))),
      } satisfies CredentialsStoreService;
    }),
  );
