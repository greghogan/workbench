import { basename, dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import {
  distinctArtifactBuilds,
  readArtifactCatalog,
  releasePackageRows,
  withArtifactTag,
} from "../../artifacts/artifact-catalog.js";
import {
  buildFileArtifact,
  exportFileArtifact,
  importFileArtifact,
  recipeKey,
} from "../../artifacts/artifact-files.js";
import { publishArtifactFiles, releaseVariant, verifiedReleaseSource } from "../../artifacts/artifact-release.js";
import { readBoundedFile } from "../../runtime/file-reads.js";
import { writeAtomic } from "../../runtime/file-publication.mjs";
import { InvalidInput, StateConflict } from "../../runtime/input-errors.js";
import { ownedPath } from "../../runtime/paths.js";
import { record, records, string } from "../../runtime/values.mjs";
import { withCacheLock } from "../../storage/cache-lock.js";
import { required } from "../../runtime/invariants.js";
import { readCIPackageEvidence } from "./ci-packages.js";

const receiptName = "release.json";
const receiptLimit = 1024 * 1024;

function configuredRelease(root: string, tag: string) {
  const catalog = readArtifactCatalog(root);
  const rule = catalog.publication.tag;
  if (!rule?.refs.some((ref) => (ref.endsWith("*") ? tag.startsWith(ref.slice(0, -1)) : ref === tag)))
    throw new InvalidInput(`No configured CI release for ${tag}`);
  const revision = verifiedReleaseSource(root, tag);
  const destination = required(catalog.destinations[rule.destination], "Configured release destination");
  const rows = distinctArtifactBuilds(
    releasePackageRows(catalog, {
      profiles: rule.profiles,
      targets: rule.targets.map(({ name }) => name),
    }),
  );
  const targets = rule.targets.map(({ name }) => ({
    name,
    rows: rows.filter(({ target }) => target === name).map((row) => withArtifactTag(row, tag)),
  }));
  return { revision, destination, targets };
}

export async function packageCIRelease(
  root: string,
  tag: string,
  target: string,
  path: string,
  verifiedPackages?: string,
) {
  const { revision, targets } = configuredRelease(root, tag);
  const selected = targets.find(({ name }) => name === target);
  if (!selected) throw new InvalidInput(`${target} is not selected for ${tag}`);
  const output = resolve(root, path);
  const evidenceDirectory = verifiedPackages ? realpathSync(resolve(root, verifiedPackages)) : undefined;
  const evidence = evidenceDirectory ? readCIPackageEvidence(evidenceDirectory, revision) : undefined;
  mkdirSync(dirname(output), { recursive: true });
  return withCacheLock(output, async () => {
    if (existsSync(output)) throw new StateConflict(`Release transfer already exists at ${output}`);
    const stage = mkdtempSync(join(dirname(output), ".release-package-"));
    try {
      const files = [];
      for (const row of selected.rows) {
        const checked = evidence?.get(recipeKey(row));
        const artifact =
          checked && evidenceDirectory
            ? await importFileArtifact(
                root,
                row,
                ownedPath(evidenceDirectory, checked.directory),
                checked.manifestSha256,
                {
                  verifiedOnTarget: true,
                },
              )
            : await buildFileArtifact(root, row);
        if (artifact.manifest.revision !== revision || artifact.manifest.verification?.revision !== revision)
          throw new StateConflict(`${row.profile}: release evidence does not match ${tag}`);
        const exported = await exportFileArtifact(artifact, stage);
        files.push({
          variant: releaseVariant(row),
          directory: basename(exported.directory),
          sha256: exported.manifestSha256,
        });
      }
      writeAtomic(join(stage, receiptName), JSON.stringify({ version: 1, revision, tag, target, files }) + "\n");
      renameSync(stage, output);
      return output;
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });
}

export async function publishCIRelease(root: string, tag: string, input: string) {
  const { revision, destination, targets } = configuredRelease(root, tag);
  const directory = realpathSync(resolve(root, input));
  const generations = [];
  for (const { name, rows } of targets) {
    const target = ownedPath(directory, name);
    const receipt = record(
      JSON.parse(readBoundedFile(join(target, receiptName), receiptLimit, "CI release transfer").toString("utf8")),
      "Invalid CI release transfer",
    );
    if (receipt.version !== 1 || receipt.revision !== revision || receipt.tag !== tag || receipt.target !== name)
      throw new StateConflict(`${name}: release transfer does not match ${tag}`);
    const files = records(receipt.files, "Invalid CI release transfer files");
    const byVariant = new Map(files.map((entry) => [entry.variant, entry]));
    if (files.length !== rows.length || byVariant.size !== rows.length)
      throw new StateConflict(`${name}: release transfer has missing or extra artifacts`);
    for (const row of rows) {
      const variant = releaseVariant(row);
      const file = byVariant.get(variant);
      if (!file) throw new StateConflict(`${name}: release transfer lacks ${variant}`);
      const sha256 = string(file.sha256, "Missing manifest SHA-256");
      const source = string(file.directory, "Missing release export directory");
      if (!/^artifact-[a-f0-9]{64}$/.test(source)) throw new InvalidInput("Invalid release export directory");
      const received = await importFileArtifact(root, row, ownedPath(target, source), sha256, {
        verifiedOnTarget: true,
      });
      generations.push(received.generation);
    }
  }
  return publishArtifactFiles(
    root,
    targets.flatMap(({ rows }) => rows),
    {
      destination,
      tag,
      generations,
      recordRelease: true,
    },
  );
}
