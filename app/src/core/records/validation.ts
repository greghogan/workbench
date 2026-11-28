import { archivedScopeRecords } from "./archive-store.js";
import { projectPaths } from "../projects/project-paths.js";
import { writeDiagnosticText } from "../diagnostics/diagnostics.mjs";
import { validateManagedImageInputs } from "../artifacts/image-input-validation.js";
import { validateCollectionSubmodules } from "../collections/collection-git.js";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readConfig, readLanguageRoots, readProjects } from "../projects/project-configuration.js";
import { rootOf, distributionRoot } from "../projects/project-context.js";
import { type Project } from "../projects/project-model.js";
import { syncMaps } from "./maps.js";
import { syncReleaseIndexes } from "./releases.js";
import { syncAgents } from "./agents.js";
import { skillCatalog } from "../skills/skill-catalog.js";
import { validateRecords, validateRelationships } from "./records.js";
import { readChecks } from "../execution/checks/check-configuration.js";
import { ciMatrix } from "../execution/ci/ci.js";
import { selectedCompiler } from "../toolchains/compilers.js";
import { validateCommitPolicy } from "../git/commit.js";
import { formattingErrors, recordPaths } from "./formatting.js";
import { documentationErrors } from "./documentation.js";
import { citationLibrarySetting } from "../citations/citations.js";
import { syncRecordSequences } from "./record-sequences.js";
import { syncTaskChecklists } from "../tasks/task-checklists.js";
import { decisionScopes } from "./decisions.js";
import { withConfigurationSnapshot } from "../configuration/configuration-snapshot.js";
import { readArtifactCatalog } from "../artifacts/artifact-catalog.js";
import { withRecordObservation } from "./record-observation.js";
import { withRepositoryReads } from "../git/repository-reads.js";

function collectMarkdown(directory: string, files: Set<string>): void {
  if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink() || [".collections", ".local-collections"].includes(entry.name)) continue;
    if (entry.isDirectory()) collectMarkdown(path, files);
    else if (entry.isFile() && path.endsWith(".md")) files.add(path);
  }
}

type ValidationObserver = (phase: {
  name: string;
  started: string;
  durationMs: number;
  status: "passed" | "failed";
}) => void;

/** One validation observes one configuration; subsequent invocations acquire fresh values. */
export function validationReport(
  root: string,
  observe?: ValidationObserver,
): Promise<{ errors: string[]; markdownFiles: number }> {
  return withConfigurationSnapshot(() =>
    withRepositoryReads(() => withRecordObservation(() => inspectValidation(root, observe))),
  );
}

async function inspectValidation(
  root: string,
  observe?: ValidationObserver,
): Promise<{ errors: string[]; markdownFiles: number }> {
  const errors: string[] = [];
  let last = performance.now(),
    started = new Date().toISOString(),
    issues = 0;
  const report = (name: string) => {
    if (!observe) return;
    const now = performance.now();
    observe({ name, started, durationMs: now - last, status: errors.length === issues ? "passed" : "failed" });
    last = now;
    started = new Date().toISOString();
    issues = errors.length;
  };
  const files = new Set<string>();
  let width: number | undefined;
  try {
    width = readConfig(root).markdown?.wrap_width;
  } catch (error) {
    errors.push(String(error));
  }
  for (const action of [
    () => readChecks(root),
    () => {
      if (existsSync(join(root, projectPaths.profiles))) readArtifactCatalog(root);
    },
    () => {
      validateManagedImageInputs(root);
    },
    () => {
      validateCollectionSubmodules(
        root,
        readConfig(root).collections?.sources ?? [],
        process.env.WORKBENCH_EPHEMERAL_CHECKOUT === "1"
          ? (process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? root)
          : undefined,
      );
    },
    () => {
      if (readConfig(root).ci !== undefined) ciMatrix(root);
    },
    () => validateCommitPolicy(root),
    () => citationLibrarySetting(root),
    () => archivedScopeRecords(root),
    () => {
      // Validate declared defaults independently of the shell's active tool profile.
      for (const entry of readLanguageRoots(root)) selectedCompiler(join(root, entry.path), { toolchain: false });
    },
  ]) {
    try {
      action();
    } catch (error) {
      errors.push(String(error));
    }
  }
  report("Validation configuration");
  for (const relative of ["AGENTS.md", projectPaths.config, projectPaths.projects, projectPaths.charter]) {
    const path = join(root, relative);
    if (!existsSync(path) || !lstatSync(path).isFile()) errors.push(`${path}: required file is missing`);
    else if (path.endsWith(".md")) files.add(path);
  }
  const readme = join(root, "README.md");
  if (existsSync(readme)) files.add(readme);
  collectMarkdown(join(root, "workbench"), files);
  collectMarkdown(join(root, "docs"), files);
  let projects: Project[];
  try {
    projects = readProjects(root);
  } catch (error) {
    errors.push(String(error));
    projects = [];
  }
  for (const project of projects) {
    const directory = rootOf(root, project);
    errors.push(...validateRecords(directory, project.id, root));
    if (project.path !== ".") {
      const charter = join(directory, projectPaths.charter);
      if (!existsSync(charter)) errors.push(`${charter}: required file is missing`);
      else files.add(charter);
      collectMarkdown(join(directory, "workbench"), files);
      collectMarkdown(join(directory, "docs"), files);
    }
  }
  if (projects.length) {
    try {
      errors.push(...validateRelationships(root));
    } catch (error) {
      errors.push(String(error));
    }
    report("Validation records and relationships");
    for (const action of [
      () => syncRecordSequences(root, true),
      () => syncTaskChecklists(root, true),
      () => syncMaps(root, true),
      () => syncReleaseIndexes(root, true),
      () => syncAgents(root, true),
      () => skillCatalog(distributionRoot(root)),
    ]) {
      try {
        action();
      } catch (error) {
        errors.push(String(error));
      }
    }
  }
  report("Validation generated files");
  if (width && projects.length) {
    try {
      errors.push(...(await formattingErrors(recordPaths(root), width)));
    } catch (error) {
      errors.push(String(error));
    }
  }
  report("Validation record formatting");
  try {
    for (const scope of decisionScopes(root))
      if (scope.source) {
        files.add(join(scope.recordsDirectory, "decision-map.md"));
        for (const decision of scope.decisions) files.add(decision.path);
      }
    errors.push(...documentationErrors(root, [...files].sort()));
  } catch (error) {
    errors.push(String(error));
  }
  report("Validation documentation");
  return { errors, markdownFiles: files.size };
}
export async function validate(root: string, observe?: ValidationObserver): Promise<void> {
  const { errors, markdownFiles } = await validationReport(root, observe);
  if (errors.length) {
    for (const error of errors) writeDiagnosticText(error);
    throw new Error(`Workbench validation failed (${String(errors.length)} issue(s)).`);
  }
  console.log(`Workbench validation passed (${String(markdownFiles)} Markdown files).`);
}
