import { sep } from "node:path";
import { relativeRecordPath } from "./core.js";
import type { Decision } from "./decision-record.js";
import { wrap } from "./formatting.js";

export function renderCollectionMap(decisions: Decision[], width = 120): string {
  let output = "# Decision map\n\nRead applicable decisions; entries identify their topics.\n";
  output += `\n${wrap("[Published collection charter (context)](CHARTER.md) describes the provider's purpose and boundaries. After adoption, the consuming project's charter governs these ADRs; this published charter supplies no additional authority.", width)}\n`;
  for (const decision of decisions) {
    const number = decision.reference.split("ADR-")[1] ?? "";
    output += `\n- ${wrap(`[${decision.reference}: ${decision.title}](${relativeRecordPath("ADR", number).split(sep).join("/")}) — ${decision.summary}`, width, 2)}`;
  }
  return `${output}\n`;
}
