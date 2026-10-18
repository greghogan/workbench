import { registerLocalPolicyCommands } from "./local-policy-commands.js";
import { policyCompatibility } from "./policy-compatibility.js";
import { userDirectory } from "./storage.js";
import {
  acquireGitCollection,
  collectionOriginals,
  fetchCollectionOriginals,
  stageCollectionSubmodules,
  type GitCollectionOptions,
} from "./collection-git.js";
import { collectionChanges, reconcileCollection } from "./collection-reconcile.js";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { type Command, Option } from "commander";
import { readConfig, readText, relativeRecordPath, rootOf, scan, selectProject, writeAtomic } from "./core.js";
import { decisionScopes } from "./decisions.js";
import { linkedDecisionPaths, readDecision, referencedDecisions } from "./decision-record.js";
import {
  collectionName,
  collectionRevision,
  type CollectionIdentity,
  type CollectionManifest,
} from "./collection-schema.js";
import {
  inspectCollection,
  listCollections,
  resolveCollections,
  writeCollectionManifest,
  collectionSupportingFiles,
  type VerifiedCollection,
} from "./collections.js";
import { renderCollectionMap } from "./collection-maps.js";
import { formatDocument } from "./formatting.js";
import { ownedPath } from "./paths.js";
import { renderAgentContext } from "./agents.js";
import { installSelectedCollections } from "./collection-install.js";
import { collectionBytes, collectionCharterPath, validateCollectionCharter } from "./collection-files.js";

export function collectionDecisionMap(
  directory: string,
  collection: Pick<CollectionManifest, "id" | "decisions">,
): string {
  const project = { id: collection.id, path: "." };
  return renderCollectionMap(
    collection.decisions.map((number) =>
      readDecision(project, number, join(directory, "workbench", relativeRecordPath("ADR", number))),
    ),
  );
}

