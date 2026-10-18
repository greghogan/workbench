import { parseReference, readProjects, readText, rootOf, scan, writeAtomic } from "./core.js";
import { recordDocument, terminalTask } from "./record-document.js";

/** Linked child items project authoritative status; ordinary inline steps remain agent-owned prose. */
export function syncTaskChecklists(root: string, checkOnly = false): string[] {
  const tasks = readProjects(root).flatMap((project) =>
    scan(rootOf(root, project), "TSK").map((record) => {
      const contents = readText(record.path);
      return { ...record, project, contents, metadata: recordDocument("TSK", contents, record.path).metadata };
    }),
  );
  const byPath = new Map(tasks.map((task) => [task.path, task]));
  const replacements: { path: string; original: string; contents: string }[] = [];
  for (const task of tasks) {
    let fence: string | undefined;
    const contents = task.contents
      .split("\n")
      .map((line) => {
        const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
        if (marker) {
          if (!fence) fence = marker;
          else if (marker.startsWith(fence[0] ?? "") && marker.length >= fence.length) fence = undefined;
          return line;
        }
        if (fence) return line;
        const item = /^(\s*- \[)([ xX])(\] )(.*)$/.exec(line);
        if (!item) return line;
        const linked = /^([a-z][a-z0-9_-]*:TSK-[0-9a-z]+)(?=:|\s|$)/i.exec(item[4] ?? "")?.[1];
        let checked = item[2]?.toLowerCase() === "x";
        let description = item[4] ?? "";
        if (linked) {
          const child = byPath.get(parseReference(root, linked).path);
          if (!child) throw new Error(`${task.path}: checklist child not found: ${linked}`);
          if (!child.metadata.parent || parseReference(root, child.metadata.parent).path !== task.path)
            throw new Error(`${task.path}: checklist reference is not a child task: ${linked}`);
          checked = terminalTask.has(child.metadata.status ?? "");
          const detail = description
            .slice(linked.length)
            .replace(/^ \((?:Planned|Active|Blocked|Done|Canceled)\)/, "")
            .replace(/^:\s*/, "")
            .trimStart();
          description = `${linked} (${child.metadata.status ?? "Planned"}): ${detail}`;
        }
        if (task.metadata.status === "Done" && !checked)
          throw new Error(`${task.path}: Done task has an unchecked step: ${item[4] ?? ""}`);
        return `${item[1] ?? ""}${checked ? "x" : " "}${item[3] ?? ""}${description}`;
      })
      .join("\n");
    if (contents !== task.contents) replacements.push({ path: task.path, original: task.contents, contents });
  }
  if (checkOnly && replacements.length)
    throw new Error(
      `${replacements.map((entry) => entry.path).join(", ")}: task checkboxes are stale; run 'workbench sync'`,
    );
  for (const task of tasks)
    if (readText(task.path) !== task.contents)
      throw new Error(`${task.path}: task changed during checklist synchronization; retry`);
  for (const replacement of replacements) writeAtomic(replacement.path, replacement.contents);
  return replacements.map((replacement) => replacement.path);
}
