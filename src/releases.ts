import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { readProjects, readText, rootOf, scan, writeAtomic, type Project } from "./core.js";
import { createRecord } from "./records.js";

interface Notes {
  summary: string;
  changes?: string[];
}
interface Artifact {
  target: string;
  file: string;
  url: string;
  bytes: number;
  sha256: string;
}
interface Release {
  id: string;
  version: string;
  revision: string;
  tag: string;
  released: string;
  yanked: boolean;
  notes: Notes;
  artifacts: Artifact[];
}

function token(value: unknown, name: string, path: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    /\s/.test(value) ||
    value.split("").some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error(`${path}: '${name}' must be one nonempty token`);
  }
}
function oneLine(value: unknown, name: string, path: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) {
    throw new Error(`${path}: '${name}' must be one nonempty line`);
  }
}
function identity(document: Partial<Release>, path: string): void {
  token(document.version, "version", path);
  token(document.tag, "tag", path);
  token(document.revision, "revision", path);
  token(document.released, "released", path);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(document.revision)) {
    throw new Error(`${path}: 'revision' must be a 40- or 64-character lowercase hexadecimal identity`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(document.released)) throw new Error(`${path}: 'released' must use YYYY-MM-DD`);
  oneLine(document.notes?.summary, "notes.summary", path);
  if (!Array.isArray(document.notes.changes)) throw new Error(`${path}: 'notes.changes' must be an array`);
  for (const change of document.notes.changes) oneLine(change, "notes.changes entry", path);
}
function validateArtifacts(artifacts: Partial<Artifact>[] | undefined, path: string): void {
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error(`${path}: 'artifacts' must be nonempty`);
  const targets = new Set<string>();
  for (const artifact of artifacts) {
    token(artifact.target, "artifacts.target", path);
    token(artifact.file, "artifacts.file", path);
    if (targets.has(artifact.target)) throw new Error(`${path}: duplicate artifact target '${artifact.target}'`);
    targets.add(artifact.target);
    if (
      !artifact.url?.startsWith("https://") ||
      /\s/.test(artifact.url) ||
      !artifact.url.endsWith(`/${artifact.file}`)
    ) {
      throw new Error(`${path}: artifact 'url' must be HTTPS and end with its filename`);
    }
    if (typeof artifact.bytes !== "number" || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0)
      throw new Error(`${path}: artifact 'bytes' must be positive`);
    if (typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256))
      throw new Error(`${path}: artifact 'sha256' must be lowercase hexadecimal`);
  }
}
export function parseRelease(contents: string, path: string, number?: string): Release {
  let document: Partial<Release> | null;
  try {
    document = yamlParse(contents) as Partial<Release> | null;
  } catch (error) {
    throw new Error(`${path}: invalid release YAML: ${String(error)}`, { cause: error });
  }
  if (!document || typeof document !== "object" || Array.isArray(document))
    throw new Error(`${path}: expected a release mapping`);
  if (number !== undefined && (!document.id?.endsWith(`-REL-${number}`) || document.id === `-REL-${number}`)) {
    throw new Error(`${path}: 'id' must end with '-REL-${number}' and include a project ID`);
  }
  identity(document, path);
  validateArtifacts(document.artifacts, path);
  return document as Release;
}

export function sha256(path: string): string {
  const file = openSync(path, "r");
  try {
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(65536);
    for (;;) {
      const count = readSync(file, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
    }
    return digest.digest("hex");
  } finally {
    closeSync(file);
  }
}

export async function addRelease(root: string, specificationPath: string, projectId?: string): Promise<string> {
  const specification = yamlParse(readText(specificationPath)) as {
    version: string;
    revision: string;
    tag: string;
    released: string;
    notes: Notes;
    artifacts: { target: string; path: string; url: string }[];
  };
  const pseudo = { ...specification, id: "draft-REL-0", yanked: false } as unknown as Partial<Release>;
  identity(pseudo, specificationPath);
  if (!Array.isArray(specification.artifacts) || specification.artifacts.length === 0) {
    throw new Error(`${specificationPath}: 'artifacts' must be nonempty`);
  }
  const artifacts = specification.artifacts.map((input) => {
    const path = isAbsolute(input.path) ? input.path : join(dirname(specificationPath), input.path);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error(`${path}: artifact must be a regular, non-symlink file`);
    return { target: input.target, file: basename(path), url: input.url, bytes: metadata.size, sha256: sha256(path) };
  });
  validateArtifacts(artifacts, specificationPath);
  return createRecord(root, "REL", projectId, (number, project) =>
    yamlStringify({
      id: `${project.id}-REL-${number}`,
      version: specification.version,
      revision: specification.revision,
      tag: specification.tag,
      released: specification.released,
      yanked: false,
      notes: specification.notes,
      artifacts,
    }),
  );
}

export function renderReleaseIndex(root: string, project: Project): string {
  let output = "# version\ttarget\turl\tbytes\tsha256\treference\n";
  const seen = new Set<string>();
  for (const record of scan(rootOf(root, project), "REL")) {
    const document = parseRelease(readText(record.path), record.path, record.number);
    if (document.yanked) continue;
    for (const artifact of document.artifacts) {
      const identity = `${document.version}\u0000${artifact.target}`;
      if (seen.has(identity)) throw new Error(`${record.path}: duplicate release version and target`);
      seen.add(identity);
      output +=
        `${document.version}\t${artifact.target}\t${artifact.url}\t${String(artifact.bytes)}\t${artifact.sha256}\t` +
        `${project.id}:REL-${record.number}\n`;
    }
  }
  return output;
}

export function syncReleaseIndexes(root: string, checkOnly = false): string[] {
  const changed: string[] = [];
  for (const project of readProjects(root)) {
    const path = join(rootOf(root, project), "workbench/release-index.tsv");
    const expected = renderReleaseIndex(root, project);
    const actual = existsSync(path) ? readText(path) : undefined;
    if (actual === expected) continue;
    if (checkOnly) throw new Error(`${path}: release index is missing or stale; run 'workbench sync'`);
    writeAtomic(path, expected);
    changed.push(path);
  }
  return changed;
}
