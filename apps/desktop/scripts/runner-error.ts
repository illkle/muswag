import { Data } from "effect";

export class RunnerError extends Data.TaggedError("RunnerError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}
