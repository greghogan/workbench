import { relative } from "node:path";
import { parseDocument } from "yaml";
import { recordDocument, splitFrontmatter, experimentStatuses, type ExperimentStatus } from "./record-document.js";
import { parseReference } from "./record-files.js";
import { selectProject } from "./project-configuration.js";
import { readBoundedFile } from "./file-reads.js";
import { taskDigest } from "./task-model.js";
import { ProjectEdits } from "./project-edits.js";
import { withTaskLock, readTaskQueue, publishTaskTransition } from "./task-queue.js";
import { InvalidInput, StateConflict } from "./input-errors.js";
import { section, requiredExperimentProtocol } from "./records.js";

export const experimentResults = ["Accepted", "Rejected", "Inconclusive"] as const;
export type ExperimentResult = (typeof experimentResults)[number];
const evidenceSections = ["Execution provenance", "Evidence", "Decision"] as const;

export function experimentReference(root: string, value: string, project?: string): string {
  const scoped = value.includes(":")
    ? value
    : `${selectProject(root, project).id}:${value.includes("-") ? value : `EXP-${value}`}`;
  const parsed = parseReference(root, scoped);
  if (parsed.kind !== "EXP") throw new InvalidInput("Expected an experiment reference");
  if (project && selectProject(root, project).id !== parsed.project.id)
    throw new InvalidInput(`Experiment ${value} conflicts with --project ${project}`);
  return `${parsed.project.id}:EXP-${parsed.number}`;
}
export function readExperiment(root: string, value: string, project?: string) {
  const reference = experimentReference(root, value, project),
    parsed = parseReference(root, reference);
  const contents = readBoundedFile(parsed.path, 2 * 1024 * 1024, "experiment record").toString("utf8");
  return {
    reference,
    path: parsed.path,
    contents,
    digest: taskDigest(contents),
    ...recordDocument("EXP", contents, parsed.path),
  };
}
export function experimentIsResult(status: string): status is ExperimentResult {
  return experimentResults.some((result) => result === status);
}

/** Execution can iterate freely; completed records and supporting evidence receive ordinary exact-file review. */
export function changeExperimentStatus(root: string, value: string, status: ExperimentStatus, expected?: string): void {
  withTaskLock(root, () => {
    if (!experimentStatuses.includes(status)) throw new InvalidInput("Unknown experiment transition");
    const experiment = readExperiment(root, value);
    if (expected !== undefined && expected !== experiment.digest)
      throw new StateConflict("Experiment changed; refresh its current contents");
    if (experimentIsResult(status) && experiment.metadata.status !== "Running")
      throw new StateConflict("Start the experiment before recording its conclusion");
    if (status !== "Planned")
      for (const heading of requiredExperimentProtocol)
        if (!section(experiment.body, heading)) throw new InvalidInput(`Experiment protocol requires ## ${heading}`);
    if (experimentIsResult(status))
      for (const heading of evidenceSections)
        if (!section(experiment.body, heading)) throw new InvalidInput(`Completed experiment requires ## ${heading}`);
    const parts = splitFrontmatter(experiment.contents);
    if (!parts) throw new InvalidInput("Experiment frontmatter is missing");
    const header = parseDocument(parts.yaml);
    header.set("status", status);
    const ending = experiment.contents.includes("\r\n") ? "\r\n" : "\n";
    const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(experiment.contents);
    if (!match) throw new InvalidInput("Experiment frontmatter is incomplete");
    const contents = `---${ending}${header.toString().replaceAll("\n", ending)}---${ending}${experiment.contents.slice(match[0].length)}`;
    const edits = new ProjectEdits(root);
    const path = relative(root, experiment.path).replaceAll("\\", "/");
    edits.write(path, contents);
    if (edits.files.get(path)?.previous?.toString("utf8") !== experiment.contents)
      throw new StateConflict("Experiment changed during its transition");
    // Reuse durable workflow publication so record changes and derived maps recover together, without task decisions.
    const queue = readTaskQueue(root);
    publishTaskTransition(root, edits, queue, queue);
  });
}
