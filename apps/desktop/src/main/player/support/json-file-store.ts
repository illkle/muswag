import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type JsonFileStore<T> = {
  load(): T;
  save(state: T): void;
};

export function createJsonFileStore<T>(filePath: string, parse: (raw: unknown) => T): JsonFileStore<T> {
  return {
    load() {
      try {
        return parse(JSON.parse(readFileSync(filePath, "utf8")));
      } catch {
        return parse(undefined);
      }
    },
    save(state) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    },
  };
}
