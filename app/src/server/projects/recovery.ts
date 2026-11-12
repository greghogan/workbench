export interface RecoveryLink {
  href: string;
  label: string;
}
/** Recovery can navigate locally; it never submits or repeats a mutation. */
export function decodeRecovery(value: unknown): RecoveryLink | undefined {
  if (!value || typeof value !== "object" || !("href" in value) || !("label" in value)) return;
  const { href, label } = value;
  if (
    typeof href !== "string" ||
    typeof label !== "string" ||
    !label.trim() ||
    label.length > 160 ||
    !href.startsWith("/") ||
    href.startsWith("//") ||
    href.length > 8192 ||
    href.includes("\\")
  )
    return;
  for (let index = 0; index < href.length; index++) {
    const code = href.charCodeAt(index);
    if (code <= 32 || code === 127) return;
  }
  return { href, label };
}
