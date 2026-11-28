import { safeText } from "../core/diagnostics/diagnostic-text.mjs";
import { writeDiagnosticText } from "../core/diagnostics/diagnostics.mjs";
import { listCitationStatus } from "./citation-output.js";
import { Argument, Command } from "commander";
import { readFileSync } from "node:fs";
import { readBoundedFile } from "../core/runtime/file-reads.js";
import { addCitation, fetchCitation, importCitation, syncCitations } from "../core/citations/citations.js";
import { currentProject } from "../core/projects/project-configuration.js";
import { type Kind } from "../core/records/record-identity.js";
import { resolveRecordReference } from "../core/records/record-resolver.js";
import { addRecord, createExperiment } from "../core/records/records.js";
import { addRelease } from "../core/records/releases.js";
import { registerCommand } from "./commands.js";
import { reportCreatedRecord } from "./record-output.js";
import { InvalidInput } from "../core/runtime/input-errors.js";
import { terminalTable } from "../core/diagnostics/terminal-table.js";
import { registerArchiveCommands } from "./record-archive.js";

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

export function registerRecordCommands(
  program: Command,
  root: string,
  sync: (report?: (message: string) => void) => void,
): void {
  const records = registerCommand(program, "record").description(
    "Create records with allocated IDs and canonical metadata",
  );
  registerArchiveCommands(records, root);
  records
    .command("search")
    .description("Search record metadata and full text, including archived history")
    .argument("<query>", "Case-insensitive text")
    .option("--project <id>", "Limit results to one project or collection scope")
    .option("--type <code>", "Record type, such as TSK or EXP")
    .option("--json", "Print matching record metadata as JSON")
    .action(async (query: string, options: { project?: string; type?: string; json?: boolean }) => {
      const { workspaceRecords, recordBytes } = await import("../core/records/record-service.js");
      const source = workspaceRecords(root),
        { readPlanningRecords, planningBrowserRecord } = await import("../core/tasks/planning/planning-read-model.js"),
        { taskRepositoryDirectory } = await import("../core/tasks/task-project-state.js"),
        plans = new Map(
          (taskRepositoryDirectory(root) ? readPlanningRecords(root) : [])
            .filter((plan) => !plan.implementation || !source.some((record) => record.id === plan.implementation?.task))
            .map((plan) => [plan.reference, plan]),
        ),
        records = [
          ...source,
          ...[...plans.values()].map((plan) =>
            planningBrowserRecord(
              root,
              plan,
              plan.status === "Approved" && !plan.approval?.current ? "Planned" : plan.status,
            ),
          ),
        ],
        type = options.type?.toUpperCase(),
        scope = options.project?.toLowerCase();
      if (scope && !records.some((record) => record.scope === scope))
        throw new InvalidInput(`Unknown record scope: ${scope}`);
      if (type && ![...Object.values(recordNames), "CHARTER"].includes(type))
        throw new InvalidInput(`Unknown record type: ${type}`);
      const normalized = query.toLowerCase();
      const found = records
        .filter((record) => (!scope || record.scope === scope) && (!type || record.type === type))
        .filter((record) =>
          [
            record.id,
            record.title,
            record.summary,
            record.status,
            plans.get(record.id)?.contents ?? recordBytes(record).toString(),
          ]
            .join("\n")
            .toLowerCase()
            .includes(normalized),
        )
        .map((record) => ({
          reference: record.id,
          title: record.title,
          status: record.status,
          archived: !!record.archive,
          ...(plans.has(record.id) ? { planning: true } : {}),
        }));
      console.log(
        options.json
          ? JSON.stringify(found, null, 2)
          : terminalTable(
              ["RECORD", "TITLE", "STATUS", "STORAGE"],
              found.map((record) => [
                record.reference,
                record.title,
                record.status,
                record.planning ? "Planning" : record.archived ? "Archive" : "Live",
              ]),
            ),
      );
    });
  records
    .command("show")
    .description("Read a live, adopted, or archived record")
    .argument("<reference>", "Scoped record reference, or a short reference in the current scope")
    .option("--project <id>", "Scope for a short record reference")
    .option("--json", "Print the resolved reference and contents as JSON")
    .action(async (value: string, options: { project?: string; json?: boolean }) => {
      const scoped = value.includes(":") ? value : `${currentProject(root, options.project)}:${value}`;
      if (scoped.includes(":plan/")) {
        const { parsePlanReference } = await import("../core/tasks/planning/plan-model.js"),
          { readPlan } = await import("../core/tasks/planning/planning-store.js"),
          identity = parsePlanReference(scoped);
        if (options.project && identity.scope !== options.project.toLowerCase())
          throw new InvalidInput("Plan conflicts with --project");
        const plan = readPlan(root, identity);
        if (options.json) console.log(JSON.stringify({ reference: plan.reference, contents: plan.contents }, null, 2));
        else process.stdout.write(process.stdout.isTTY ? safeText(plan.contents) : plan.contents);
        return;
      }
      const selected = resolveRecordReference(root, scoped);
      if (options.project && selected.project.id !== options.project.toLowerCase())
        throw new Error(`record ${value} conflicts with --project ${options.project}`);
      const contents = selected.contents ?? readBoundedFile(selected.path, 2 * 1024 * 1024, "record").toString();
      if (options.json)
        console.log(
          JSON.stringify(
            { reference: `${selected.project.id}:${selected.kind}-${selected.number}`, contents },
            null,
            2,
          ),
        );
      else process.stdout.write(process.stdout.isTTY ? safeText(contents) : contents);
    });
  records
    .command("add")
    .description("Create a record with an allocated ID and canonical metadata")
    .addArgument(new Argument("<type>", "Record type").choices(Object.keys(recordNames)))
    .argument("<title-or-specification>", "Title, or a YAML specification for a release")
    .option("--project <id>", "Project scope (default: scope containing the current directory)")
    .option("--json", "Print the record path for automation")
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
        options: {
          project?: string;
          from?: string;
          parent?: string;
          dependsOn: string[];
          protocol?: string;
          json?: boolean;
        },
      ) => {
        const kind = recordNames[type];
        if (kind !== "TSK" && (options.from !== undefined || options.parent !== undefined || options.dependsOn.length))
          throw new Error("--from, --parent, and --depends-on apply only to tasks");
        if (kind !== "EXP" && options.protocol !== undefined) throw new Error("--protocol applies only to experiments");
        const project = currentProject(root, options.project);
        let created: string;
        if (kind === "EXP") {
          if (!options.protocol)
            throw new Error(
              "experiment creation requires --protocol PATH. Write the protocol with Hypothesis, Candidate and baseline, Independent variable, Controls and correctness, Workload, and Evaluation rule sections; see docs/records.md for a complete example.",
            );
          created = await createExperiment(root, title, options.protocol, project);
        } else if (kind === "REL") created = await addRelease(root, title, project);
        else {
          if (options.from === "-" && process.stdin.isTTY) throw new Error("--from - requires piped stdin");
          const body =
            options.from === undefined ? undefined : readFileSync(options.from === "-" ? 0 : options.from, "utf8");
          created = await addRecord(
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
        if (options.json) {
          sync(writeDiagnosticText);
          console.log(JSON.stringify({ path: created }));
        } else {
          reportCreatedRecord({ id: project }, kind, created);
          sync();
        }
      },
    );
  registerCommand(program, "release").description("Inspect release profiles and prepare verified artifacts");
  const group = registerCommand(program, "citation")
    .description("Show local citation status or acquire metadata and source documents")
    .option("--project <id>", "Limit status to one project scope")
    .option("--source <kind>", "Limit status to a source kind declared by the citations")
    .option("--missing", "Show sources missing their local documents")
    .option("--json", "Print structured source status and absolute document paths")
    .action((options: { project?: string; source?: string; missing?: boolean; json?: boolean }) => {
      listCitationStatus(root, options);
    });
  {
    scope(group.command("add").description("Retrieve metadata for an arXiv ID or DOI and create a citation"))
      .argument("<identifier>", "arXiv ID, DOI, or canonical URL")
      .action(async (identifier: string, options: { project?: string }) => {
        const project = currentProject(root, options.project);
        const created = await addCitation(root, identifier, project);
        reportCreatedRecord({ id: project }, "CIT", created);
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
    scope(group.command("import").description("Import an acquired source document and record its digest"))
      .argument("<id>", "Citation ID or scoped reference")
      .argument("<path>", "Local source document path")
      .option("--source <kind>", "Source kind when the citation has multiple sources")
      .action((id: string, path: string, options: { project?: string; source?: string }) =>
        importCitation(root, reference(root, "CIT", id, options.project), path, options.source),
      );
  }
}
