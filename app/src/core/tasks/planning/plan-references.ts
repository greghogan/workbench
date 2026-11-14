/** Rewrite complete scoped identities, preserving similarly named plans and unrelated paths. */
export function rewritePlanReferences(contents: string, mapping: ReadonlyMap<string, string>): string {
  const names = [...mapping.keys()]
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!names.length) return contents;
  return contents.replace(
    new RegExp(`(?<![\\p{L}\\p{N}_:/-])(?:${names.join("|")})(?![\\p{L}\\p{N}_/-])`, "gu"),
    (reference) => mapping.get(reference) ?? reference,
  );
}
