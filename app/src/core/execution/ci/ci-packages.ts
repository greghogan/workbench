import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  artifactHost,
  distinctArtifactBuilds,
  isReleaseTag,
  readArtifactCatalog,
  releasePackageRows,
  withArtifactTag,
  type ArtifactPlanEntry,
} from "../../artifacts/artifact-catalog.js";
import { artifactSourceRevision, buildFileArtifact, exportFileArtifact } from "../../artifacts/artifact-files.js";
import { InvalidInput, StateConflict } from "../../runtime/input-errors.js";
import { required } from "../../runtime/invariants.js";
import { readBoundedFile } from "../../runtime/file-reads.js";
import { record, records, string } from "../../runtime/values.mjs";
import { writeAtomic } from "../../runtime/file-publication.mjs";
import { readProjects } from "../../projects/project-configuration.js";
import { errorMessage } from "./support/ci-results.mjs";
import { CILifecycle } from "./support/ci-lifecycle.mjs";

const resultName = "packages.json";

interface PackageEvidence {
  directory: string;
  manifestSha256: string;
}

export function readCIPackageEvidence(directory: string, revision: string): Map<string, PackageEvidence> {
  const report = record(
    JSON.parse(readBoundedFile(join(directory, resultName), 1024 * 1024, "CI package results").toString("utf8")),
    "Invalid CI package results",
  );
  if (report.version !== 1) throw new InvalidInput("Unsupported CI package results");
  if (report.revision !== revision) return new Map();
  const evidence = new Map<string, PackageEvidence>();
  for (const entry of records(report.packages, "Invalid CI package evidence")) {
    if (entry.status !== "verified") throw new StateConflict("CI package results contain unfinished verification");
    const recipe = string(entry.recipe, "Missing verified recipe");
    const checksum = string(entry.manifestSha256, "Missing verified manifest checksum");
    const source = string(entry.directory, "Missing verified package directory");
    if (
      !/^[a-f0-9]{64}$/.test(recipe) ||
      !/^[a-f0-9]{64}$/.test(checksum) ||
      source !== `artifact-${checksum}` ||
      evidence.has(recipe)
    )
      throw new StateConflict("Invalid or duplicate CI package evidence");
    evidence.set(recipe, { directory: source, manifestSha256: checksum });
  }
  return evidence;
}

function packageID({ profile, target, format, recipe }: ArtifactPlanEntry): string {
  return `${profile}.${target}.${format}.${recipe}`;
}

interface NativePackagePlatform {
  os: string;
  architecture: string;
  runner: string;
  paths: string[];
}

export interface CIPackageJob extends NativePackagePlatform {
  id: string;
  builder: ArtifactPlanEntry["builder"];
  abi?: string;
  packages: string[];
}

/** A profile alias cannot add a second build of the same recipe, target and format. */
export function plannedCIPackages(root: string, platforms?: ReadonlySet<string>) {
  const declared = releasePackageRows(readArtifactCatalog(root));
  const excluded = declared.flatMap((row) =>
    row.ciSkipReason ? [{ id: packageID(row), reason: row.ciSkipReason }] : [],
  );
  const selected = distinctArtifactBuilds(declared.filter((row) => !row.ciSkipReason)).map((row) => ({
    id: packageID(row),
    row,
  }));
  for (const { id, row } of selected) {
    if (row.workspace !== "host") throw new InvalidInput(`${id}: CI release packaging requires a host workspace`);
    if (platforms && !platforms.has(row.platform))
      throw new InvalidInput(`${id}: add a native ${row.platform} CI runner for this release package`);
  }
  return { selected, excluded };
}

