import { dirname, resolve, sep } from "node:path";
import type { Decision } from "../records/decision-record.js";
import { wrap } from "../records/formatting.js";
import { markdownLabel, markdownPath, relocateMarkdownLinks } from "../records/markdown-links.js";
import { relativeRecordPath } from "../records/record-identity.js";

export function renderCollectionMap(decisions: Decision[], width = 120): string {
  let output = "# Decision map\n\nPublished charter: [CHARTER.md](CHARTER.md).\n";
  for (const decision of decisions) {
    const number = decision.reference.split("ADR-")[1] ?? "";
    const recordPath = relativeRecordPath("ADR", number);
    const map = resolve(
      dirname(decision.path),
      ...dirname(recordPath)
        .split(sep)
        .map(() => ".."),
      "decision-map.md",
    );
    output += `\n- ${wrap(`[${markdownLabel(`${decision.reference}: ${decision.title}`)}](${markdownPath(recordPath)}) — ${relocateMarkdownLinks(decision.summary, decision.path, map)}`, width, 2)}`;
  }
  return `${output}\n`;
}
