import { projectPaths } from "../core/projects/project-paths.js";
import { Command, Option } from "commander";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { initialCollectionSource } from "../core/collections/initial-collection.js";
import { commitStyles } from "../core/configuration/config-schema.js";
import { configureDirenv } from "../core/execution/environments/direnv.js";
import { readConfig, readProjects } from "../core/projects/project-configuration.js";
import { distributionRoot } from "../core/projects/project-context.js";
import { ProjectHierarchy } from "../core/projects/project-hierarchy.js";
import { catalog, detected } from "../core/toolchains/languages.js";
import { confirmCollectionAcceptance } from "./collection-confirmation.js";
import { collect, registerCommand } from "./commands.js";
import { initializeProject, type InitOptions } from "./initialization.js";
import { initLanguage, listLanguages, reportLanguages } from "./language-output.js";
import { addProject } from "./project-setup.js";
import { prompt } from "./terminal/project-prompt.js";

export function registerSetupCommands(program: Command, root: string, sync: () => void): void {
  registerCommand(program, "init")
    .description("Create or adopt a project with records and any supported language")
    .argument("[path]", "Project directory", ".")
    .option("--id <id>", "Project namespace (default: directory name)")
    .option("--name <name>", "Human-readable project name, including capitalization")
    .option("--language <id>", "Language starter, or existing language with --adopt")
    .option("--root <path>", "Language directory inside the project", ".")
    .option("--adopt", "Preserve application files and connect project-owned checks")
    .option("--direnv", "Create or compose direnv hooks for registered build roots")
    .option("--records-only", "Explicitly select structural validation without application commands")
    .option("--workbench-collection", "Adopt the initial Workbench ADR collection, including in an initialized project")
    .option(
      "--no-workbench-collection",
      "Skip initial Workbench ADR adoption; existing collection selections are preserved",
    )
    .option("-y, --yes", "Accept all initial Workbench ADRs and use default answers")
    .option("--hooks", "Install Workbench Git gates; existing custom hooks require explicit composition")
    .addOption(
      new Option("--commit-style <style>", "Choose commit-message rules explicitly").choices([...commitStyles]),
    )
    .option("--check <command>", "Existing shell check to run; repeat for multiple checks", collect, [])
    .option("--plan", "Preview files, hooks and commit rules without changing the project")
    .action(async (path: string, options: InitOptions & { direnv?: boolean }) => {
      if (!options.adopt && !options.recordsOnly) {
        const existing = detected(resolve(path), options.root ?? ".");
        if (
          existsSync(join(resolve(path), projectPaths.projects)) ||
          existing.some(([language]) => !options.language || options.language === language)
        )
          options.adopt = true;
      }
      if (!options.language && !options.adopt && !options.recordsOnly && !options.yes && process.stdin.isTTY) {
        console.log("Choose a language to create a starter application:");
        for (const language of catalog(root).filter((item) => item.starter))
          console.log(`${language.id.padEnd(12)}${language.name}`);
        console.log("later   Decide on languages later; create Workbench documents only (default).");
        const selected = (await prompt("Project setup (Enter to decide later)")).toLowerCase();
        if (!selected || selected === "later" || selected === "records") options.recordsOnly = true;
        else options.language = selected;
      }
      if (!options.language && !options.adopt && !options.recordsOnly) options.recordsOnly = true;
      const target = resolve(path);
      if (
        !options.plan &&
        !options.yes &&
        (options.workbenchCollection ?? !existsSync(join(target, projectPaths.projects))) &&
        (!existsSync(join(target, projectPaths.config)) ||
          !readConfig(target).collections?.sources?.some((pin) => pin.id === "workbench"))
      ) {
        const initial = initialCollectionSource(distributionRoot(target));
        options.yes = await confirmCollectionAcceptance(`Workbench at ${initial.commit}`);
      }
      await initializeProject(resolve(path), options);
      if (options.direnv && !options.plan) configureDirenv(resolve(path));
    });
  const project = registerCommand(program, "subproject")
    .description("List registered project scopes")
    .option("--json", "Print project IDs and paths as JSON")
    .action((options: { json?: boolean }) => {
      const projects = readProjects(root);
      const hierarchy = new ProjectHierarchy(projects);
      if (options.json) console.log(JSON.stringify(projects, null, 2));
      else
        for (const entry of projects)
          console.log(`${hierarchy.breadcrumb(entry)}${entry.name ? ` (${entry.id})` : ""}: ${entry.path}`);
    });
  project
    .command("add")
    .description("Register a subproject; prompt when ID and path are omitted")
    .option("--name <name>", "Human-readable subproject name, including capitalization")
    .argument("[id]", "Unique project ID")
    .argument("[path]", "Directory relative to the repository root")
    .action(async (id: string | undefined, path: string | undefined, options: { name?: string }) => {
      await addProject(root, id, path, options.name);
      sync();
    });
  const language = registerCommand(program, "language")
    .description("List supported languages and executable references")
    .action(() => {
      listLanguages(root);
    });
  language
    .command("roots")
    .description("Show configured language roots and detected manifests by project")
    .option("--project <id>", "Limit to a registered project scope")
    .action((options: { project?: string }) => {
      reportLanguages(root, options.project);
    });
  language
    .command("init")
    .description("Seed a language root and configure checks without overwriting files")
    .argument("<language>", "Any bundled language, or a selected local definition with a starter")
    .argument("[path]", "Existing directory relative to the repository root", ".")
    .action((selected: string, path: string) => {
      initLanguage(root, selected, path);
      sync();
    });
}
