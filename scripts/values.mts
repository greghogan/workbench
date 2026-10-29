/** Narrow data read across process and file boundaries before using its fields. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");
}

export function required<T>(value: T, context: string): NonNullable<T> {
  if (value === undefined || value === null) throw new Error(context);
  return value;
}

export function record(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(context);
  return value;
}

export function string(value: unknown, context: string): string {
  if (typeof value !== "string") throw new Error(context);
  return value;
}

export function strings(value: unknown, context: string): string[] {
  if (!isStringArray(value)) throw new Error(context);
  return value;
}

export function records(value: unknown, context: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error(context);
  return value;
}

export function stringRecord(value: unknown, context: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record(value, context)).map(([key, entry]) => [key, string(entry, context)]),
  );
}

/** Node's spawn typings omit the null output produced when a stream is inherited. */
export function capturedText(value: string | Buffer | null): string {
  return value?.toString() ?? "";
}

export function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(typeof value === "string" ? value : JSON.stringify(value));
}
