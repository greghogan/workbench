import { Command } from "commander";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectRoot, distributionRoot } from "./core.js";
import { syncMaps } from "./maps.js";
import { syncAgents } from "./agents.js";
import { addRecord, openRecord, startExperiment } from "./records.js";
import { addRelease, syncReleaseIndexes } from "./releases.js";
import { checkLanguages, initLanguage, listLanguages, reportLanguages } from "./languages.js";
import { listChecks, runChecks } from "./checks.js";
import { addProject, configureGitHooks, setupProject } from "./projects.js";
import { addCitation, fetchCitation, importCitation, syncCitations } from "./citations.js";
import { addFeedback, resolveFeedback } from "./feedback.js";
import { checkCommit } from "./commit.js";
import { validate } from "./validation.js";
import { formatMarkdown } from "./markdown.js";
import { readConfig } from "./core.js";
import { syncSkills } from "./skills.js";

const program = new Command();
program.name("workbench").description("Shared agentic software-development context and workflows");
program.addHelpCommand(false);
const root = projectRoot();
program
  .command("setup")
  .description("Configure the root project and Git change gates")
  .action(async () => {
    await setupProject(root);
    sync();
    configureGitHooks(root, distributionRoot(root));
  });
const project = program.command("project").description("Register and inspect project scopes");
project
  .command("add")
  .argument("[id]")
  .argument("[path]")
  .action(async (id?: string, path?: string) => {
    await addProject(root, id, path);
    sync();
  });
project
  .command("languages")
  .argument("[project-id]")
  .action((id?: string) => reportLanguages(root, id));
const language = program.command("language").description("Inspect and verify supported language references");
language.command("list").action(() => listLanguages(root));
language
  .command("init")
  .description("Seed a TypeScript language root without overwriting existing files")
  .argument("<language>")
  .argument("[path]")
  .action((selected: string, path?: string) => {
    initLanguage(root, selected, path);
    sync();
  });
language
  .command("check")
  .argument("[language]")
  .option("--all")
  .action((selected: string | undefined, options: { all?: boolean }) => checkLanguages(root, selected, !!options.all));
const record = program.command("record").description("Create and open project records");
record
  .command("add")
  .argument("<type>")
  .argument("[title]")
  .option("--project <id>")
  .option("--parent <reference>")
  .option("--depends-on <reference>", "Task dependency", collect, [])
  .action(
    (kind: string, title: string | undefined, options: { project?: string; parent?: string; dependsOn: string[] }) => {
      addRecord(root, kind, title, options.project, options.parent, options.dependsOn);
      sync();
    },
  );
record
  .command("open")
  .argument("<reference>")
  .action((reference: string) => openRecord(root, reference));
const citation = program.command("citation").description("Register citation metadata and manage local PDFs");
citation
  .command("add")
  .argument("<identifier>")
  .option("--project <id>")
  .action(async (identifier: string, options: { project?: string }) => {
    await addCitation(root, identifier, options.project);
    sync();
  });
citation
  .command("fetch")
  .argument("<reference>")
  .argument("[source]")
  .action((reference: string, source?: string) => fetchCitation(root, reference, source));
citation
  .command("import")
  .argument("<reference>")
  .argument("<path>")
  .option("--source <kind>")
  .action((reference: string, path: string, options: { source?: string }) =>
    importCitation(root, reference, path, options.source),
  );
citation
  .command("sync")
  .option("--project <id>")
  .action((options: { project?: string }) => syncCitations(root, options.project));
program
  .command("experiment")
  .description("Create experiments from complete protocols")
  .command("start")
  .argument("<title>")
  .argument("<protocol>")
  .option("--project <id>")
  .action((title: string, protocol: string, options: { project?: string }) => {
    startExperiment(root, title, protocol, options.project);
    sync();
  });
