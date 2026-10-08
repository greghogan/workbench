import { required } from "./invariants.js";
import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { userDirectory } from "./storage.js";
import { parseReference, readText, writeAtomic, writeNew } from "./core.js";

function directory(): string {
  return join(userDirectory("data"), "feedback");
}

export function addFeedback(title: string): string {
  if (!title.trim() || /[\r\n]/.test(title)) throw new Error("feedback title must be one nonempty line");
  const folder = directory();
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const id = String(BigInt(Date.now()) * 1000000n + (process.hrtime.bigint() % 1000000n));
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
  const path = feedbackPath(id);
  const original = readText(path);
  const headerEnd = original.indexOf("\n## ");
  const header = headerEnd < 0 ? original : original.slice(0, headerEnd);
  if (!header.split(/\r?\n/).includes("Disposition: New")) throw new Error(`${path}: feedback is not open`);
  const revised =
    header.replace("Disposition: New", `Disposition: ${disposition}`) +
    (headerEnd < 0 ? "" : original.slice(headerEnd));
  const marker = [...revised.matchAll(/^## Resolution(\r?\n)/gm)].at(-1);
  if (!marker) throw new Error(`${path}: missing resolution section`);
  const position = marker.index;
  const newline = required(marker[1], "expected marker[1]");
  if (revised.slice(position + marker[0].length).trim()) throw new Error(`${path}: resolution already has content`);
  writeAtomic(
    path,
    `${revised.slice(0, position)}${marker[0]}${newline}${explanation.trim()}${newline}` +
      (references.length ? `${newline}Records: ${references.join(", ")}${newline}` : ""),
  );
  console.log(`Resolved feedback at ${path}`);
}

function feedbackPath(id: string): string {
  if (!/^\d+$/.test(id)) throw new Error("feedback ID must contain only decimal digits");
  const path = join(directory(), `${id}.md`);
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error(`${path}: expected a regular feedback file`);
  return path;
}

export function showFeedback(id: string, json = false): void {
  const path = feedbackPath(id);
  const contents = readText(path);
  if (json) console.log(JSON.stringify({ id, path, contents }, null, 2));
  else console.log(`${path}\n${contents}`);
}

export function queryFeedback(options: { all?: boolean; json?: boolean }, query?: string): void {
  if (query !== undefined && !query.trim()) throw new Error("search query must be nonempty");
  const folder = directory();
  const needle = query?.toLowerCase();
  const results = (existsSync(folder) ? readdirSync(folder) : [])
    .filter((name) => /^\d+\.md$/.test(name))
    .sort()
    .flatMap((name) => {
      const id = name.slice(0, -3);
      const path = feedbackPath(id);
      const contents = readText(path);
      const header = required(contents.split(/\r?\n## /, 1)[0], "expected contents.split(/\\r?\\n## /, 1)[0]");
      const disposition = /^Disposition: (.+)$/m.exec(header)?.[1];
      if (!options.all && disposition !== "New") return [];
      if (needle && !`${id}\n${contents}`.toLowerCase().includes(needle)) return [];
      return [
        {
          id,
          title: required(contents.split(/\r?\n/, 1)[0], "expected contents.split(/\\r?\\n/, 1)[0]").replace(/^# /, ""),
          disposition,
          path,
        },
      ];
    });
  if (options.json) console.log(JSON.stringify(results, null, 2));
  else if (!results.length) console.log("No matching feedback.");
  else for (const result of results) console.log(`${result.id}: ${result.title} (${String(result.disposition)})`);
}
