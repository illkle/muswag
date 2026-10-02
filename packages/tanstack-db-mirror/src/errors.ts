/** A table definition the mirror cannot serve, or one registered twice. */
export class MirrorSchemaError extends Error {
  override readonly name = "MirrorSchemaError";
}
