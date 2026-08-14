export function createLineSplitter(onLine: (line: string) => void): {
  push(chunk: string): void;
  flush(): void;
} {
  let buffer = "";

  const emit = (line: string) => {
    const normalized = line.replace(/\r$/, "");
    if (normalized.trim().length > 0) {
      onLine(normalized);
    }
  };

  return {
    push(chunk) {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        emit(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    flush() {
      if (buffer.length === 0) {
        return;
      }
      const trailing = buffer;
      buffer = "";
      emit(trailing);
    },
  };
}
