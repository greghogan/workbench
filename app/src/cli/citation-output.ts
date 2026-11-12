import { citationStatus } from "../core/citations/citations.js";
import { terminalTable } from "../core/diagnostics/terminal-table.js";
export function listCitationStatus(
  root: string,
  options: { project?: string; source?: string; missing?: boolean; json?: boolean },
): void {
  const entries = citationStatus(root, options.project).filter(
    (entry) =>
      (options.source === undefined || entry.source === options.source) && (!options.missing || !entry.present),
  );
  if (options.json) console.log(JSON.stringify(entries, null, 2));
  else if (!entries.length)
    console.log(options.missing ? "No missing citation documents." : "No citation sources found.");
  else {
    console.log(
      terminalTable(
        ["CITATION", "TITLE", "SOURCE", "FILE", "ACQUISITION", "DOCUMENT URL"],
        entries.map((entry) => [
          entry.id,
          entry.title,
          entry.source,
          entry.present ? "present" : "missing",
          entry.state,
          entry.downloadUrl ? "set" : "missing",
        ]),
      ),
    );
    const present = entries.filter((entry) => entry.present).length;
    console.log(
      `Citations: ${String(new Set(entries.map((entry) => entry.id)).size)}; sources: ${String(entries.length)}; present: ${String(present)}; missing: ${String(entries.length - present)}.`,
    );
  }
}
