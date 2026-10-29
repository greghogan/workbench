import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { writeAtomic } from "../scripts/file-publication.mjs";
import { collectionBytes, collectionCharterPath, validateCollectionCharter } from "./collection-files.js";
import { acquireGitCollection, collectionOriginals, type GitCollectionOptions } from "./collection-git.js";
import { renderCollectionMap } from "./collection-maps.js";
import {
  collectionName,
  collectionRevision,
  type CollectionIdentity,
  type CollectionManifest,
} from "./collection-schema.js";
import {
  collectionSupportingFiles,
  resolveCollections,
  writeCollectionManifest,
  type VerifiedCollection,
} from "./collections.js";
import { linkedDecisionPaths, readDecision, referencedDecisions } from "./decision-record.js";
import { decisionScopes } from "./decisions.js";
import { readText } from "./files.js";
import { formatDocument } from "./formatting.js";
import { ownedPath } from "./paths.js";
import { readConfig, selectProject } from "./project-configuration.js";
import { rootOf } from "./project-context.js";
import { scan } from "./record-files.js";
import { compareRecordNumbers, relativeRecordPath } from "./record-identity.js";
import { synchronize } from "./sync.js";
import { validationReport } from "./validation.js";

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
  numbers.sort(compareRecordNumbers);
  const sharedReferences = new Set(
    decisionScopes(root, false).flatMap((scope) => scope.decisions.map((decision) => decision.reference)),
  );
  const destination = resolve(output);
  if (existsSync(destination))
    throw new Error("collection export destination already exists; immutable exports are never overwritten");
  mkdirSync(dirname(destination), { recursive: true });
  const lock = join(dirname(destination), `.${basename(destination)}.lock`);
  mkdirSync(lock, { mode: 0o700 });
  let staging: string | undefined;
  try {
    const temporary = mkdtempSync(join(dirname(destination), ".collection-export-"));
    staging = temporary;
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
    if (staging) rmSync(staging, { recursive: true, force: true });
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
      : "Review policy text and resulting instructions, then apply with collection update. This comparison changes no files.",
  };
}

/** Applied files remain applied even if context synchronization or validation reports a problem. */
export async function prepareCollectionReview(root: string): Promise<{ issues: string[]; omitted: number }> {
  let issues: string[];
  try {
    synchronize(root, false, () => undefined);
    issues = (await validationReport(root)).errors;
  } catch (error) {
    issues = [error instanceof Error ? error.message : String(error)];
  }
  const retained: string[] = [];
  let bytes = 0;
  for (const issue of issues) {
    if (bytes + Buffer.byteLength(issue) > 64 * 1024) break;
    retained.push(issue);
    bytes += Buffer.byteLength(issue);
  }
  return { issues: retained, omitted: issues.length - retained.length };
}
