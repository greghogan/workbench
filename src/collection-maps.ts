import { sep } from "node:path";
import { relativeRecordPath } from "./core.js";
import type { Decision } from "./decision-record.js";
import { wrap } from "./formatting.js";

export function renderCollectionMap(decisions: Decision[]): string {
  let output = "# Decision map\n\nRead applicable decisions; entries identify their topics.\n";
  for (const decision of decisions) {
    const number = decision.reference.split("ADR-")[1] ?? "";
    output += `\n- ${wrap(`[${decision.reference}](${relativeRecordPath("ADR", number).split(sep).join("/")}): ${decision.title} — ${decision.summary}`, 120, 2)}`;
    if (decision.overrides.length) output += `\n  Overrides: ${decision.overrides.join(", ")}.`;
  }
  return `${output}\n`;
}
