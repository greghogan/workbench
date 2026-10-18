/** Decimal SI quantities for human-readable size estimates. */
export function formatBytes(value: number): string {
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
export function parseDockerBytes(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(B|kB|KB|MB|GB|TB)$/.exec(text.trim());
  return match
    ? Number(match[1]) * 1000 ** ["B", "kB", "MB", "GB", "TB"].indexOf(match[2] === "KB" ? "kB" : (match[2] ?? ""))
    : 0;
}
