import { formatBytes } from "../byte-size.js";
import type { CacheSize } from "../cache-size.js";
export interface Quantity {
  text: string;
  pending: boolean;
  title: string;
  directories: string[];
  extra: number | undefined;
  uncertain: boolean;
}
export function cacheQuantity(
  complete: boolean,
  sizes: ReadonlyMap<string, CacheSize>,
  directories: string[],
  ...totals: [extra?: number | undefined, uncertain?: boolean]
): Quantity {
  const extra = totals.length ? totals[0] : 0,
    uncertain = (totals[1] ?? false) || extra === undefined;
  const values = directories.map((directory) => sizes.get(directory));
  const known = complete && values.every((value) => value?.bytes !== undefined);
  const pending = values.some((value) => value?.state !== "ready");
  const missing = values.filter((value) => value?.bytes === undefined);
  const failed = values.some((value) => value?.state === "error");
  const unavailable = complete && missing.length > 0 && missing.every((value) => value?.state === "error");
  return {
    directories,
    extra,
    uncertain: uncertain || !complete,
    text:
      known && uncertain
        ? "Unknown"
        : known
          ? formatBytes((extra ?? 0) + values.reduce((sum, entry) => sum + (entry?.bytes ?? 0), 0))
          : unavailable
            ? "Unavailable"
            : "Calculating…",
    pending: !known || uncertain,
    title: failed
      ? "Some sizes could not be measured; the last measurement is shown when available"
      : !known
        ? "Size measurement is pending"
        : pending
          ? "Last measured estimate; updates when a new measurement is available"
          : "Measured filesystem estimate",
  };
}
