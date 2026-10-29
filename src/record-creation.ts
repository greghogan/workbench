import { mkdirSync, rmSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { writeNew } from "../scripts/file-publication.mjs";
import { formatDocument } from "./formatting.js";
import { required } from "./invariants.js";
import { ownedPath } from "./paths.js";
import { readConfig, selectProject } from "./project-configuration.js";
import { rootOf } from "./project-context.js";
import type { Project } from "./project-model.js";
import { relativeRecordPath, type Kind } from "./record-identity.js";
import { reserveRecordNumber } from "./record-sequences.js";
import { parseTask, readTaskGraph, TaskGraph } from "./task-model.js";
import { withTaskLock } from "./task-queue.js";
import { terminalTask } from "./record-document.js";
import { InvalidInput } from "./input-errors.js";

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
  const number = reserveRecordNumber(rootOf(root, project), kind);
  const path = join(rootOf(root, project), "workbench", relativeRecordPath(kind, number));
  const prepared = contents(number, project);
  const formatted = await formatDocument(
    typeof prepared === "string" ? prepared : prepared.record,
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
  console.log(`Created ${project.id}:${kind}-${number} at ${path}.`);
  if (kind === "ADR")
    console.log("Draft created: replace the summary and write the decision; a human reviews this file before commit.");
  if (kind === "ENV")
    console.log(
      "Draft created. Complete ## Hardware configuration and ## Limits; describe configuration profiles where applicable. A human reviews this record and its supporting files before commit.",
    );
  if (kind === "CIT")
    console.log(
      "Draft created. Complete author, issued date or literal, and HTTPS URL in the CSL-JSON, plus at least one source with kind, matching landing-url and status in acquisition.yaml. Use 'workbench citation add IDENTIFIER' to acquire available metadata instead.",
    );
  if (["ADR", "ENV", "CIT"].includes(kind))
    console.log(`Next: workbench validate (draft requirements remain enforced).`);
  return path;
}
