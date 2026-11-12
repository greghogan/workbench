/** Decimal SI quantities for human-readable size estimates. */
export function formatBytes(value: number | undefined): string {
  if (value === undefined) return "Unavailable";
  let unit = "B";
  for (const next of ["kB", "MB", "GB", "TB"]) {
    if (value < 1000) break;
    value /= 1000;
    unit = next;
  }
  return `${value.toFixed(unit === "B" ? 0 : 1)} ${unit}`;
}

/** Exact, locale-independent byte counts for enforced bounds. */
export const formatByteCount = (value: number): string => value.toLocaleString("en-US", { maximumFractionDigits: 0 });

/** Docker reports decimal quantities, sometimes spelling kB as KB. */
export function parseDockerBytes(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*(B|kB|KB|MB|GB|TB)$/.exec(text.trim());
  return match
    ? Number(match[1]) * 1000 ** ["B", "kB", "MB", "GB", "TB"].indexOf(match[2] === "KB" ? "kB" : (match[2] ?? ""))
    : undefined;
}

/** A total is known only when every selected quantity is known. Empty selections are zero. */
export function totalBytes(values: Iterable<number | undefined>): number | undefined {
  let total = 0;
  for (const value of values) {
    if (value === undefined) return undefined;
    total += value;
  }
  return total;
}
export function addBytes(...values: (number | undefined)[]): number | undefined {
  return totalBytes(values);
}
export function subtractBytes(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined || right === undefined ? undefined : left - right;
}
