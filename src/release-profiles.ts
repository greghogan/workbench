import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { distributionRoot, readConfig, readLanguageRoots, writeAtomic } from "./core.js";
import { ownedPath } from "./paths.js";
import { runCommand } from "./checks.js";
import { hostOperatingSystem } from "./check-plan.js";
import { terminalTable } from "./terminal-table.js";
import { withDevelopmentSelection } from "./environments.js";
import type { ReleaseProfile } from "./profile-schema.js";

export function releasePlan(root: string, names?: string[], all = false) {
  if (all && names?.length) throw new Error("select profile names or --all");
  const configured = readConfig(root).release?.profiles ?? [];
  if (names && new Set(names).size !== names.length) throw new Error("duplicate release profile selection");
  for (const name of names ?? [])
    if (!configured.some((profile) => profile.name === name)) throw new Error(`unknown release profile '${name}'`);
  const roots = readLanguageRoots(root).map((entry) => entry.path);
  return configured
    .filter((profile) => !names?.length || names.includes(profile.name))
    .map((profile) => {
      if (!roots.includes(profile.path))
        throw new Error(`${profile.name}: release path must name a registered language root`);
      const directory = ownedPath(root, profile.path);
      for (const file of profile.builder === "nix"
        ? ["flake.nix", "flake.lock"]
        : profile.builder === "guix"
          ? ["channels.scm", "manifest.scm"]
          : [])
        if (!existsSync(ownedPath(directory, file)))
          throw new Error(`${profile.name}: missing locked builder input '${file}'`);
      return {
        ...profile,
        directory,
        output: ownedPath(root, `dist/releases/${profile.name}`),
        nativePlatform: profile.platform === `${hostOperatingSystem()}-${process.arch}`,
      };
    });
}

export function listReleaseProfiles(root: string, names?: string[], all = false, json = false): void {
  const profiles = releasePlan(root, names, all);
  if (json) console.log(JSON.stringify({ default: "all", profiles }, null, 2));
  else {
    console.log("Release preparation defaults to all configured profiles.");
    console.log(
      terminalTable(
        ["PROFILE", "ROOT", "BUILDER", "FORMAT", "PLATFORM", "EXECUTION"],
        profiles.map((profile) => [
          profile.name,
          profile.path,
          profile.builder,
          profile.format,
          profile.platform,
          profile.nativePlatform ? "native" : "requires a native target builder",
        ]),
      ),
    );
  }
}

function artifactFiles(directory: string, source = false) {
  const files: { path: string; type: string; mode: number; size: number; sha256: string }[] = [];
  const visit = (path: string) => {
    const metadata = lstatSync(path);
    if (metadata.isDirectory())
      for (const name of readdirSync(path).sort()) {
        if (
          source &&
          [
            ".git",
            "node_modules",
            "build",
            "dist",
            "coverage",
            "target",
            ".venv",
            "__pycache__",
            ".mypy_cache",
            ".ruff_cache",
            ".pytest_cache",
          ].includes(name)
        )
          continue;
        visit(join(path, name));
      }
    else if (metadata.isFile() || metadata.isSymbolicLink()) {
      const hash = createHash("sha256");
      if (metadata.isSymbolicLink()) {
        const target = relative(realpathSync(directory), realpathSync(path));
        if (isAbsolute(target) || target === ".." || target.startsWith(`..${sep}`))
          throw new Error(`${path}: release link escapes its artifact directory`);
        hash.update(readlinkSync(path));
      } else {
        const descriptor = openSync(path, "r");
        try {
          const buffer = Buffer.alloc(1024 * 1024);
          let length;
          while ((length = readSync(descriptor, buffer)) > 0) hash.update(buffer.subarray(0, length));
        } finally {
          closeSync(descriptor);
        }
      }
      files.push({
        path: relative(directory, path).replaceAll("\\", "/"),
        type: metadata.isSymbolicLink() ? "symlink" : "file",
        mode: metadata.mode & 0o777,
        size: metadata.size,
        sha256: hash.digest("hex"),
      });
    } else throw new Error(`${path}: release output must contain only real files and directories`);
  };
  visit(directory);
  if (!source && !files.length) throw new Error("release preparation produced no artifacts");
  return files;
}

function expand(command: string[], values: Record<string, string>): string[] {
  return command.map((part) =>
    part.replace(/\{(source|output|artifact|workbench|nix_image)\}/g, (_match, key: string) => values[key] ?? ""),
  );
}

function sourceRevision(root: string) {
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: root,
    encoding: "utf8",
  });
  return {
    revision: revision.status === 0 ? revision.stdout.trim() : null,
    dirty: status.status === 0 ? !!status.stdout.trim() : null,
  };
}

