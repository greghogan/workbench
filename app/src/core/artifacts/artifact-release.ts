import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import {
  isReleaseTag,
  readArtifactCatalog,
  withArtifactTag,
  type ArtifactDestination,
  type ArtifactPlanEntry,
} from "./artifact-catalog.js";
import {
  artifactSourceRevision,
  inspectFileArtifact,
  inspectFileArtifactGenerations,
  selectFileArtifacts,
  stagePublishedFileArtifact,
} from "./artifact-files.js";
import { GitHubRelease, publishGitHubFiles } from "./github-release.mts";
import { publishGitLabFiles, type ReleaseFile } from "./gitlab-release.js";
import { gitRevision } from "../git/refs.js";
import { hashFile } from "../runtime/file-reads.js";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { processCancellation } from "../runtime/owned-child.mjs";
import { addRelease } from "../records/releases.js";

export function artifactDestination(root: string, name: string, alternate?: string): ArtifactDestination {
  const destinations = readArtifactCatalog(root, alternate).destinations;
  const destination = Object.hasOwn(destinations, name) ? destinations[name] : undefined;
  if (!destination) throw new InvalidInput(`Unknown artifact destination '${name}'`);
  return destination;
}

export function verifiedReleaseSource(root: string, tag: string): string {
  if (!isReleaseTag(tag)) throw new InvalidInput("Select a version tag");
  const revision = gitRevision(root, `refs/tags/${tag}^{commit}`);
  if (!revision || revision !== gitRevision(root, "HEAD"))
    throw new StateConflict("Check out the reviewed version tag before preparing and publishing release files");
  if (artifactSourceRevision(root) !== revision)
    throw new StateConflict("Publication requires the committed source and a clean checkout");
  return revision;
}

export function releaseVariant({ profile, target, format }: ArtifactPlanEntry): string {
  return `${profile}.${target}.${format}`;
}

export async function publishArtifactFiles(
  root: string,
  rows: readonly ArtifactPlanEntry[],
  options: {
    destination: ArtifactDestination;
    tag: string;
    summary?: string;
    toolchain?: string;
    generations?: readonly string[];
    builtGenerations?: readonly string[];
    recordRelease?: boolean;
  },
) {
  const { destination, tag, toolchain, generations, builtGenerations } = options;
  if (destination.kind === "registry")
    throw new InvalidInput("Select a GitHub or GitLab destination for release files");
  const revision = verifiedReleaseSource(root, tag);
  if (!rows.length || rows.some((row) => row.kind !== "release"))
    throw new InvalidInput("Hosted releases accept verified release artifacts");
  const selected = rows.map((row) => withArtifactTag(row, tag));
  if (builtGenerations && builtGenerations.length !== selected.length)
    throw new StateConflict("Every selected release recipe must finish building before publication");
  const candidates = builtGenerations
    ? selected.map((row, index) => ({
        row,
        artifact: inspectFileArtifact(root, row, toolchain, builtGenerations[index]),
      }))
    : generations?.length
      ? inspectFileArtifactGenerations(root, selected, generations, toolchain)
      : selectFileArtifacts(root, selected, toolchain);
  const owners = new Set(candidates.map(({ row }) => row.definition.owner));
  if (options.recordRelease && owners.size !== 1) throw new InvalidInput("Publish one project per release record");
  if (new Set(candidates.map(({ row }) => releaseVariant(row))).size !== candidates.length)
    throw new InvalidInput("Select one release artifact per profile, target, and format");
  const scratch = mkdtempSync(join(tmpdir(), "workbench-publish-artifacts-"));
  const cancellation = processCancellation();
  try {
    const publication: (ReleaseFile & { name: string; target: string })[] = [];
    for (const { row, artifact } of candidates) {
      if (artifact?.manifest.revision !== revision)
        throw new StateConflict(`${row.profile}: use a verified build or import for ${tag}`);
      if (artifact.manifest.verification?.revision !== revision)
        throw new StateConflict(
          `${row.profile}: verify this artifact on its target from the reviewed source for ${tag}`,
        );
      const target = releaseVariant(row);
      const name = `${target}.${artifact.manifest.file.slice("artifact.".length)}`;
      const staged = join(scratch, name);
      await stagePublishedFileArtifact(artifact, staged);
      const { sha256, bytes } = artifact.manifest;
      if (hashFile(staged, bytes, "publication asset") !== sha256)
        throw new StateConflict(`${name}: file changed while staging publication`);
      publication.push({ name, path: staged, sha256, bytes, target });
    }
    const summary = options.summary ?? `Release ${tag}`;
    if (!summary.trim() || /[\r\n]/.test(summary)) throw new InvalidInput("Use a one-line release summary");
    const marker = [
      summary,
      "",
      `Source: ${revision}`,
      ...publication.map(({ name, sha256 }) => `SHA-256 ${name}: ${sha256}`).sort(),
    ].join("\n");
    let urls: string[];
    if (destination.kind === "github") {
      const github = new GitHubRelease(destination.repository, process.env, cancellation.signal);
      await publishGitHubFiles(
        github,
        tag,
        revision,
        marker,
        publication.map((file) => file.path),
        scratch,
        true,
      );
      urls = publication.map(({ name }) => github.assetURL(tag, name));
    } else {
      urls = await publishGitLabFiles(destination, tag, revision, marker, publication, cancellation.signal);
    }
    const artifacts = publication.map((file, index) => {
      const url = urls[index];
      if (!url) throw new Error("Hosted publisher did not return the artifact URL");
      return { target: file.target, path: file.path, url };
    });
    let release: string | undefined;
    if (options.recordRelease) {
      const specification = join(scratch, "release.yaml");
      writeFileSync(
        specification,
        stringify({
          version: tag.replace(/^v/, ""),
          tag,
          revision,
          released: new Date().toISOString().slice(0, 10),
          notes: { summary, changes: [] },
          artifacts,
        }),
      );
      release = await addRelease(root, specification, [...owners][0]);
    }
    return {
      revision,
      tag,
      release,
      artifacts: publication.map(({ name, target, sha256, bytes }, index) => ({
        name,
        target,
        sha256,
        bytes,
        url: urls[index],
      })),
    };
  } finally {
    cancellation.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}
