/** Check values whose presence follows from a parser or collection invariant. */
export function required<T>(value: T, context: string): NonNullable<T> {
  if (value === undefined || value === null) throw new Error(context);
  return value;
}

/** Human-facing widths count grapheme clusters, including composed characters and emoji. */
export function textLength(value: string): number {
  return Array.from(new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value)).length;
}
