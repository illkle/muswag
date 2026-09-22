import { Stream } from "effect";

/** Frame output before redaction, including URLs split across transport chunks. */
export const installationLines = <E, R>(stream: Stream.Stream<Uint8Array, E, R>): Stream.Stream<string, E, R> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.mapAccum(
      () => ({ buffer: "", oversized: false }),
      (state, chunk) => {
        const lines: string[] = [];
        let start = 0;
        while (start < chunk.length) {
          const end = chunk.indexOf("\n", start);
          const part = chunk.slice(start, end < 0 ? undefined : end);
          if (!state.oversized) {
            if (state.buffer.length + part.length > 8192) {
              state.buffer = "";
              state.oversized = true;
            } else state.buffer += part;
          }
          if (end < 0) break;
          lines.push(state.oversized ? "[output line exceeded 8192 characters]" : state.buffer.replace(/\r$/, ""));
          state = { buffer: "", oversized: false };
          start = end + 1;
        }
        return [state, lines];
      },
      { onHalt: (state) => (state.oversized ? ["[output line exceeded 8192 characters]"] : state.buffer ? [state.buffer] : []) },
    ),
    Stream.map((line) => line.replace(/https?:\/\/\S+/g, "[url]").slice(0, 2048)),
  );
