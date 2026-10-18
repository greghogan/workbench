/** A presentation preference changes output, never authorization or command semantics. */
export function plainOutput(): boolean {
  const value = process.env.WORKBENCH_PLAIN;
  if (value === undefined || value === "") return false;
  if (["1", "true"].includes(value)) return true;
  if (["0", "false"].includes(value)) return false;
  throw new Error("WORKBENCH_PLAIN must be 1, 0, true, or false");
}

/** Carry the resolved personal preference through Workbench subprocesses and Git hooks. */
export function configurePresentation(explicit: boolean | undefined, saved: boolean): void {
  const inherited = process.env.WORKBENCH_PLAIN;
  const selected = explicit ?? (inherited ? plainOutput() : saved);
  process.env.WORKBENCH_PLAIN = selected ? "1" : "0";
}

export function colorDisabled(): boolean {
  return plainOutput() || (process.env.NO_COLOR ?? "").length > 0;
}
