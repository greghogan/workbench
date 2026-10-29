import { parseReference, scan } from "./record-files.js";
import { readProjects } from "./project-configuration.js";
import { readText } from "./files.js";
import { rootOf } from "./project-context.js";
import { writeAtomic } from "../scripts/file-publication.mjs";
import { recordDocument, terminalTask } from "./record-document.js";
import { InvalidInput } from "./input-errors.js";
import { markdownLiteralLines } from "./markdown-links.js";

/** Linked child items project authoritative status; ordinary inline steps remain agent-owned prose. */
export function taskChecklistChanges(
  root: string,
  overrides: ReadonlyMap<string, string> = new Map(),
): { path: string; original: string; contents: string }[] {
  const tasks = readProjects(root).flatMap((project) =>
    scan(rootOf(root, project), "TSK").map((record) => {
      const original = readText(record.path),
        contents = overrides.get(record.path) ?? original;
      return {
        ...record,
        project,
        original,
        contents,
        metadata: recordDocument("TSK", contents, record.path).metadata,
      };
    }),
  );
  const byPath = new Map(tasks.map((task) => [task.path, task]));
  const replacements: { path: string; original: string; contents: string }[] = [];
  for (const task of tasks) {
    const literal = markdownLiteralLines(task.contents);
    const contents = task.contents
      .split("\n")
      .map((line, index) => {
        if (literal.has(index)) return line;
        const ending = line.endsWith("\r") ? "\r" : "";
        const item = /^(\s*- \[)([ xX])(\] )(.*)$/.exec(ending ? line.slice(0, -1) : line);
        if (!item) return line;
        const linked = /^([a-z][a-z0-9_-]*:TSK-[0-9a-z]+)(?=:|\s|$)/i.exec(item[4] ?? "")?.[1];
        let checked = item[2]?.toLowerCase() === "x";
        let description = item[4] ?? "";
        if (linked) {
          const child = byPath.get(parseReference(root, linked).path);
          if (!child) throw new InvalidInput(`${task.path}: checklist child not found: ${linked}`);
          if (!child.metadata.parent || parseReference(root, child.metadata.parent).path !== task.path)
            throw new InvalidInput(`${task.path}: checklist reference is not a child task: ${linked}`);
          checked = terminalTask.has(child.metadata.status);
          const detail = description
            .slice(linked.length)
            .replace(/^ \((?:Planned|Approved|Accepted|Canceled)\)/, "")
            .replace(/^:\s*/, "")
            .trimStart();
          description = `${linked} (${child.metadata.status}): ${detail}`;
        }
        if (task.metadata.status === "Accepted" && !checked)
          throw new InvalidInput(`${task.path}: Accepted task has an unchecked step: ${item[4] ?? ""}`);
        return `${item[1] ?? ""}${checked ? "x" : " "}${item[3] ?? ""}${description}${ending}`;
      })
      .join("\n");
    if (contents !== task.original) replacements.push({ path: task.path, original: task.original, contents });
  }
  return replacements;
}

export function syncTaskChecklists(root: string, checkOnly = false): string[] {
  const replacements = taskChecklistChanges(root);
  if (checkOnly && replacements.length)
    throw new Error(
      `${replacements.map((entry) => entry.path).join(", ")}: task checkboxes are stale; run 'workbench sync'`,
    );
  for (const replacement of replacements)
    if (readText(replacement.path) !== replacement.original)
      throw new Error(`${replacement.path}: task changed during checklist synchronization; retry`);
  for (const replacement of replacements) writeAtomic(replacement.path, replacement.contents);
  return replacements.map((replacement) => replacement.path);
}