program
  .command("release")
  .description("Create release manifests from published artifacts")
  .command("add")
  .argument("<specification>")
  .option("--project <id>")
  .action((specification: string, options: { project?: string }) => {
    addRelease(root, specification, options.project);
    sync();
  });
const feedback = program.command("feedback").description("Capture local process and tooling friction");
feedback
  .command("add")
  .argument("<title>")
  .action((title: string) => {
    addFeedback(title);
  });
feedback
  .command("resolve")
  .argument("<id>")
  .argument("<disposition>")
  .argument("<explanation>")
  .option("--record <reference>", "Resulting record", collect, [])
  .action((id: string, disposition: string, explanation: string, options: { record: string[] }) =>
    resolveFeedback(root, id, disposition, explanation, options.record),
  );
program.command("sync").description("Refresh record maps and root agent context").action(sync);
const format = program.command("format").description("Format supported project documents");
format
  .command("markdown")
  .argument("<path>")
  .option("--write")
  .action((path: string, options: { write?: boolean }) =>
    formatMarkdown(path, readConfig(root).markdown!.wrap_width!, !!options.write),
  );
program
  .command("validate")
  .description("Validate Workbench-owned project structure")
  .argument("[root]", "Project tree", undefined)
  .action((requested?: string) => validate(requested ? resolve(requested) : root));
const checks = program.command("checks").description("Inspect and run configured project checks");
checks.command("list").action(() => listChecks(root));
checks
  .command("run")
  .option("--role <role>")
  .argument("[root]")
  .action((requested: string | undefined, options: { role?: string }) =>
    runChecks(requested ? resolve(requested) : root, options.role),
  );
program
  .command("setup-project", { hidden: true })
  .argument("<root>")
  .action(async (requested: string) => {
    await setupProject(resolve(requested));
    for (const path of syncMaps(resolve(requested))) console.log(`Updated ${path}.`);
    for (const path of syncReleaseIndexes(resolve(requested))) console.log(`Updated ${path}.`);
  });
program
  .command("commit", { hidden: true })
  .command("check")
  .argument("<message>")
  .action((message: string) => checkCommit(root, message));
program
  .command("help")
  .description("Print help for the root or a command path")
  .argument("[path...]")
  .option("--all")
  .action((path: string[], options: { all?: boolean }) => {
    if (options.all) {
      if (path.length) throw new Error("help --all cannot be combined with a command path");
      printAllHelp();
    } else {
      let command = program;
      for (const name of path) {
        const next = command.commands.find((candidate) => candidate.name() === name);
        if (!next || ["setup-project", "commit"].includes(name))
          throw new Error(`unknown command in help path: ${name}`);
        command = next;
      }
      process.stdout.write(command.helpInformation());
    }
  });
function printAllHelp(): void {
  process.stdout.write(`${program.helpInformation()}\n`);
  function visit(command: Command, path: string[]): void {
    for (const child of command.commands) {
      if (["setup-project", "commit"].includes(child.name())) continue;
      const childPath = [...path, child.name()];
      process.stdout.write(`\nCOMMAND: ${childPath.join(" ")}\n\n${child.helpInformation()}\n`);
      visit(child, childPath);
    }
  }
  visit(program, ["workbench"]);
}
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
function sync(): void {
  for (const path of syncMaps(root)) console.log(`Updated ${path}.`);
  for (const path of syncReleaseIndexes(root)) console.log(`Updated ${path}.`);
  if (existsSync(join(root, "workbench/CHARTER.md"))) {
    for (const path of syncAgents(root)) console.log(`Updated ${path} from charter and decisions.`);
  }
  for (const path of syncSkills(root, distributionRoot(root))) console.log(`Updated ${path}.`);
}
if (process.argv.includes("--help-all")) {
  if (process.argv.length !== 3) {
    console.error("workbench: --help-all cannot be combined with a command");
    process.exitCode = 2;
  } else printAllHelp();
} else {
  program.parseAsync(process.argv).catch((error: unknown) => {
    console.error(`workbench: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
