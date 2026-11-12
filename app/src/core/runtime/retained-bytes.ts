/** Conservative graph accounting stops as soon as its caller's budget is exceeded. */
export function retainedBytes(value: unknown, maximum = Number.POSITIVE_INFINITY): number {
  const seen = new Set<object>();
  let bytes = 0;
  const charge = (value: unknown): void => {
    if (bytes > maximum) return;
    if (typeof value === "string") {
      bytes += 24 + value.length * 2;
      return;
    }
    if (value === null || typeof value !== "object") {
      bytes += 8;
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);
    if (value instanceof Map) {
      bytes += 64;
      for (const [key, entry] of value as Map<unknown, unknown>) {
        bytes += 40;
        charge(key);
        charge(entry);
        if (bytes > maximum) break;
      }
    } else if (Array.isArray(value)) {
      bytes += 32;
      for (const entry of value) {
        bytes += 8;
        charge(entry);
        if (bytes > maximum) break;
      }
    } else {
      bytes += 32;
      for (const key in value)
        if (Object.hasOwn(value, key)) {
          bytes += 16;
          charge(key);
          charge((value as Record<string, unknown>)[key]);
          if (bytes > maximum) break;
        }
    }
  };
  charge(value);
  return bytes;
}
