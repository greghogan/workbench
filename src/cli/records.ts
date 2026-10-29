import { registerCommand } from "./commands.js";
import { Argument, Command } from "commander";
import { readFileSync } from "node:fs";
import { currentProject } from "../project-configuration.js";
import { type Kind } from "../record-identity.js";
import { addRecord, startExperiment } from "../records.js";
import { addCitation, fetchCitation, importCitation, listCitationStatus, syncCitations } from "../citations.js";
import { addRelease } from "../releases.js";
import { resolveRecordReference } from "../record-resolver.js";

const recordNames = {
  task: "TSK",
  decision: "ADR",
  experiment: "EXP",
  environment: "ENV",
  citation: "CIT",
  release: "REL",
} as const;

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

export function registerRecordCommands(program: Command, root: string, sync: () => void): void {
  const records = registerCommand(program, "record").description(
    "Create records with allocated IDs and canonical metadata",
  );
  records
    .command("add")
    .addArgument(new Argument("<type>", "Record type").choices(Object.keys(recordNames)))
    .argument("<title-or-specification>", "Title, or a YAML specification for a release")
    .option("--project <id>", "Project scope (default: scope containing the current directory)")
    .option("--from <path>", "Task body from a Markdown file; use - for stdin")
    .option("--parent <reference>", "Parent task ID or scoped reference (for example TSK-0 or project:TSK-0)")
    .option(
      "--depends-on <reference>",
      "Task dependency; repeat for multiple dependencies",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--protocol <path>", "Complete experiment protocol")
    .action(
      async (
        type: keyof typeof recordNames,
        title: string,
        options: { project?: string; from?: string; parent?: string; dependsOn: string[]; protocol?: string },
      ) => {
        const kind = recordNames[type];
        if (kind !== "TSK" && (options.from !== undefined || options.parent !== undefined || options.dependsOn.length))
          throw new Error("--from, --parent, and --depends-on apply only to tasks");
        if (kind !== "EXP" && options.protocol !== undefined) throw new Error("--protocol applies only to experiments");
        const project = currentProject(root, options.project);
        if (kind === "EXP") {
          if (!options.protocol)
            throw new Error(
              "experiment creation requires --protocol PATH. Write the protocol with Hypothesis, Candidate and baseline, Independent variable, Controls and correctness, Workload, and Evaluation rule sections; see docs/records.md for a complete example.",
            );
          await startExperiment(root, title, options.protocol, project);
        } else if (kind === "REL") await addRelease(root, title, project);
        else {
          if (options.from === "-" && process.stdin.isTTY) throw new Error("--from - requires piped stdin");
          const body =
            options.from === undefined ? undefined : readFileSync(options.from === "-" ? 0 : options.from, "utf8");
          await addRecord(
            root,
            kind,
            title,
            project,
            options.parent
              ? reference(root, "TSK", options.parent, options.parent.includes(":") ? undefined : project)
              : undefined,
            options.dependsOn.map((value) => reference(root, "TSK", value, value.includes(":") ? undefined : project)),
            body,
          );
        }
        sync();
      },
    );
  registerCommand(program, "release").description("Inspect release profiles and prepare verified artifacts");
  const group = registerCommand(program, "citation")
    .description("Show local citation status or acquire metadata and source documents")
    .option("--project <id>", "Limit status to one project scope")
    .option("--source <kind>", "Limit status to a source kind declared by the citations")
    .option("--missing", "Show only sources whose PDF is absent locally")
    .option("--json", "Print structured source status and absolute document paths")
    .action((options: { project?: string; source?: string; missing?: boolean; json?: boolean }) => {
      listCitationStatus(root, options);
    });
  {
    scope(group.command("add").description("Retrieve metadata for an arXiv ID or DOI and create a citation"))
      .argument("<identifier>", "arXiv ID, DOI, or canonical URL")
      .action(async (identifier: string, options: { project?: string }) => {
        await addCitation(root, identifier, currentProject(root, options.project));
        sync();
      });
    group
      .command("fetch")
      .description("Verify existing PDFs and acquire missing sources; all citations by default")
      .argument("[id]", "Citation ID or scoped reference (default: all citations)")
      .option("--project <id>", "Scope an unqualified ID or limit bulk acquisition to this scope")
      .option("--source <kind>", "Select a source kind for one citation or filter bulk acquisition")
      .action(async (id: string | undefined, options: { project?: string; source?: string }) => {
        if (id === undefined) {
          await syncCitations(root, options.project, options.source);
        } else await fetchCitation(root, reference(root, "CIT", id, options.project), options.source);
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
