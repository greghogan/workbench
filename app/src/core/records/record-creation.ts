import { mkdirSync, rmSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { writeNew } from "../runtime/file-publication.mjs";
import { formatDocument } from "./formatting.js";
import { required } from "../runtime/invariants.js";
import { ownedPath } from "../runtime/paths.js";
import { readConfig, selectProject } from "../projects/project-configuration.js";
import { rootOf } from "../projects/project-context.js";
import type { Project } from "../projects/project-model.js";
import { relativeRecordPath, type Kind } from "./record-identity.js";
import { reserveRecordNumber } from "./record-sequences.js";
import { parseTask, readTaskGraph, TaskGraph } from "../tasks/task-model.js";
import { withTaskLock } from "../tasks/task-queue.js";
import { terminalTask, editRecordMetadata, parseProseRecord } from "./record-document.js";
import { InvalidInput } from "../runtime/input-errors.js";

export async function createRecord(
  root: string,
  kind: Kind,
  projectId: string | undefined,
  contents: (
    number: string,
    project: Project,
  ) => string | { record: string; supporting: Record<string, string | Uint8Array> },
): Promise<string> {
  const project = selectProject(root, projectId);
  const number = reserveRecordNumber(rootOf(root, project), kind, root);
  const path = join(rootOf(root, project), "workbench", relativeRecordPath(kind, number));
  const prepared = contents(number, project);
  const document = typeof prepared === "string" ? prepared : prepared.record;
  const formatted = await formatDocument(
    kind === "TSK" && parseProseRecord(document, path).metadata.added_at === undefined
      ? editRecordMetadata(document, { added_at: new Date().toISOString() })
      : document,
    path,
    required(
      required(readConfig(root).markdown, "expected readConfig(root).markdown").wrap_width,
      "expected readConfig(root).markdown!.wrap_width",
    ),
  );
  const supporting = path.slice(0, -extname(path).length);
  let ownsSupporting = false;
  const publish = () => {
    if (kind === "TSK") {
      const proposed = parseTask(root, `${project.id}:TSK-${number}`, path, formatted),
        graph = readTaskGraph(root);
      new TaskGraph([...graph.tasks, proposed]).validate();
      if (proposed.parent && terminalTask.has(graph.require(proposed.parent).metadata.status))
        throw new InvalidInput(`Reopen parent ${proposed.parent} before adding a child task`);
    }
    try {
      if (typeof prepared !== "string") {
        mkdirSync(dirname(path), { recursive: true });
        mkdirSync(supporting);
        ownsSupporting = true;
        for (const [name, bytes] of Object.entries(prepared.supporting)) writeNew(ownedPath(supporting, name), bytes);
      }
      writeNew(path, formatted);
    } catch (error) {
      if (ownsSupporting) rmSync(supporting, { recursive: true, force: true });
      throw error;
    }
  };
  if (kind === "TSK") withTaskLock(root, publish);
  else publish();
  return path;
}
