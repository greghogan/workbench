import { openPromise, type Entry } from "yauzl";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { packageOutputAsync } from "./package-output.js";
import {
  captureMavenSourceArtifact,
  mavenArtifactPath,
  mavenChecksums,
  verifyMavenArtifact,
} from "./maven-artifacts.js";

export interface JavaRuntime {
  kind: "application" | "library";
  nativeAccess: string[];
  modules: string[];
}

export function decodeJavaRuntime(input: unknown, distribution = false): JavaRuntime {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Java runtime requires an application/library kind and optional module/nativeAccess names");
  const value = input as Record<string, unknown>;
  if (
    (value.kind !== "application" && value.kind !== "library") ||
    Object.keys(value).some(
      (key) => !["kind", "nativeAccess", "modules", ...(distribution ? ["artifacts"] : [])].includes(key),
    )
  )
    throw new Error("Java runtime requires an application/library kind and optional module/nativeAccess names");
  const names = (field: "modules" | "nativeAccess"): string[] => {
    const list = value[field] === undefined ? [] : value[field];
    if (
      !Array.isArray(list) ||
      list.some(
        (name: unknown) =>
          typeof name !== "string" ||
          (!(field === "nativeAccess" && name === "ALL-UNNAMED") &&
            !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(name)),
      ) ||
      new Set(list).size !== list.length
    )
      throw new Error(`Java runtime ${field} requires distinct supported module names`);
    return list as string[];
  };
  return { kind: value.kind, nativeAccess: names("nativeAccess"), modules: names("modules") };
}
export function javaRuntime(root: string): JavaRuntime {
  const path = join(root, ".mvn/runtime.json");
  return decodeJavaRuntime(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { kind: "application" });
}

export function javaRuntimeArguments(runtime: JavaRuntime): string[] {
  return [
    ...(runtime.nativeAccess.length ? [`--enable-native-access=${runtime.nativeAccess.join(",")}`] : []),
    ...(runtime.modules.length ? [`--add-modules=${runtime.modules.join(",")}`] : []),
  ];
}

