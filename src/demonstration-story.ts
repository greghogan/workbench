import { changeTaskQueue } from "./task-queue.js";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { synchronize } from "./sync.js";
import { registerConsumingProject } from "./project-registration.js";
import { citationPdf } from "../scripts/web-browser-fixtures.mjs";

/** Seed the fictional demonstration consumer using the same services as ordinary projects. */
export async function seedDemonstration(
  root: string,
  directory: string,
  source: string,
  repositoryGit: (repository: string, ...args: string[]) => string,
) {
  const git = (...args: string[]) => repositoryGit(root, ...args);
  const pdf = citationPdf();
  mkdirSync(join(root, "library/citations"), { recursive: true });
  writeFileSync(join(root, "library/citations/CIT-00-published.pdf"), pdf);
  writeFileSync(
    join(root, "workbench/citations/CIT-00/acquisition.yaml"),
    `sources:\n  - kind: published\n    status: acquired\n    landing-url: https://example.invalid/paper\n    sha256: ${createHash("sha256").update(pdf).digest("hex")}\n`,
  );
  git("init", "--quiet");
  await registerConsumingProject(root);
  synchronize(root);
  git("add", ".");
  git("commit", "--quiet", "-m", "Demonstration baseline");
  changeTaskQueue(root, {
    action: "add",
    references: ["demo:TSK-2", "demo:TSK-5", "demo:TSK-6", "demo:TSK-B", "demo:TSK-7"],
  });
  changeTaskQueue(root, {
    action: "block",
    reference: "demo:TSK-2",
    detail: "Awaiting a representative reader session.",
  });
  changeTaskQueue(root, { action: "start", reference: "demo:TSK-7" });
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
  cpSync(join(root, "workbench/CHARTER.md"), join(provider, "workbench/CHARTER.md"));
  cpSync(join(root, "workbench/config.toml"), join(provider, "workbench/config.toml"));
  writeFileSync(join(provider, "workbench/projects.toml"), '[[project]]\nid="patterns"\npath="."\n');
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
