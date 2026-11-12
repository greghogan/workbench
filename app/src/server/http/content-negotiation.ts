/** Explicit coding preferences override wildcards; identity remains acceptable unless explicitly excluded. */
function encodingPreferences(header: string | undefined): Map<string, number> {
  const choices = new Map<string, number>();
  for (const part of (header ?? "").split(",")) {
    const [name, ...parameters] = part.trim().toLowerCase().split(";");
    if (!name?.trim()) continue;
    const parameter = parameters.map((value) => value.trim()).find((value) => /^q\s*=/.test(value));
    const quality = parameter ? Number(parameter.slice(parameter.indexOf("=") + 1).trim()) : 1;
    choices.set(name.trim(), Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0);
  }
  return choices;
}
/** Server preference breaks quality ties; undefined means no available representation is acceptable. */
export function negotiateEncoding<T extends string>(
  header: string | undefined,
  available: readonly T[],
): T | undefined {
  const choices = encodingPreferences(header);
  let selected: T | undefined,
    quality = 0;
  for (const encoding of available) {
    const next =
      choices.get(encoding) ?? (encoding === "identity" ? (choices.get("*") === 0 ? 0 : 1) : (choices.get("*") ?? 0));
    if (next > quality) {
      selected = encoding;
      quality = next;
    }
  }
  return selected;
}
