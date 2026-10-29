import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pomDocument, pomChild, pomContents, pomXml, assertStandalonePom } from "./maven-pom.js";
import { readMavenMetadata, optionalMavenMetadata } from "./maven-files.js";
import { safeRelative } from "./files.js";
import { mavenArtifactPath, mavenChecksums, mavenDigest, verifyMavenArtifact } from "./maven-artifacts.js";
import { combineFailures } from "../scripts/diagnostic-errors.mjs";

export interface MavenSourceProject {
  root: string;
  pom: Buffer;
  checksums: Buffer | undefined;
  group: string;
  artifact: string;
  version: string;
  jar: string;
  pomPath: string;
  jarPath: string;
}
export interface MavenWorkspace {
  consumer: MavenSourceProject;
  sources: MavenSourceProject[];
}

/** Inspect identities, not Maven's effective model or dependency graph. Unsupported models remain explicit. */
export function readMavenSourceProject(
  root: string,
  captured?: { pom: Buffer; checksums: Buffer | undefined },
): MavenSourceProject {
  const pomFile = join(root, "pom.xml"),
    pom = captured?.pom ?? readMavenMetadata(pomFile),
    checksums = captured ? captured.checksums : optionalMavenMetadata(join(root, ".mvn/checksums/checksums.sha256")),
    model = pomDocument(pom.toString("utf8"));
  assertStandalonePom(model);
  const field = (name: string) => pomChild(model, name)?.text.trim();
  const coordinate = (key: string) => {
    const value = field(key) ?? "";
    if (!/^[A-Za-z0-9_+.-]+$/.test(value) || [".", "..", "LATEST", "RELEASE"].includes(value))
      throw new Error(`${pomFile}: source workspaces require a fixed literal ${key}`);
    return value;
  };
  const group = coordinate("groupId"),
    artifact = coordinate("artifactId"),
    version = coordinate("version");
  if ((field("packaging") ?? "jar") !== "jar")
    throw new Error(`${pomFile}: source workspaces currently support ordinary JAR projects only`);
  const build = pomChild(model, "build");
  const finalName = (build && pomChild(build, "finalName")?.text.trim()) ?? `${artifact}-${version}`;
  if (!/^[A-Za-z0-9_+.-]+$/.test(finalName) || finalName === "." || finalName === "..")
    throw new Error(`${pomFile}: source workspaces require a literal portable finalName`);
  const prefix = `${group.replaceAll(".", "/")}/${artifact}/${version}/${artifact}-${version}`;
  return {
    root,
    pom,
    checksums,
    group,
    artifact,
    version,
    jar: `${finalName}.jar`,
    pomPath: mavenArtifactPath(`${prefix}.pom`),
    jarPath: mavenArtifactPath(`${prefix}.jar`),
  };
}

