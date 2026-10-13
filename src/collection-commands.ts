import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { type Command, Option } from "commander";
import { readConfig, readText, relativeRecordPath, rootOf, scan, selectProject, writeAtomic } from "./core.js";
import { decisionScopes } from "./decisions.js";
import { linkedDecisionPaths, readDecision, referencedDecisions } from "./decision-record.js";
import {
  collectionName,
  collectionRevision,
  type CollectionIdentity,
  type CollectionNamespace,
} from "./collection-schema.js";
import {
  inspectCollection,
  storeCollection,
  listCollections,
  resolveCollections,
  writeCollectionManifest,
} from "./collections.js";
import { renderCollectionMap } from "./collection-maps.js";
import { formatDocument } from "./formatting.js";
import { ownedPath } from "./paths.js";
import { renderAgentContext } from "./agents.js";
import { installSelectedCollections } from "./collection-install.js";

export function collectionDecisionMap(directory: string, namespace: CollectionNamespace): string {
  const project = { id: namespace.id, path: namespace.path };
  return renderCollectionMap(
    namespace.decisions.map((number) =>
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
): Promise<CollectionIdentity> {
  if (!collectionName.test(id) || !collectionRevision.test(revision))
    throw new Error("invalid collection identity or revision");
  if (all === !!selected.length || (!all && !selected.length))
    throw new Error("explicitly select --all or one or more --decision IDs");
  const project = selectProject(root, projectId);
  if (project.id !== id) throw new Error("collection export ID must match its owning project namespace");
  const source = rootOf(root, project);
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
  const collections = resolveCollections(root, false);
  const needed = new Set<string>();
  const requireCollection = (collectionId: string): void => {
    if (needed.has(collectionId)) return;
    const collection = collections.find((entry) => entry.pin.id === collectionId);
    if (!collection) throw new Error(`exported collection dependency is unavailable: ${collectionId}`);
    needed.add(collectionId);
    for (const dependency of collection.manifest.dependency) requireCollection(dependency.id);
  };
  for (const number of numbers) {
    const decision = readDecision(project, number, join(source, "workbench", relativeRecordPath("ADR", number)));
    for (const reference of referencedDecisions(decision)) {
      const namespace = reference.split(":")[0];
      const provider = collections.find((entry) => entry.manifest.namespace.some((entry) => entry.id === namespace));
      if (provider) requireCollection(provider.pin.id);
    }
  }
  const dependencies = collections
    .filter(({ pin }) => needed.has(pin.id))
    .map(({ pin }) => ({
      id: pin.id,
      revision: pin.revision,
      sha256: pin.sha256,
      visibility: pin.visibility,
    }));
  if (visibility === "public" && dependencies.some((pin) => pin.visibility === "private"))
    throw new Error("public collection export would disclose private dependencies; export for a private audience");
  const destination = resolve(output);
  if (existsSync(destination))
    throw new Error("collection export destination already exists; immutable exports are never overwritten");
  mkdirSync(dirname(destination), { recursive: true });
  const lock = join(dirname(destination), `.${basename(destination)}.lock`);
  mkdirSync(lock, { mode: 0o700 });
  const temporary = mkdtempSync(join(dirname(destination), ".collection-export-"));
  try {
    if (existsSync(destination)) throw new Error("collection export destination already exists");
    const namespace = { id, path: ".", decisions: numbers };
    for (const number of numbers) {
      const name = `workbench/${relativeRecordPath("ADR", number).split(sep).join("/")}`;
      const contents = readText(ownedPath(source, name));
      // Provider formatting and schema validation precede immutable publication.
      const formatted = await formatDocument(contents, name, readConfig(root).markdown?.wrap_width ?? 120);
      readDecision(project, number, ownedPath(source, name));
      writeAtomic(join(temporary, name), formatted);
    }
    writeAtomic(join(temporary, "workbench/decision-map.md"), collectionDecisionMap(temporary, namespace));
    const pin = writeCollectionManifest(temporary, {
      id,
      revision,
      visibility,
      namespace: [namespace],
      dependency: dependencies,
    });
    // References to local ADRs omitted from the export are not portable.
    const allowed = new Set([
      join(temporary, "workbench/decision-map.md"),
      ...numbers.map((number) => join(temporary, "workbench", relativeRecordPath("ADR", number))),
    ]);
    for (const number of numbers) {
      const decision = readDecision(project, number, join(temporary, "workbench", relativeRecordPath("ADR", number)));
      for (const reference of referencedDecisions(decision)) {
        if (reference.startsWith(`${id}:ADR-`) && !numbers.includes(reference.split("ADR-")[1] ?? ""))
          throw new Error("exported ADR refers to a decision outside the export");
        if (!sharedReferences.has(reference))
          throw new Error("exported ADR refers to an optional local or unavailable decision");
      }
      if (linkedDecisionPaths(decision).some((path) => !allowed.has(path)))
        throw new Error("exported ADR links outside the export; use qualified references to dependencies");
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
  digest: string,
  includePrivate: boolean,
) {
  const current = resolveCollections(root).find((entry) => entry.pin.id === id);
  if (!current) throw new Error(`collection '${id}' is not installed`);
  const candidate = inspectCollection(resolve(directory));
  if (candidate.pin.id !== id || candidate.pin.sha256 !== digest)
    throw new Error("candidate collection identity or SHA-256 does not match");
  if (!includePrivate && [current.pin.visibility, candidate.pin.visibility].includes("private"))
    throw new Error("private policy comparison requires --include-private and a private audience");
  const records = (entry: typeof current) =>
    new Map(
      entry.manifest.namespace.flatMap((namespace) =>
        namespace.decisions.map((number) => {
          const name = [
            namespace.path === "." ? "" : namespace.path,
            "workbench",
            relativeRecordPath("ADR", number).split(sep).join("/"),
          ]
            .filter(Boolean)
            .join("/");
          const contents = entry.files.get(name)?.toString("utf8");
          if (contents === undefined) throw new Error("verified collection record is missing");
          return [`${namespace.id}:ADR-${number}`, contents] as const;
        }),
      ),
    );
  const before = records(current);
  const after = records(candidate);
  const changes = [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .flatMap((reference) =>
      before.get(reference) === after.get(reference)
        ? []
        : [{ reference, before: before.get(reference) ?? null, after: after.get(reference) ?? null }],
    );
  return {
    before: current.pin,
    after: { ...candidate.pin, scopes: current.pin.scopes },
    changes,
    dependencies: { before: current.manifest.dependency, after: candidate.manifest.dependency },
    review: current.local
      ? "Review policy text and dependencies, then install the candidate at the same local scope. Shared project pins are unchanged."
      : "Review policy text, dependencies, and resulting instructions; install with --scope project, then run workbench sync and validate. This comparison changes no files.",
  };
}

export function registerCollectionCommands(program: Command, root: string): void {
  const collection = program
    .command("collection")
    .description("Inspect automatically applicable local collections and shared project pins")
    .option("--installed", "List all stored revisions, including older unselected revisions")
    .option("--json", "Print identities, pins, scopes, and locations as JSON")
    .action((options: { installed?: boolean; json?: boolean }) => {
      listCollections(root, !!options.installed, !!options.json);
    });
  collection
    .command("context")
    .description("Read applicable local collection maps and agent instructions without changing shared context")
    .action(() => {
      process.stdout.write(renderAgentContext(root, true));
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
    .description("Verify a locally acquired collection and check its policy context before selecting it")
    .argument("<directories...>", "Collection exports to select together")
    .requiredOption(
      "--sha256 <digest>",
      "Recorded manifest digest; repeat in the same order as directories",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .addOption(
      new Option("--scope <scope>", "Installation scope; project is tracked, local is checkout-only")
        .choices(["user", "system", "local", "project"])
        .default("user"),
    )
    .option(
      "--directory <directory>",
      "Override the destination collections directory, including a system installation",
    )
    .action((directories: string[], options: { sha256: string[]; directory?: string; scope: string }) => {
      if (directories.length !== options.sha256.length)
        throw new Error("supply one --sha256 for each directory, in the same order");
      const pins = installSelectedCollections(
        root,
        directories.map((source, index) => ({ source, sha256: options.sha256[index] ?? "" })),
        options,
      );
      const selections = pins.map((pin) => ({
        ...pin,
        installation: options.scope === "project" ? "project" : "local",
      }));
      console.log(JSON.stringify(selections.length === 1 ? selections[0] : selections, null, 2));
    });
  collection
    .command("export")
    .description("Export explicitly selected project ADRs for consumers")
    .argument("<directory>")
    .requiredOption("--id <id>")
    .requiredOption("--revision <revision>")
    .option("--project <id>")
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
            ),
            null,
            2,
          ),
        );
      },
    );
  collection
    .command("bundle")
    .description("Copy shared project collections for offline provisioning or an explicitly selected export audience")
    .argument("<directory>", "Destination collections directory")
    .option("--include-private", "Include private policy only for a private audience")
    .action((directory: string, options: { includePrivate?: boolean }) => {
      checkCollectionExport(root, !!options.includePrivate);
      const sources = resolveCollections(root, false);
      for (const source of sources) storeCollection(source.directory, source.pin.sha256, resolve(directory));
      console.log(`Prepared ${String(sources.length)} pinned collection(s).`);
    });
  collection
    .command("compare")
    .description("Report a verified candidate's policy changes without updating the project")
    .argument("<id>")
    .argument("<directory>")
    .requiredOption("--sha256 <digest>")
    .option("--include-private", "Show private policy only to a private audience")
    .action((id: string, directory: string, options: { sha256: string; includePrivate?: boolean }) => {
      console.log(
        JSON.stringify(compareCollection(root, id, directory, options.sha256, !!options.includePrivate), null, 2),
      );
    });
  collection
    .command("check-export")
    .description("Verify collection references and the permitted export audience")
    .option("--include-private", "Export into a private audience; does not authorize public publication")
    .action((options: { includePrivate?: boolean }) => {
      checkCollectionExport(root, !!options.includePrivate);
      console.log("Collection export audience and references verified.");
    });
}
