import { basename, extname } from "node:path";
import { normalizedNumber, type Kind } from "../core/records/record-identity.js";
export function reportCreatedRecord(project: { id: string }, kind: Kind, path: string): void {
  const number = normalizedNumber(basename(path, extname(path)).slice(kind.length + 1));
  console.log(`Created ${project.id}:${kind}-${number} at ${path}.`);
  if (kind === "ADR")
    console.log("Draft created: replace the summary and write the decision; a human reviews this file before commit.");
  if (kind === "ENV")
    console.log(
      "Draft created. Describe the hardware in ## Hardware configuration. A human reviews this record and its supporting files before commit.",
    );
  if (kind === "CIT")
    console.log(
      "Draft created. Complete author, issued date or literal, and HTTPS URL in the CSL-JSON, plus at least one source with kind, matching landing-url and status in acquisition.yaml. Use 'workbench citation add IDENTIFIER' to acquire available metadata instead.",
    );
  if (["ADR", "ENV", "CIT"].includes(kind))
    console.log(`Next: workbench validate (draft requirements remain enforced).`);
}
