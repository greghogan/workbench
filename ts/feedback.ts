import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseReference, readText, writeAtomic, writeNew } from "./core.js";

function directory(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) {
    if (!isAbsolute(xdg)) throw new Error("XDG_DATA_HOME must be an absolute path");
    return join(xdg, "workbench/feedback");
  }
  if (!process.env.HOME) throw new Error("HOME or XDG_DATA_HOME is required for local feedback");
  return join(process.env.HOME, ".local/share/workbench/feedback");
}

export function addFeedback(title: string): string {
  if (!title.trim() || /[\r\n]/.test(title)) throw new Error("feedback title must be one nonempty line");
  const folder = directory();
  mkdirSync(folder, { recursive: true });
  const id = `${BigInt(Date.now()) * 1000000n + (process.hrtime.bigint() % 1000000n)}`;
  const path = join(folder, `${id}.md`);
  writeNew(
    path,
    `# ${title.trim()}\n\nDisposition: New\n\n## Observed problem\n\n## Context\n\n` +
      "## Desired outcome\n\n## Resolution\n",
  );
  console.log(`Created feedback ${id} at ${path}`);
  return path;
}

export function resolveFeedback(
  root: string,
  id: string,
  dispositionInput: string,
  explanation: string,
  references: string[],
): void {
  if (!/^\d+$/.test(id)) throw new Error("feedback ID must contain only decimal digits");
  const disposition = { accepted: "Accepted", rejected: "Rejected" }[
    dispositionInput.toLowerCase() as "accepted" | "rejected"
  ];
  if (!disposition) throw new Error("feedback disposition must be 'accepted' or 'rejected'");
  if (!explanation.trim() || /[\r\n]/.test(explanation))
    throw new Error("feedback explanation must be one nonempty line");
  for (const reference of references) {
    const parsed = parseReference(root, reference);
    if (!existsSync(parsed.path)) throw new Error(`record not found: ${reference}`);
  }
  const path = join(directory(), `${id}.md`);
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw new Error(`${path}: expected a regular feedback file`);
  }
  const original = readText(path);
  const headerEnd = original.indexOf("\n## ");
  const header = headerEnd < 0 ? original : original.slice(0, headerEnd);
  if (!header.split(/\r?\n/).includes("Disposition: New")) throw new Error(`${path}: feedback is not open`);
  const revised =
    header.replace("Disposition: New", `Disposition: ${disposition}`) +
    (headerEnd < 0 ? "" : original.slice(headerEnd));
  const marker = "## Resolution\n";
  const position = revised.lastIndexOf(marker);
  if (position < 0) throw new Error(`${path}: missing resolution section`);
  if (revised.slice(position + marker.length).trim()) throw new Error(`${path}: resolution already has content`);
  writeAtomic(
    path,
    `${revised.slice(0, position)}${marker}\n${explanation.trim()}\n` +
      (references.length ? `\nRecords: ${references.join(", ")}\n` : ""),
  );
  console.log(`Resolved feedback at ${path}`);
}
