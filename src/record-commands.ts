import { required } from "./invariants.js";
import { Command } from "commander";
import { QueryCommand } from "./query-command.js";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { readProjects, rootOf, selectProject, type Kind } from "./core.js";
import { addRecord, openRecord, queryRecords, startExperiment, type RecordQuery } from "./records.js";
import { addCitation, fetchCitation, importCitation, syncCitations } from "./citations.js";
import { addRelease } from "./releases.js";
import { resolveRecordReference } from "./record-resolver.js";

const recordNames = {
  task: "TSK",
  decision: "ADR",
  experiment: "EXP",
  environment: "ENV",
  citation: "CIT",
  release: "REL",
} as const;

function currentProject(root: string, id?: string): string {
  if (id) return selectProject(root, id).id;
  const candidates = readProjects(root).filter((project) => {
    const path = relative(rootOf(root, project), process.cwd());
    return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  });
  return candidates.sort((a, b) => b.path.length - a.path.length)[0]?.id ?? selectProject(root).id;
}

function reference(root: string, kind: Kind, value: string, project?: string): string {
  const owner = kind === "ADR" && project ? project : currentProject(root, project);
  const scoped = value.includes(":") ? value : `${owner}:${value.includes("-") ? value : `${kind}-${value}`}`;
  const parsed = resolveRecordReference(root, scoped);
  if (parsed.kind !== kind) throw new Error(`expected a ${kind} record, received ${value}`);
  if (project && project.toLowerCase() !== parsed.project.id)
    throw new Error(`record ${value} conflicts with --project ${project}`);
  return `${parsed.project.id}:${kind}-${parsed.number}`;
}

function scope(command: Command): Command {
  return command.option("--project <id>", "Project scope (default: scope containing the current directory)");
}

function browsing(command: Command, kind?: Kind): Command {
  command
    .option("--project <id>", "Limit to one project (default: all registered scopes)")
    .option("--json", "Print structured results")
    .option("--matches", "Include matching lines in text output");
  if (kind === "TSK" || !kind) command.option("--all", "Include done and canceled tasks");
  if (kind === "TSK" || kind === "EXP" || !kind)
    command.option(
      "--status <status>",
      kind === "TSK"
        ? "Planned, Active, Blocked, Done, or Canceled"
        : kind === "EXP"
          ? "Running, Accepted, Rejected, or Inconclusive"
          : "Task or experiment status, including finished tasks",
    );
  return command;
}