/** Group formats sharing one project and builder while isolating independent store demands. */
export function ciPackageMatrix(root: string, native: readonly NativePackagePlatform[]) {
  const platforms = new Map(native.map((entry) => [`${entry.os}-${entry.architecture}`, entry]));
  const { selected, excluded } = plannedCIPackages(root, new Set(platforms.keys()));
  const owners = new Map(readProjects(root).map(({ id, path }) => [id, path]));
  const jobs = new Map<string, CIPackageJob>();
  for (const { id, row } of selected) {
    const platform = required(platforms.get(row.platform), "Package platform");
    const owner = row.definition.owner;
    const ownerPath = required(owners.get(owner), "Package owner");
    const path = platform.paths
      .filter((path) => path === "." || path === ownerPath || ownerPath.startsWith(path + "/"))
      .sort((left, right) => right.length - left.length)[0];
    if (path === undefined) throw new InvalidInput(`${id}: add native ${row.platform} CI coverage for '${ownerPath}'`);
    const key = `${owner}.${row.target}.${row.builder}`;
    const job = jobs.get(key) ?? {
      id: key,
      os: platform.os,
      architecture: platform.architecture,
      runner: platform.runner,
      builder: row.builder,
      ...(row.requirements.abi ? { abi: row.requirements.abi } : {}),
      paths: [path],
      packages: [],
    };
    job.packages.push(id);
    jobs.set(key, job);
  }
  return { include: [...jobs.values()], excluded };
}

/** Run packaging on the target host using the normal artifact builder and verifier. */
export async function verifyCIPackages(
  root: string,
  ids: readonly string[],
  reports: string,
  tag?: string,
): Promise<void> {
  if (new Set(ids).size !== ids.length) throw new InvalidInput("Select distinct configured CI release packages");
  const { selected } = plannedCIPackages(root);
  const host = artifactHost();
  const requested = ids.length ? ids : selected.filter(({ row }) => row.platform === host).map(({ id }) => id);
  if (!requested.length) throw new InvalidInput(`No release packages are configured for ${host}`);
  const packages = requested.map((id) => {
    const entry = selected.find((candidate) => candidate.id === id);
    if (!entry) throw new InvalidInput(`Unknown CI release package '${id}'`);
    if (entry.row.platform !== host)
      throw new InvalidInput(`${id}: CI release verification requires a native ${entry.row.platform} host`);
    return entry;
  });
  const directory = resolve(root, reports);
  mkdirSync(directory, { recursive: true });
  const revision = artifactSourceRevision(root);
  const releaseTag = tag && isReleaseTag(tag) ? tag : undefined;
  const result = join(directory, resultName);
  const outcomes = packages.map(({ id }) => ({ id, status: "pending" }));
  const save = () => {
    writeAtomic(result, JSON.stringify({ version: 1, revision, tag: releaseTag, packages: outcomes }, null, 2) + "\n");
  };
  const failures: Error[] = [];
  const lifecycle = new CILifecycle();
  try {
    save();
    for (const [index, { id, row }] of packages.entries()) {
      await lifecycle.checkpoint();
      const outcome = required(outcomes[index], "CI package outcome");
      console.log(`Verify package ${id}`);
      try {
        const artifact = await buildFileArtifact(root, withArtifactTag(row, releaseTag));
        await lifecycle.checkpoint();
        if (
          revision &&
          (artifact.manifest.revision !== revision || artifact.manifest.verification?.revision !== revision)
        )
          throw new StateConflict(`${id}: source changed during CI package verification`);
        const exported = await exportFileArtifact(artifact, directory);
        Object.assign(outcome, {
          status: "verified",
          recipe: artifact.manifest.recipe,
          directory: basename(exported.directory),
          manifestSha256: exported.manifestSha256,
          sha256: artifact.manifest.sha256,
        });
      } catch (error) {
        await lifecycle.checkpoint();
        failures.push(new Error(id, { cause: error }));
        Object.assign(outcome, { status: "failed", error: errorMessage(error) });
      } finally {
        save();
      }
    }
  } finally {
    lifecycle.close();
  }
  if (failures.length) throw new AggregateError(failures, `CI release packages failed. Results at ${result}`);
}