/** Read only the bounded main manifest, using the shared ZIP dependency rather than extracting a JAR. */
export async function javaManifest(path: string): Promise<Map<string, string>> {
  const zip = await openPromise(path, { lazyEntries: true, autoClose: false });
  try {
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      let manifest: Buffer | undefined;
      zip.on("error", reject);
      zip.on("end", () => {
        if (manifest) resolve(manifest);
        else reject(new Error("Java release has no manifest"));
      });
      zip.on("entry", (entry: Entry) => {
        if (entry.fileName !== "META-INF/MANIFEST.MF") {
          zip.readEntry();
          return;
        }
        if (manifest || entry.uncompressedSize > 64 * 1024) {
          reject(new Error("Duplicate or oversized Java manifest"));
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error) {
            reject(error);
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on("error", reject);
          stream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 64 * 1024) {
              stream.destroy(new Error("Java manifest exceeds its limit"));
              return;
            }
            chunks.push(chunk);
          });
          stream.on("end", () => {
            manifest = Buffer.concat(chunks);
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
    const entries = new Map<string, string>();
    for (const line of bytes
      .toString("utf8")
      .replace(/\r?\n /g, "")
      .split(/\r?\n\r?\n/)[0]
      ?.split(/\r?\n/) ?? []) {
      if (!line) continue;
      const match = /^([^:]+): (.*)$/.exec(line);
      if (!match?.[1] || match[2] === undefined || entries.has(match[1].toLowerCase()))
        throw new Error("Invalid Java manifest");
      entries.set(match[1].toLowerCase(), match[2]);
    }
    return entries;
  } finally {
    zip.close();
  }
}

export function javaRuntimeClosure(manifest: ReadonlyMap<string, string>): string[] {
  const entries = (manifest.get("class-path") ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((entry) => {
      if (!entry.startsWith("lib/")) throw new Error("Java runtime classpath must use relative lib/ repository paths");
      return mavenArtifactPath(entry.slice(4));
    });
  if (new Set(entries).size !== entries.length || entries.some((entry) => !entry.endsWith(".jar")))
    throw new Error("Invalid Java runtime closure");
  return entries;
}

/** Maven owns the runtime graph; packaging copies its exact verified bytes, including embedded upstream licenses. */
export type JavaSourceArtifacts = ReadonlyMap<string, string>;
export async function packageJavaRelease(
  root: string,
  jar: string,
  repository: string,
  output: string,
  options: {
    sourceArtifacts?: JavaSourceArtifacts;
    externalChecksums?: ReadonlyMap<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  const runtime = javaRuntime(root);
  const manifest = await javaManifest(jar);
  if (runtime.kind === "library" && manifest.get("class-path")?.trim())
    throw new Error("Thin Java libraries must not declare an application runtime classpath");
  if (runtime.kind === "application" && !manifest.get("main-class"))
    throw new Error("Java application release requires Main-Class");
  const closure = runtime.kind === "library" ? [] : javaRuntimeClosure(manifest);
  const checksums =
    options.externalChecksums ?? mavenChecksums(readFileSync(join(root, ".mvn/checksums/checksums.sha256"), "utf8"));
  if (options.sourceArtifacts)
    for (const path of options.sourceArtifacts.keys())
      if (checksums.has(path)) throw new Error(`Source Maven artifact collides with an external checksum: ${path}`);
  const copy = async (path: string, target: string) => {
    options.signal?.throwIfAborted();
    const source = options.sourceArtifacts?.get(path);
    if (source) {
      const input = lstatSync(source);
      if (!input.isFile() || input.isSymbolicLink())
        throw new Error(`Source Maven artifact must be a regular file: ${path}`);
      return captureMavenSourceArtifact(source, target, options.signal);
    }
    return verifyMavenArtifact(repository, path, checksums, target, options.signal);
  };
  const destination = resolve(output);
  await packageOutputAsync(root, destination, async (scratch) => {
    options.signal?.throwIfAborted();
    writeFileSync(join(scratch, basename(jar)), readFileSync(jar));
    const inventory = [];
    const copiedPoms = new Set<string>();
    for (const path of closure) {
      const target = join(scratch, "lib", path);
      mkdirSync(dirname(target), { recursive: true });
      if (
        options.sourceArtifacts?.has(path) &&
        (await javaManifest(options.sourceArtifacts.get(path) ?? "")).get("class-path")?.trim()
      )
        throw new Error(`Source JAR runtime dependencies must be thin libraries: ${path}`);
      const sha256 = await copy(path, target);
      // Keep publisher license declarations with the original, unmodified JAR (including META-INF notices).
      const parts = path.split("/");
      const pom = `${path.slice(0, path.lastIndexOf("/") + 1)}${parts.at(-3) ?? ""}-${parts.at(-2) ?? ""}.pom`;
      if (!copiedPoms.has(pom)) {
        await copy(pom, join(dirname(target), basename(pom)));
        copiedPoms.add(pom);
      }
      inventory.push({
        path: `lib/${path}`,
        sha256,
        pom: `lib/${pom}`,
        ...(options.sourceArtifacts?.has(path) ? { source: true } : {}),
      });
    }
    const license = join(root, "LICENSE");
    if (existsSync(license)) writeFileSync(join(scratch, "LICENSE"), readFileSync(license));
    writeFileSync(join(scratch, "runtime.json"), JSON.stringify({ ...runtime, artifacts: inventory }, null, 2) + "\n");
    if (runtime.kind === "application") {
      const flags = javaRuntimeArguments(runtime).join(" ");
      const name = basename(jar);
      if (!/^[A-Za-z0-9._-]+\.jar$/.test(name)) throw new Error("Java release JAR name must be portable");
      writeFileSync(
        join(scratch, "run"),
        `#!/bin/sh\nset -eu\nworkbench_java_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec java ${flags} -jar "$workbench_java_dir/${name}" "$@"\n`,
        { mode: 0o755 },
      );
      writeFileSync(join(scratch, "run.cmd"), `@echo off\r\njava ${flags} -jar "%~dp0${name}" %*\r\n`, {
        mode: 0o644,
      });
    }
    chmodSync(scratch, 0o755);
    options.signal?.throwIfAborted();
  });
}
