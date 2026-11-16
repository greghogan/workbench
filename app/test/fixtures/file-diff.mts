/** Recover the displayed source independently of syntax spans, gutters, and context controls. */
export function displayedSource(root: ParentNode, side: "before" | "after"): string {
  return [
    ...root.querySelectorAll(`[data-side="${side}"] code[data-source-line], [data-side="both"] code[data-source-line]`),
  ]
    .map((line) => line.textContent + (line.getAttribute("data-newline") === "1" ? "\n" : ""))
    .join("");
}
