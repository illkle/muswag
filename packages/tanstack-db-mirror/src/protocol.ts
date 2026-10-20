/**
 * Wire protocol between the process that owns SQLite (server) and the processes that mirror
 * it into TanStack DB collections (clients). Every payload is structured-clone friendly.
 *
 * Ordering model: the server assigns every captured row change a strictly increasing `seq`.
 * A batch covers the half-open range `(fromSeq, toSeq]` and contains every change in it, so a
 * client that has applied everything up to `cursor` can detect gaps (`fromSeq > cursor`).
 */

export const MIRROR_PROTOCOL_VERSION = 1 as const;

export type MirrorKey = string | number;

/**
 * A point in the change stream. `epoch` increases every time a server starts on the database;
 * clients ignore older epochs and reload when they see a newer one.
 */
export type MirrorPosition = { readonly epoch: number; readonly seq: number };
export type MirrorRow = Record<string, unknown>;

export type MirrorChange =
  | { readonly seq: number; readonly table: string; readonly type: "upsert"; readonly key: MirrorKey; readonly value: MirrorRow }
  /** A row of a key-only table was inserted or updated; it is not sent, so a client that needs it reads it again. */
  | { readonly seq: number; readonly table: string; readonly type: "changed"; readonly key: MirrorKey }
  | { readonly seq: number; readonly table: string; readonly type: "delete"; readonly key: MirrorKey };

export type MirrorChangeBatch = {
  readonly epoch: number;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly changes: ReadonlyArray<MirrorChange>;
};

export type MirrorMutation =
  | { readonly table: string; readonly type: "insert"; readonly value: MirrorRow }
  | { readonly table: string; readonly type: "update"; readonly key: MirrorKey; readonly changes: MirrorRow }
  | { readonly table: string; readonly type: "delete"; readonly key: MirrorKey };

export type MirrorRequestPayloads = {
  /** Opens the change stream: returns the last seq the server has broadcast. */
  readonly hello: {};
  readonly snapshot: { readonly table: string };
  readonly mutate: { readonly mutations: ReadonlyArray<MirrorMutation> };
  /** Fetches every change after `fromSeq`, used to recover from a gap in the stream. */
  readonly pull: { readonly fromSeq: number };
  /** Reads the rows of a table that `where` matches, in `orderBy`, a window of them when `limit` is given. */
  readonly query: MirrorQuery;
  /** Counts the rows of a table that `where` matches. */
  readonly count: { readonly table: string; readonly where?: MirrorExpression | undefined };
};

/**
 * A filter over a row's properties, in the shape of TanStack DB's expressions: a property, a constant,
 * or an operator applied to others (`eq`, `gt`, `gte`, `lt`, `lte`, `in`, `and`, `or`, `not`, `isNull`,
 * `isUndefined`, `ilike`).
 */
export type MirrorExpression =
  | { readonly type: "ref"; readonly path: ReadonlyArray<string> }
  | { readonly type: "val"; readonly value: unknown }
  | { readonly type: "func"; readonly name: string; readonly args: ReadonlyArray<MirrorExpression> };

export type MirrorOrder = { readonly property: string; readonly direction: "asc" | "desc"; readonly nulls: "first" | "last" };

export type MirrorQuery = {
  readonly table: string;
  readonly where?: MirrorExpression | undefined;
  readonly orderBy?: ReadonlyArray<MirrorOrder> | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
};

export type MirrorResults = {
  readonly hello: { readonly epoch: number; readonly seq: number };
  readonly snapshot: { readonly epoch: number; readonly seq: number; readonly rows: ReadonlyArray<MirrorRow> };
  /** `seq` is the last change produced by the mutation; clients wait for it to come back through the stream. */
  readonly mutate: { readonly epoch: number; readonly seq: number };
  readonly pull:
    | { readonly epoch: number; readonly kind: "changes"; readonly batch: MirrorChangeBatch }
    /** The requested range is no longer retained; the client must reload its collections. */
    | { readonly epoch: number; readonly kind: "reset" };
  /** The rows as of `seq`: a change after it may have changed them. */
  readonly query: { readonly epoch: number; readonly seq: number; readonly rows: ReadonlyArray<MirrorRow> };
  readonly count: { readonly epoch: number; readonly seq: number; readonly count: number };
};

export type MirrorRequestType = keyof MirrorRequestPayloads;

export type MirrorRequest<T extends MirrorRequestType = MirrorRequestType> = {
  [K in T]: { readonly v: typeof MIRROR_PROTOCOL_VERSION; readonly type: K } & MirrorRequestPayloads[K];
}[T];

export type MirrorErrorPayload = {
  readonly name: string;
  readonly message: string;
};

export type MirrorResponse<T extends MirrorRequestType = MirrorRequestType> = { readonly ok: true; readonly result: MirrorResults[T] } | { readonly ok: false; readonly error: MirrorErrorPayload };

/** Transport used by the SQLite-owning process. */
export interface MirrorServerTransport {
  /** Installs the request handler. Returns a function that uninstalls it. */
  readonly listen: (handler: (request: unknown) => Promise<MirrorResponse>) => () => void;
  /** Sends a change batch to every connected client, preserving call order per client. */
  readonly broadcast: (batch: MirrorChangeBatch) => void;
}

/** Transport used by a mirroring process. */
export interface MirrorClientTransport {
  readonly request: <T extends MirrorRequestType>(request: MirrorRequest<T>) => Promise<MirrorResponse<T>>;
  /** Batches must be delivered in the order the server broadcast them. */
  readonly subscribe: (listener: (batch: MirrorChangeBatch) => void) => () => void;
}
