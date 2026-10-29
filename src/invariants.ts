export { required } from "../scripts/values.mjs";

/** Human-facing widths count grapheme clusters, including composed characters and emoji. */
export function textLength(value: string): number {
  return Array.from(new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value)).length;
}