export async function exportCollection(
  root: string,
  output: string,
  id: string,
  revision: string,
  selected: string[],
  projectId: string | undefined,
  all: boolean,
  visibility: "public" | "private",
  charter?: string,
): Promise<CollectionIdentity> {
  if (!collectionName.test(id) || !collectionRevision.test(revision))
    throw new Error("invalid collection identity or revision");
  if (all === !!selected.length || (!all && !selected.length))
    throw new Error("explicitly select --all or one or more --decision IDs");
  const project = selectProject(root, projectId);
  if (project.id !== id) throw new Error("collection export ID must match its owning project namespace");
  const source = rootOf(root, project);
  const charterPath = charter === undefined ? join(source, collectionCharterPath) : resolve(root, charter);
  const charterBytes = existsSync(charterPath)
    ? collectionBytes(dirname(charterPath), basename(charterPath))
    : undefined;
  validateCollectionCharter(charterBytes, charterPath);
  const records = scan(source, "ADR");
  const numbers = all
    ? records.map((record) => record.number)
    : selected.map((value) => {
        const number = value.replace(/^ADR-/i, "").toUpperCase();
        if (!records.some((record) => record.number === number)) throw new Error(`unknown exported ADR '${value}'`);
        return number;
      });
  if (!numbers.length || new Set(numbers).size !== numbers.length)
    throw new Error("select distinct nonempty exported ADRs");
  numbers.sort((a, b) => a.length - b.length || a.localeCompare(b));
  const sharedReferences = new Set(
    decisionScopes(root, false).flatMap((scope) => scope.decisions.map((decision) => decision.reference)),
  );
  const destination = resolve(output);
  if (existsSync(destination))
    throw new Error("collection export destination already exists; immutable exports are never overwritten");
  mkdirSync(dirname(destination), { recursive: true });
  const lock = join(dirname(destination), `.${basename(destination)}.lock`);
  mkdirSync(lock, { mode: 0o700 });
  const temporary = mkdtempSync(join(dirname(destination), ".collection-export-"));
  try {
    if (existsSync(destination)) throw new Error("collection export destination already exists");
    const collection = { id, decisions: numbers };
    mkdirSync(join(temporary, "workbench"));
    writeFileSync(join(temporary, collectionCharterPath), charterBytes);
    for (const number of numbers) {
      const name = `workbench/${relativeRecordPath("ADR", number).split(sep).join("/")}`;
      const contents = readText(ownedPath(source, name));
      // Provider formatting and schema validation precede immutable publication.
      const formatted = await formatDocument(contents, name, readConfig(root).markdown?.wrap_width ?? 120);
      readDecision(project, number, ownedPath(source, name));
      writeAtomic(join(temporary, name), formatted);
    }
    const supporting = collectionSupportingFiles(source, numbers);
    for (const [name, bytes] of supporting) {
      mkdirSync(dirname(join(temporary, name)), { recursive: true });
      writeFileSync(join(temporary, name), bytes);
    }
    writeAtomic(join(temporary, "workbench/decision-map.md"), collectionDecisionMap(temporary, collection));
    const pin = writeCollectionManifest(temporary, {
      id,
      revision,
      visibility,
      decisions: numbers,
    });
    // References to local ADRs omitted from the export are not portable.
    const allowed = new Set([
      join(temporary, collectionCharterPath),
      join(temporary, "workbench/decision-map.md"),
      ...numbers.map((number) => join(temporary, "workbench", relativeRecordPath("ADR", number))),
      ...[...supporting.keys()].map((name) => join(temporary, name)),
    ]);
    for (const number of numbers) {
      const decision = readDecision(project, number, join(temporary, "workbench", relativeRecordPath("ADR", number)));
      for (const reference of referencedDecisions(decision)) {
        if (reference.startsWith(`${id}:ADR-`) && !numbers.includes(reference.split("ADR-")[1] ?? ""))
          throw new Error("exported ADR refers to a decision outside the export");
        if (!reference.startsWith(`${id}:ADR-`) || !sharedReferences.has(reference))
          throw new Error("exported ADR refers to an optional local or unavailable decision");
      }
      if (linkedDecisionPaths(decision).some((path) => !allowed.has(path)))
        throw new Error("exported ADR links outside its self-contained export");
    }
    renameSync(temporary, destination);
    return { id: pin.id, revision: pin.revision, sha256: pin.sha256, visibility: pin.visibility };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Validate audience before any packaging or public context export effects. */
export function checkCollectionExport(root: string, includePrivate: boolean): void {
  const privateSources = resolveCollections(root, false).filter((entry) => entry.pin.visibility === "private");
  if (privateSources.length && !includePrivate)
    throw new Error(
      "private ADR collections require an explicit private-audience export; publication is not authorized by installation",
    );
  decisionScopes(root, false);
}

/** Compare verified revisions without changing the selected pin or publishing private policy by default. */
export function compareCollection(
  root: string,
  id: string,
  directory: string,
  options: GitCollectionOptions,
  includePrivate: boolean,
) {
  const current = resolveCollections(root).find((entry) => entry.pin.id === id);
  if (!current) throw new Error(`collection '${id}' is not installed`);
  const candidate = acquireGitCollection(root, directory, { ...options, id });
  if (candidate.pin.id !== id) throw new Error("candidate collection identity or SHA-256 does not match");
  if (!includePrivate && [current.pin.visibility, candidate.pin.visibility].includes("private"))
    throw new Error("private policy comparison requires --include-private and a private audience");
  const original = current.local ? current : collectionOriginals(root, current.pin);
  const records = (entry: VerifiedCollection) =>
    new Map(
      entry.manifest.decisions.map((number) => {
        const name = `workbench/${relativeRecordPath("ADR", number).split(sep).join("/")}`;
        const contents = entry.files.get(name)?.toString("utf8");
        if (contents === undefined) throw new Error("verified collection record is missing");
        return [`${entry.pin.id}:ADR-${number}`, contents] as const;
      }),
    );
  const before = records(original);
  const after = records(candidate);
  const changes = [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .flatMap((reference) =>
      before.get(reference) === after.get(reference)
        ? []
        : [{ reference, before: before.get(reference) ?? null, after: after.get(reference) ?? null }],
    );
  const files = [...new Set([...Object.keys(original.manifest.files), ...Object.keys(candidate.manifest.files)])]
    .sort()
    .flatMap((path) =>
      original.manifest.files[path] === candidate.manifest.files[path]
        ? []
        : [{ path, before: original.manifest.files[path] ?? null, after: candidate.manifest.files[path] ?? null }],
    );
  return {
    before: current.pin,
    after: { ...candidate.pin, scopes: current.pin.scopes },
    changes,
    files,
    review: current.local
      ? "Review policy text, then install the candidate at the same local scope. Project-owned copies are unchanged."
      : "Review policy text and resulting instructions; use collection update, then run workbench sync and validate. This comparison changes no files.",
  };
}

export function registerCollectionCommands(program: Command, root: string): void {
  const collection = program
    .command("collection")
    .description("Inspect project-owned collections and local policy")
    .option("--installed", "List all stored revisions, including older unselected revisions")
    .option("--json", "Print identities, pins, scopes, and locations as JSON")
    .action((options: { installed?: boolean; json?: boolean }) => {
      listCollections(root, !!options.installed, !!options.json);
    });
  collection
    .command("changes")
    .description("List project adaptations against the retained upstream snapshot")
    .argument("<id>")
    .action((id: string) => {
      console.log(JSON.stringify(collectionChanges(root, id), null, 2));
    });
  collection
    .command("fetch")
    .description("Fetch the pinned original Git objects without checking out collection files")
    .argument("<id>")
    .action((id: string) => {
      const pin = readConfig(root).collections?.sources?.find((entry) => entry.id === id);
      if (!pin) throw new Error(`project collection not found: ${id}`);
      fetchCollectionOriginals(root, pin);
      console.log(`Originals available for ${id} at ${pin.commit ?? ""}; no working tree was created.`);
    });
  collection
    .command("stage")
    .description("Explicitly stage collection gitlinks; other files remain for ordinary git add")
    .argument("[id]")
    .action((id?: string) => {
      const pins = (readConfig(root).collections?.sources ?? []).filter((pin) => !id || pin.id === id);
      if (!pins.length) throw new Error("no matching project collections");
      stageCollectionSubmodules(root, pins);
      console.log(
        `Staged ${String(pins.length)} collection gitlink(s). Stage .gitmodules, configuration, and reviewed records separately.`,
      );
    });
  collection
    .command("update")
    .description("Reconcile a pinned Git collection with project adaptations")
    .argument("<id>")
    .argument("[repository]")
    .requiredOption("--commit <commit>", "Full immutable source Git commit")
    .option("--collection <path>", "Collection root within the source repository")
    .option("--sha256 <digest>", "Additionally verify the expected collection content digest")
    .option("--resolved <directory>", "Complete manually reconciled proposal after conflicts")
    .action((id: string, repository: string | undefined, options: GitCollectionOptions & { resolved?: string }) => {
      const pin = readConfig(root).collections?.sources?.find((entry) => entry.id === id);
      if (!pin?.source) throw new Error(`project collection not found: ${id}`);
      console.log(
        JSON.stringify(
          reconcileCollection(
            root,
            repository ?? pin.source,
            { ...options, collection: options.collection ?? pin.collection ?? ".", visibility: pin.visibility },
            id,
            options.resolved,
          ),
          null,
          2,
        ),
      );
      console.log("Run workbench sync and validate; review changed ADRs before committing. Nothing was staged.");
    });
  registerLocalPolicyCommands(collection, root);
  collection
    .command("context")
    .description("Read current local guidance, context locations, and compatibility review status")
    .action(() => {
      process.stdout.write(renderAgentContext(root, true));
      console.log(`\nLocal context entry point: ${join(userDirectory("data"), "AGENTS.md")}`);
      console.log(JSON.stringify(policyCompatibility(root), null, 2));
    });
  collection
    .command("inspect")
    .description("Verify a locally acquired collection and print its pin")
    .argument("<directory>")
    .action((directory: string) => {
      const { pin } = inspectCollection(resolve(directory));
      console.log(JSON.stringify(pin, null, 2));
    });
  collection
    .command("install")
    .description("Adopt a project collection or prepare a local draft for human approval")
    .argument("<directories...>", "One Git repository for project adoption, or local exports for machine guidance")
    .option("--resolved <directory>", "Resolved local update proposal")
    .option("--commit <commit>", "Full source Git commit for project adoption")
    .option("--collection <path>", "Collection root within the source repository", ".")
    .addOption(new Option("--visibility <visibility>").choices(["public", "private"]).default("private"))
    .option(
      "--sha256 <digest>",
      "Recorded manifest digest; repeat in the same order as directories",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .addOption(
      new Option("--scope <scope>", "Installation scope; project is tracked, local is checkout-only")
        .choices(["user", "system", "local", "project"])
        .default("project"),
    )
    .option(
      "--directory <directory>",
      "Override the destination collections directory, including a system installation",
    )
    .action(
      (
        directories: string[],
        options: {
          sha256: string[];
          directory?: string;
          scope: string;
          commit?: string;
          collection?: string;
          visibility: "public" | "private";
          resolved?: string;
        },
      ) => {
        if ((options.scope !== "project" || options.sha256.length) && directories.length !== options.sha256.length)
          throw new Error("supply one --sha256 for each directory, in the same order");
        if (options.scope === "project" && options.resolved)
          throw new Error("use collection update --resolved for project reconciliation");
        const pins = installSelectedCollections(
          root,
          directories.map((source, index) => ({
            source,
            ...(options.sha256[index] ? { sha256: options.sha256[index] } : {}),
          })),
          options,
        );
        const selections = pins.map((pin) => ({
          ...pin,
          installation: options.scope === "project" ? "project" : "pending-local",
        }));
        console.log(JSON.stringify(selections.length === 1 ? selections[0] : selections, null, 2));
      },
    );
  collection
    .command("export")
    .description("Export explicitly selected project ADRs for consumers")
    .argument("<directory>")
    .requiredOption("--id <id>")
    .requiredOption("--revision <revision>")
    .option("--project <id>")
    .option(
      "--charter <path>",
      "Human-written collection charter; defaults to the selected project's workbench/CHARTER.md",
    )
    .option(
      "--decision <id>",
      "Export this ADR; repeat to select several",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--all", "Explicitly export all decisions in the selected project")
    .addOption(new Option("--visibility <visibility>").choices(["public", "private"]).default("private"))
    .action(
      async (
        directory: string,
        options: {
          id: string;
          revision: string;
          project?: string;
          charter?: string;
          decision: string[];
          all?: boolean;
          visibility: "public" | "private";
        },
      ) => {
        console.log(
          JSON.stringify(
            await exportCollection(
              root,
              directory,
              options.id,
              options.revision,
              options.decision,
              options.project,
              !!options.all,
              options.visibility,
              options.charter,
            ),
            null,
            2,
          ),
        );
      },
    );
  collection
    .command("compare")
    .description("Report upstream changes from an exact Git commit without updating policy")
    .argument("<id>")
    .argument("[repository]")
    .requiredOption("--commit <commit>")
    .option("--collection <path>")
    .option("--sha256 <digest>")
    .option("--include-private", "Show private policy only to a private audience")
    .action(
      (id: string, repository: string | undefined, options: GitCollectionOptions & { includePrivate?: boolean }) => {
        const pin = readConfig(root).collections?.sources?.find((entry) => entry.id === id);
        if (!pin?.source) throw new Error(`project collection not found: ${id}`);
        console.log(
          JSON.stringify(
            compareCollection(
              root,
              id,
              repository ?? pin.source,
              { ...options, collection: options.collection ?? pin.collection ?? ".", visibility: pin.visibility },
              !!options.includePrivate,
            ),
            null,
            2,
          ),
        );
      },
    );
  collection
    .command("check-export")
    .description("Verify collection references and the permitted export audience")
    .option("--include-private", "Export into a private audience; does not authorize public publication")
    .action((options: { includePrivate?: boolean }) => {
      checkCollectionExport(root, !!options.includePrivate);
      console.log("Collection export audience and references verified.");
    });
}
