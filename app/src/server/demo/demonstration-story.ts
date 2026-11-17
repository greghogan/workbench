import { projectPaths } from "../../core/projects/project-paths.js";
import { changeTaskQueue } from "../../core/tasks/task-queue.js";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { synchronize } from "../../core/records/sync.js";
import { registerConsumingProject } from "../../core/projects/project-registration.js";
import { citationPdf } from "../../core/verification/document-fixtures.mjs";
import { planIdentity } from "../../core/tasks/planning/plan-model.js";
import { checkpointPlans, configurePlanning, savePlanDraft } from "../../core/tasks/planning/planning-operations.js";
import { changeTaskStatus } from "../../core/tasks/task-service.js";
import { appendTaskAccount } from "../../core/tasks/task-plan.js";
import { provisionalTrailer } from "../../core/git/commit-history.js";
import { formatDocument } from "../../core/records/formatting.js";
import { readConfig } from "../../core/projects/project-configuration.js";

/** Seed the fictional demonstration consumer using the same services as ordinary projects. */
export async function seedDemonstration(
  root: string,
  directory: string,
  source: string,
  repositoryGit: (repository: string, ...args: string[]) => string,
) {
  const git = (...args: string[]) => repositoryGit(root, ...args);
  const width = readConfig(root).markdown?.wrap_width ?? 120;
  const writeRecord = async (path: string, contents: string) => {
    writeFileSync(path, await formatDocument(contents, path, width));
  };
  const pdf = citationPdf();
  mkdirSync(join(root, "library/citations"), { recursive: true });
  writeFileSync(join(root, "library/citations/CIT-00-published.pdf"), pdf);
  writeFileSync(
    join(root, "workbench/citations/CIT-00/acquisition.yaml"),
    `sources:\n  - kind: published\n    status: acquired\n    landing-url: https://example.invalid/paper\n    sha256: ${createHash("sha256").update(pdf).digest("hex")}\n`,
  );
  git("init", "--quiet");
  git("config", "user.name", "Workbench demonstration");
  git("config", "user.email", "demo@example.invalid");
  await registerConsumingProject(root);
  synchronize(root);
  git("add", ".");
  git("commit", "--quiet", "-m", "Demonstration baseline");
  configurePlanning(root, { branch: "workbench/plans", auto_prune: true });
  const named = planIdentity("demo", "bookmark-notes");
  savePlanDraft(root, named, readFileSync(join(source, "plans/bookmark-notes.md"), "utf8"));
  checkpointPlans(root, [named]);
  changeTaskQueue(root, {
    action: "add",
    references: ["demo:TSK-2", "demo:TSK-5", "demo:TSK-6", "demo:TSK-B", "demo:TSK-7"],
  });
  changeTaskStatus(root, "demo:TSK-2", "Approved", undefined, true);
  changeTaskQueue(root, { action: "start", reference: "demo:TSK-2" });
  changeTaskQueue(root, {
    action: "block",
    reference: "demo:TSK-2",
    detail: "Awaiting a representative reader session.",
  });
  const assessment = join(root, "workbench/tasks/TSK-02.md");
  await writeRecord(
    assessment,
    readFileSync(assessment, "utf8") +
      "\n## Decisions before approval\n\nInclude a screen reader session and a keyboard-only session before comparing the preview designs. Confirm the expanded session scope before resuming.\n",
  );
  changeTaskQueue(root, { action: "start", reference: "demo:TSK-7" });
  const preview = "workbench/decisions/ADR-01.md",
    focus = "workbench/tasks/TSK-07.md";
  await writeRecord(
    join(root, preview),
    readFileSync(join(root, preview), "utf8").replace(
      "continue reading.",
      "resume at the same link and reading position after dismissal.",
    ),
  );
  await writeRecord(
    join(root, focus),
    appendTaskAccount(
      readFileSync(join(root, focus), "utf8"),
      "Preview dismissal restores the original link and reading position. The offline search decision records the behavior.",
    ),
  );
  git("add", preview, focus);
  git("commit", "--quiet", "-m", "Restore reading context after previews", "-m", `${provisionalTrailer}: true`);
  changeTaskQueue(root, {
    action: "implemented",
    reference: "demo:TSK-7",
    detail:
      "Illustrative verification: keyboard focus, text selection, and reading position were checked in the fictional scenario. Awaiting developer acceptance; no real application tests are claimed.",
  });
  changeTaskQueue(root, { action: "start", reference: "demo:TSK-5" });
  const provider = join(directory, "collection");
  mkdirSync(join(provider, "workbench/decisions"), { recursive: true });
  cpSync(join(source, "collection/workbench/decisions/ADR-00.md"), join(provider, "workbench/decisions/ADR-00.md"));
  cpSync(join(root, projectPaths.charter), join(provider, projectPaths.charter));
  cpSync(join(root, projectPaths.config), join(provider, projectPaths.config));
  writeFileSync(join(provider, projectPaths.projects), '[[project]]\nid="patterns"\npath="."\n');
  synchronize(provider);
  const providerGit = (...args: string[]) => repositoryGit(provider, ...args);
  providerGit("init", "--quiet");
  providerGit("add", ".");
  providerGit("commit", "--quiet", "-m", "Bundled demonstration collection");

  const collectionDefaults = { source: provider, commit: providerGit("rev-parse", "HEAD") };

  const adr = join(root, "workbench/decisions/ADR-00.md"),
    baseline = readFileSync(adr, "utf8");
  writeFileSync(adr, baseline.replace("Keep decisions connected", "Keep clear decisions connected"));
  writeFileSync(
    join(root, "workbench/experiments/EXP-00/observation.txt"),
    "Add an edited-note query and a missing-index recovery case to the protocol checklist. No real measurements were collected.\n",
  );
  git("add", "workbench/experiments/EXP-00/observation.txt");
  const experiment = join(root, "workbench/experiments/EXP-01.md");
  writeFileSync(
    experiment,
    readFileSync(experiment, "utf8") + "\nInclude a text-selection check in every reading scenario.\n",
  );
  writeFileSync(
    join(root, "workbench/experiments/EXP-01/session-notes.txt"),
    "Proposed checklist: follow and dismiss a preview, copy an excerpt, and restore the reading position. No session has been conducted.\n",
  );
  return collectionDefaults;
}
