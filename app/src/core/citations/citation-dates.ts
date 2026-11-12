export const citationDateFields = [
  "issued",
  "accessed",
  "available-date",
  "event-date",
  "original-date",
  "submitted",
] as const;
export interface CitationDate {
  literal?: string;
  raw?: string;
  "date-parts"?: (number | string)[][];
}
/** Validate supported CSL dates without inventing missing precision or treating descriptions as years. */
export function citationDate(value: unknown): CitationDate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const date = value as Record<string, unknown>;
  const literal = date.literal ?? date.raw;
  if (literal !== undefined && (typeof literal !== "string" || !literal.trim())) return;
  const parts = date["date-parts"];
  if (parts === undefined) return typeof literal === "string" ? date : undefined;
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 2) return;
  for (const part of parts as unknown[]) {
    if (!Array.isArray(part) || part.length < 1 || part.length > 3) return;
    for (const [index, component] of (part as unknown[]).entries()) {
      if (!(
        (typeof component === "number" && Number.isSafeInteger(component)) ||
        (typeof component === "string" && /^-?\d+$/.test(component) && Number.isSafeInteger(Number(component)))
      ))
        return;
      const number = Number(component);
      if ((index === 1 && (number < 1 || number > 12)) || (index === 2 && (number < 1 || number > 31))) return;
    }
  }
  return date;
}
export function citationDateText(value: unknown, yearOnly = false): string | undefined {
  const date = citationDate(value);
  if (!date) return;
  const literal = (date.literal ?? date.raw)?.trim();
  if (literal) return /^(?:n\.?\s*d\.?|undated)$/i.test(literal) ? undefined : literal;
  return date["date-parts"]
    ?.map((parts) =>
      (yearOnly ? parts.slice(0, 1) : parts)
        .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, "0")))
        .join("-"),
    )
    .join("–");
}