function projectBoundary(root: string): string {
  let current = resolve(root);
  for (;;) {
    if (existsSync(join(current, "workbench/projects.toml")) || existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(root);
    current = parent;
  }
}
/** Maven owns source dependency graph resolution and reactor order. */
export function readMavenWorkspace(
  root: string,
  paths: readonly string[],
  boundary = projectBoundary(root),
  captured?: { pom: Buffer; checksums: Buffer | undefined },
): MavenWorkspace | undefined {
  if (!paths.length) return undefined;
  const project = realpathSync(boundary),
    consumer = readMavenSourceProject(realpathSync(root), captured);
  safeRelative(project, consumer.root);
  const seenRoots = new Set([consumer.root]);
  const sources = paths.map((path) => {
    if (!path || isAbsolute(path) || path.includes("\0"))
      throw new Error("Maven source paths must be project-relative directories");
    const input = resolve(root, path),
      directory = realpathSync(input);
    safeRelative(project, directory);
    if (lstatSync(input).isSymbolicLink() || !lstatSync(directory).isDirectory() || seenRoots.has(directory))
      throw new Error(`Duplicate or linked Maven source provider: ${path}`);
    seenRoots.add(directory);
    return readMavenSourceProject(directory);
  });
  const identities = new Set<string>();
  for (const module of [consumer, ...sources]) {
    const identity = `${module.group}:${module.artifact}:${module.version}`;
    if (identities.has(identity)) throw new Error(`Duplicate Maven source coordinates: ${identity}`);
    identities.add(identity);
  }
  return { consumer, sources };
}
export function mavenWorkspaceIdentity(
  workspace: MavenWorkspace,
): { path: string; pom: string; checksums: string | null; coordinate: string }[] {
  return workspace.sources.map((source) => ({
    path: relative(workspace.consumer.root, source.root).replaceAll("\\", "/"),
    pom: mavenDigest(source.pom),
    checksums: source.checksums ? mavenDigest(source.checksums) : null,
    coordinate: `${source.group}:${source.artifact}:${source.version}`,
  }));
}
export function mavenReactorPom(names: readonly string[]): string {
  if (names.some((name) => !/^[a-z][a-z0-9-]*$/.test(name))) throw new Error("Invalid private Maven module name");
  return `<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>workbench.invocation</groupId><artifactId>source-reactor</artifactId><version>1</version><packaging>pom</packaging><modules>${names.map((name) => `<module>${name}</module>`).join("")}</modules></project>\n`;
}
export function assertMavenWorkspaceExternalCoordinates(
  workspace: MavenWorkspace,
  external: ReadonlyMap<string, string>,
): void {
  for (const module of [workspace.consumer, ...workspace.sources]) {
    const prefix = module.pomPath.slice(0, module.pomPath.lastIndexOf("/") + 1);
    if ([...external.keys()].some((path) => path.startsWith(prefix)))
      throw new Error(`Source coordinates must not appear in the external Maven checksum index: ${prefix}`);
  }
}

/** Only verified frozen inputs enter this new repository; no shared metadata or project installations are adopted. */
export async function prepareMavenCheckRepository(
  shared: string,
  checksums: ReadonlyMap<string, string>,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  mkdirSync(destination);
  try {
    const directories = new Map<string, string[]>(),
      versions = new Map<string, Set<string>>();
    for (const path of checksums.keys()) {
      signal?.throwIfAborted();
      mavenArtifactPath(path);
      const target = join(destination, path);
      mkdirSync(dirname(target), { recursive: true });
      await verifyMavenArtifact(shared, path, checksums, target, signal);
      const names = directories.get(dirname(target)) ?? [];
      names.push(basename(target));
      directories.set(dirname(target), names);
      const parts = path.split("/"),
        ga = parts.slice(0, -2).join("/");
      const version = parts.at(-2);
      if (!version) throw new Error("Missing frozen Maven version");
      const entries = versions.get(ga) ?? new Set<string>();
      entries.add(version);
      versions.set(ga, entries);
    }
    for (const [directory, files] of directories)
      writeFileSync(join(directory, "_remote.repositories"), files.map((name) => `${name}>=\n`).join(""));
    for (const [ga, entries] of versions) {
      const parts = ga.split("/"),
        artifact = parts.pop();
      writeFileSync(
        join(destination, ga, "maven-metadata-local.xml"),
        `<metadata><groupId>${parts.join(".")}</groupId><artifactId>${artifact ?? ""}</artifactId><versioning><versions>${[
          ...entries,
        ]
          .sort()
          .map((version) => `<version>${version}</version>`)
          .join("")}</versions></versioning></metadata>\n`,
      );
    }
  } catch (error) {
    try {
      rmSync(destination, { recursive: true });
    } catch (cleanup) {
      throw combineFailures(error, cleanup, "Private Maven repository preparation and cleanup failed");
    }
    throw error;
  }
}

/** Override only invocation-owned standard properties; authoritative project POMs stay untouched. */
export function mavenInvocationPom(pom: Buffer, properties: Readonly<Record<string, string>>): Buffer {
  const text = pom.toString("utf8"),
    model = pomDocument(text),
    existing = pomChild(model, "properties");
  const changes: { start: number; end: number; text: string }[] = [];
  const prefix = (existing?.qualifiedName ?? model.qualifiedName).replace(/[^:]+$/u, "");
  let missing = "";
  for (const [name, value] of Object.entries(properties)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) throw new Error("Invalid Maven invocation property");
    const entry = existing && pomChild(existing, name),
      qualified = entry?.qualifiedName ?? prefix + name,
      content = `<${qualified}>${pomXml(value)}</${qualified}>`;
    if (entry) changes.push({ start: entry.start, end: entry.end, text: content });
    else missing += content;
  }
  if (missing) {
    if (existing?.selfClosing)
      changes.push({ start: existing.start, end: existing.end, text: pomContents(text, existing, missing) });
    else if (existing) changes.push({ start: existing.closeStart, end: existing.closeStart, text: missing });
    else {
      const content = `<${prefix}properties>${missing}</${prefix}properties>`;
      changes.push(
        model.selfClosing
          ? { start: model.start, end: model.end, text: pomContents(text, model, content) }
          : { start: model.closeStart, end: model.closeStart, text: content },
      );
    }
  }
  let result = text;
  for (const change of changes.sort((a, b) => b.start - a.start))
    result = result.slice(0, change.start) + change.text + result.slice(change.end);
  return Buffer.from(result);
}
export function mavenWorkspaceExternalChecksums(workspace: MavenWorkspace): Map<string, string> {
  const combined = new Map<string, string>();
  for (const module of [workspace.consumer, ...workspace.sources]) {
    const path = join(module.root, ".mvn/checksums/checksums.sha256");
    if (module.checksums === undefined)
      throw new Error(`${path}: source workspaces require reviewed external checksums for each module`);
    for (const [artifact, hash] of mavenChecksums(module.checksums.toString("utf8"))) {
      if (combined.has(artifact) && combined.get(artifact) !== hash)
        throw new Error(`Conflicting frozen Maven checksums: ${artifact}`);
      combined.set(artifact, hash);
    }
  }
  return combined;
}