export function registerRecordCommands(program: Command, root: string, sync: () => void): void {
  browsing(program.command("search").description("Search all record types and scopes; hide finished tasks"))
    .argument("<query...>", "Literal text to find (case-insensitive)")
    .option("--type <type>", "Limit to task, decision, experiment, environment, citation, release, or a type code")
    .action((words: string[], options: RecordQuery) => {
      const type = options.type
        ? Object.hasOwn(recordNames, options.type.toLowerCase())
          ? recordNames[options.type.toLowerCase() as keyof typeof recordNames]
          : options.type
        : undefined;
      queryRecords(root, { ...options, ...(type ? { type } : {}) }, words.join(" "));
    });
  for (const [name, kind] of Object.entries(recordNames)) {
    const exampleQuery = { TSK: "parser", ADR: "maps", EXP: "latency", ENV: "server", CIT: "attention", REL: "0.1.0" }[
      kind
    ];
    const label = kind === "TSK" ? "open tasks" : kind === "ENV" ? "hardware environment records" : `${name} records`;
    const group = new QueryCommand(name).copyInheritedSettings(program).description(`List or search ${label}`);
    program.addCommand(group);
    browsing(group, kind)
      .argument("[query...]", "Literal text to find; omit to list records")
      .action((words: string[], options: RecordQuery) => {
        queryRecords(root, { ...options, type: kind }, group.query(words));
      })
      .addHelpText(
        "after",
        `\nExamples:\n  workbench ${name}\n  workbench ${name} ${exampleQuery}\n  workbench ${name} -- add\n  workbench ${name} show 0\n\nSearch is case-insensitive across full record text. After '--', all arguments are literal search text. Put options before '--'.`,
      );
    scope(group.command("show").description("Print one record's path and full contents"))
      .argument("<id>", `ID, ${kind}-ID, or PROJECT:${kind}-ID`)
      .option("--json", "Print reference, title, path, and contents as JSON")
      .action((id: string, options: { project?: string; json?: boolean }) => {
        openRecord(root, reference(root, kind, id, options.project), !!options.json);
      });
    if (["ADR", "TSK", "ENV", "CIT"].includes(kind)) {
      const add = scope(
        group
          .command(kind === "CIT" ? "draft" : "add")
          .description(
            kind === "CIT" ? "Create a manual citation draft" : `Create ${kind === "ENV" ? "an" : "a"} ${name} record`,
          ),
      ).argument("<title>", "Record title (quote titles containing spaces)");
      if (kind === "TSK")
        add
          .option("--from <path>", "Task body from a Markdown file; use - for stdin")
          .option("--parent <reference>", "Parent task's scoped reference")
          .option(
            "--depends-on <reference>",
            "Dependency's scoped reference; repeat for multiple tasks",
            (value: string, previous: string[]) => [...previous, value],
            [],
          );
      add.action(
        async (title: string, options: { project?: string; parent?: string; dependsOn?: string[]; from?: string }) => {
          if (options.from === "-" && process.stdin.isTTY) throw new Error("--from - requires piped stdin");
          const body =
            options.from === undefined ? undefined : readFileSync(options.from === "-" ? 0 : options.from, "utf8");
          await addRecord(
            root,
            kind,
            title,
            currentProject(root, options.project),
            options.parent,
            options.dependsOn,
            body,
          );
          sync();
        },
      );
    }
    if (kind === "EXP")
      scope(group.command("add").description("Create a record from a complete protocol; does not execute it"))
        .argument("<title>", "Experiment title")
        .requiredOption("--protocol <path>", "File containing the complete experiment protocol")
        .action(async (title: string, options: { project?: string; protocol: string }) => {
          await startExperiment(root, title, options.protocol, currentProject(root, options.project));
          sync();
        });
    if (kind === "REL")
      scope(group.command("add").description("Create a release record and hash its published artifacts"))
        .argument("<specification>", "Release YAML specification path")
        .action(async (path: string, options: { project?: string }) => {
          await addRelease(root, path, currentProject(root, options.project));
          sync();
        });
    if (kind === "CIT") {
      scope(group.command("add").description("Retrieve metadata for an arXiv ID or DOI and create a citation"))
        .argument("<identifier>", "arXiv ID, DOI, or canonical URL")
        .action(async (identifier: string, options: { project?: string }) => {
          await addCitation(root, identifier, currentProject(root, options.project));
          sync();
        });
      group
        .command("fetch")
        .description("Fetch a PDF, or verify and acquire all citation sources")
        .argument("[id]", "Citation ID or scoped reference; omit with --all")
        .option("--project <id>", "Scope for an ID; limit --all to this scope (default: all scopes)")
        .option("--source <kind>", "Source kind for a single citation")
        .option("--all", "Verify existing PDFs and acquire missing sources for all citations")
        .action(async (id: string | undefined, options: { project?: string; source?: string; all?: boolean }) => {
          if (!!id === !!options.all) throw new Error("supply one citation ID or --all");
          if (options.all) {
            if (options.source) throw new Error("--source requires a single citation ID");
            await syncCitations(root, options.project);
          } else
            await fetchCitation(
              root,
              reference(root, "CIT", required(id, "expected id"), options.project),
              options.source,
            );
        });
      scope(
        group
          .command("import")
          .description("Copy a manually acquired PDF into the citation library and record its digest"),
      )
        .argument("<id>", "Citation ID or scoped reference")
        .argument("<path>", "Local PDF path")
        .option("--source <kind>", "Source kind when the citation has multiple sources")
        .action((id: string, path: string, options: { project?: string; source?: string }) =>
          importCitation(root, reference(root, "CIT", id, options.project), path, options.source),
        );
    }
  }
}
