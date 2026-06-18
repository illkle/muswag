export function stripVirtualProps<T extends object>(obj: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!key.startsWith("$")) {
      result[key] = value;
    }
  }
  return result as T;
}
