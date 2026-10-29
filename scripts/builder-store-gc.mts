import { isMainScript } from "./script-entry.mjs";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { withManagedProcesses } from "./managed-process.mjs";
import { diagnostic, LogLevel, DiagnosticOperation, DiagnosticOutcome } from "./diagnostics.mjs";

const inputIdentity = /^[a-f0-9]{64}$/;
type Builder = "nix" | "guix";

/** GC roots belong to this private store; publishing a new set never removes the previous working set first. */
export function retainStoreRoots(options: {
  store: string;
  directory: string;
  inputs: string;
  retained: readonly string[] | undefined;
  targets: readonly string[];
}): void {
  if (!inputIdentity.test(options.inputs) || options.retained?.some((value) => !inputIdentity.test(value)))
    throw new Error("Invalid builder store retention identity");
  const targets = [
    ...new Set(
      options.targets.map((target) => {
        const path = realpathSync(target);
        const local = relative(realpathSync(options.store), path);
        if (!local || isAbsolute(local) || local === ".." || local.startsWith(".." + sep))
          throw new Error(`Builder GC target is outside its store: ${target}`);
        const item = local.split(sep)[0];
        if (!item || !/^[a-z0-9]{32}-[^/]+$/.test(item)) throw new Error(`Invalid builder store target: ${target}`);
        return join(options.store, item);
      }),
    ),
  ];
  if (!targets.length) throw new Error("Builder GC requires retained runtime and profile roots");
  if (existsSync(options.directory) && !lstatSync(options.directory).isDirectory())
    throw new Error("Builder GC root namespace must be a real directory");
  mkdirSync(options.directory, { recursive: true });
  const marker = join(options.directory, ".workbench-roots.json");
  if (existsSync(marker)) {
    if (readFileSync(marker, "utf8") !== '{"version":1}\n') throw new Error("Invalid builder GC ownership marker");
  } else {
    if (readdirSync(options.directory).length) throw new Error("Builder GC root namespace is not owned by Workbench");
    // codeql[js/file-system-race] Exclusive creation (wx) rejects a concurrent marker; it cannot overwrite an existing file.
    writeFileSync(marker, '{"version":1}\n', { flag: "wx", mode: 0o600 });
  }
  const destination = join(options.directory, options.inputs);
  if (!existsSync(destination)) {
    const stage = join(options.directory, `.partial-${randomUUID()}`);
    mkdirSync(stage);
    try {
      targets.forEach((target, index) => {
        symlinkSync(target, join(stage, String(index)), lstatSync(target).isDirectory() ? "junction" : "file");
      });
      renameSync(stage, destination);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  } else {
    if (!lstatSync(destination).isDirectory()) throw new Error("Builder GC generation must be a real directory");
    const previous = readdirSync(destination).map((name) => {
      if (!/^\d+$/.test(name) || !lstatSync(join(destination, name)).isSymbolicLink())
        throw new Error("Builder GC generation contains unexpected files");
      return realpathSync(join(destination, name));
    });
    if (JSON.stringify(previous.sort()) !== JSON.stringify([...targets].sort()))
      throw new Error("Builder GC targets changed for the same image inputs");
  }
  if (options.retained === undefined) return; // Missing accepted-profile evidence preserves older roots.
  const keep = new Set([options.inputs, ...options.retained]);
  for (const name of readdirSync(options.directory)) {
    if (!inputIdentity.test(name) || keep.has(name)) continue;
    const directory = join(options.directory, name);
    if (!lstatSync(directory).isDirectory()) throw new Error("Builder GC generation must be a real directory");
    const files = readdirSync(directory);
    if (files.some((file) => !/^\d+$/.test(file) || !lstatSync(join(directory, file)).isSymbolicLink()))
      throw new Error("Builder GC generation contains unexpected files");
    rmSync(directory, { recursive: true });
  }
}

/** Only the owned Docker preparation path invokes collection; the host manager store is never selected here. */
export async function collectPrivateBuilderStore(builder: Builder): Promise<void> {
  if (!existsSync("/.dockerenv") || !/^[a-f0-9]{24}$/.test(process.env.WORKBENCH_PRIVATE_BUILDER ?? ""))
    throw new Error("Builder store GC requires an owned private Docker builder");
  const output = process.env.WORKBENCH_MANAGED_OUTPUT ?? "/output";
  const store = builder === "guix" ? "/gnu/store" : "/nix/store";
  const profiles: unknown = JSON.parse(
    readFileSync(join(output, builder === "guix" ? "guix-profiles.json" : "profiles.json"), "utf8"),
  );
  if (!Array.isArray(profiles)) throw new Error("Missing builder profile roots");
  const targets: string[] = profiles.flatMap((profile: unknown) => {
    if (builder === "nix" && typeof profile === "string") return [profile];
    if (
      builder === "guix" &&
      profile &&
      typeof profile === "object" &&
      "profile" in profile &&
      "runtime" in profile &&
      "manager" in profile &&
      typeof profile.profile === "string" &&
      typeof profile.runtime === "string" &&
      typeof profile.manager === "string"
    )
      return [profile.profile, profile.runtime, profile.manager];
    throw new Error("Invalid builder profile roots");
  });
  targets.push(readFileSync(join(output, "image-path"), "utf8").trim());
  targets.push(...(builder === "guix" ? ["/opt/workbench-guix"] : ["/opt/workbench-bootstrap", "/opt/nix-runtime"]));
  const retained: unknown =
    process.env.WORKBENCH_BUILDER_RETAIN_INPUTS === undefined
      ? undefined
      : JSON.parse(process.env.WORKBENCH_BUILDER_RETAIN_INPUTS);
  if (
    retained !== undefined &&
    (!Array.isArray(retained) || retained.some((value: unknown) => typeof value !== "string"))
  )
    throw new Error("Invalid retained builder profile identities");
  retainStoreRoots({
    store,
    directory: builder === "guix" ? "/var/guix/gcroots/workbench" : "/nix/var/nix/gcroots/workbench",
    inputs: process.env.WORKBENCH_IMAGE_INPUTS ?? "",
    retained: retained as string[] | undefined,
    targets,
  });
  if (process.env.WORKBENCH_BUILDER_GC === "true") {
    try {
      await withManagedProcesses(async (scope) => {
        await scope.run(
          builder === "guix" ? "/opt/workbench-guix/bin/guix" : "nix-store",
          builder === "guix" ? ["gc"] : ["--gc"],
        );
      });
    } catch (error) {
      diagnostic(
        LogLevel.Warn,
        DiagnosticOperation.Command,
        DiagnosticOutcome.Failed,
        { command: "private builder store cleanup" },
        error,
        "prepared output and durable profile roots are preserved",
      );
    }
  }
}

if (isMainScript(import.meta.url)) {
  const builder = process.argv[2];
  if (builder !== "guix" && builder !== "nix") throw new Error("Expected nix or guix builder");
  await collectPrivateBuilderStore(builder);
}