/** Preparation is local, with atomic acceptance only after outside-checkout behavioral verification. */
export function prepareReleases(root: string, names?: string[], all = false): void {
  const plan = releasePlan(root, names, all);
  if (!plan.length)
    throw new Error("no release profiles configured; declare release.profiles in workbench/config.toml");
  // Do not start some builds before discovering another profile would need emulation or cross execution.
  const foreign = plan.filter((profile) => !profile.nativePlatform);
  if (foreign.length)
    throw new Error(
      `release profiles require native target builders (no automatic emulation): ${foreign.map((profile) => `${profile.name} (${profile.platform})`).join(", ")}`,
    );
  const parent = ownedPath(root, "dist/releases");
  mkdirSync(parent, { recursive: true });
  const lock = ownedPath(parent, ".active");
  try {
    mkdirSync(lock);
  } catch (error) {
    throw new Error(`${lock}: release preparation may already be active; inspect before removing a stale lock`, {
      cause: error,
    });
  }
  const errors: string[] = [];
  try {
    for (const profile of plan) {
      const stage = ownedPath(parent, `.prepare-${profile.name}-${randomUUID()}`);
      let verification: string | undefined;
      try {
        if (existsSync(profile.output))
          throw new Error(
            `${profile.output}: release output already exists; preserve or explicitly remove it before preparing again`,
          );
        mkdirSync(stage, { mode: 0o700 });
        const verificationDirectory = mkdtempSync(join(tmpdir(), "workbench-release-profile-"));
        verification = verificationDirectory;
        const sources = artifactFiles(profile.directory, true);
        const configuration = readFileSync(join(root, "workbench/config.toml"));
        const values = {
          source: profile.directory,
          output: stage,
          artifact: stage,
          workbench: distributionRoot(root),
          nix_image: readConfig(root).checks?.nix_docker_image ?? "",
        };
        const env = { ...process.env };
        try {
          Object.assign(process.env, {
            WORKBENCH_RELEASE_OUTPUT: stage,
            WORKBENCH_RELEASE_FORMAT: profile.format,
            WORKBENCH_RELEASE_BUILDER: profile.builder,
            WORKBENCH_RELEASE_PLATFORM: profile.platform,
          });
          withDevelopmentSelection(root, "native", undefined, () => {
            runCommand(
              profile.directory,
              `prepare ${profile.name}`,
              expand(profile.prepare, values),
              true,
              "native",
              root,
              undefined,
              profile.builder === "native",
              true,
            );
          });
        } finally {
          for (const key of [
            "WORKBENCH_RELEASE_OUTPUT",
            "WORKBENCH_RELEASE_FORMAT",
            "WORKBENCH_RELEASE_BUILDER",
            "WORKBENCH_RELEASE_PLATFORM",
          ]) {
            if (env[key] === undefined) Reflect.deleteProperty(process.env, key);
            else process.env[key] = env[key];
          }
        }
        const files = artifactFiles(stage);
        if (files.some((file) => file.path === "workbench-release.json"))
          throw new Error("workbench-release.json is reserved for the release verification receipt");
        const artifact = join(verificationDirectory, "artifacts");
        cpSync(stage, artifact, { recursive: true, verbatimSymlinks: true });
        withDevelopmentSelection(root, "native", undefined, () => {
          runCommand(
            verificationDirectory,
            `verify ${profile.name}`,
            expand(profile.verify, { ...values, artifact }),
            true,
            "native",
            root,
            undefined,
            false,
          );
        });
        if (
          JSON.stringify(artifactFiles(stage)) !== JSON.stringify(files) ||
          JSON.stringify(artifactFiles(artifact)) !== JSON.stringify(files)
        )
          throw new Error("release artifacts changed during verification");
        if (
          JSON.stringify(artifactFiles(profile.directory, true)) !== JSON.stringify(sources) ||
          !readFileSync(join(root, "workbench/config.toml")).equals(configuration)
        )
          throw new Error("release source or configuration changed during preparation; retry with stable inputs");
        const inputs = ["flake.nix", "flake.lock", "channels.scm", "manifest.scm"].flatMap((file) => {
          const path = ownedPath(profile.directory, file);
          return existsSync(path)
            ? [{ path: file, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") }]
            : [];
        });
        writeAtomic(
          join(stage, "workbench-release.json"),
          JSON.stringify(
            {
              version: 1,
              profile: profile as ReleaseProfile,
              source: {
                ...sourceRevision(root),
                files: sources,
                configurationSha256: createHash("sha256").update(configuration).digest("hex"),
              },
              platform: profile.platform,
              builder: profile.builder,
              emulation: false,
              verified: true,
              inputs,
              artifacts: files,
            },
            null,
            2,
          ) + "\n",
        );
        renameSync(stage, profile.output);
        console.log(`Prepared and verified ${profile.name}: ${profile.output}`);
      } catch (error) {
        errors.push(`${profile.name}: ${error instanceof Error ? error.message : String(error)}`);
        console.error(errors.at(-1));
      } finally {
        if (verification) rmSync(verification, { recursive: true, force: true });
        rmSync(stage, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(lock, { recursive: true });
  }
  if (errors.length)
    throw new Error(`release preparation failed for ${String(errors.length)} profile(s):\n${errors.join("\n")}`);
}
