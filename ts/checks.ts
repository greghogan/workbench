import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { readConfig, readLanguageRoots, readProjects, rootOf, type Project } from "./core.js";
import { catalog } from "./languages.js";

export type CheckEnvironment = "none" | "guix" | "nix" | "nix-docker";
export type ConfiguredCheck = {
  name: string;
  role: string;
  command: string[];
  project: Project;
  directory: string;
  location: string;
  heavy: boolean;
  environment: CheckEnvironment;
  dockerImage: string | undefined;
};
const validRole = /^[a-z][a-z0-9-]*$/;

function environment(value: unknown, context: string): CheckEnvironment {
  if (value !== "none" && value !== "guix" && value !== "nix" && value !== "nix-docker") {
    throw new Error(`${context} must be 'none', 'guix', 'nix', or 'nix-docker'`);
  }
  return value;
}

export function readChecks(root: string): ConfiguredCheck[] {
  const config = readConfig(root);
  const projects = readProjects(root);
  const defaultEnvironment = environment(config.checks?.environment ?? "none", "checks.environment");
  const dockerImage = config.checks?.nix_docker_image;
  if (
    dockerImage !== undefined &&
    (typeof dockerImage !== "string" || !/^[^\s]+@sha256:[0-9a-f]{64}$/.test(dockerImage))
  )
    throw new Error("checks.nix_docker_image must be an image pinned by SHA-256 digest");
  if (defaultEnvironment === "nix-docker" && !dockerImage)
    throw new Error("checks.nix_docker_image is required for 'nix-docker'");
  const seen = new Set<string>();
  return (config.check ?? []).map((entry) => {
    if (!entry.name?.trim() || seen.has(entry.name)) throw new Error("every check needs a unique nonempty name");
    seen.add(entry.name);
    const role = entry.role ?? "custom";
    if (!validRole.test(role)) throw new Error(`check '${entry.name}' has an invalid role`);
    if (
      !Array.isArray(entry.command) ||
      !entry.command.length ||
      entry.command.some((arg) => typeof arg !== "string" || !arg)
    ) {
      throw new Error(`check '${entry.name}' needs a nonempty command array`);
    }
    const project = projects.find((candidate) => candidate.id === (entry.project ?? projects[0]?.id));
    if (!project) throw new Error(`check '${entry.name}' names unknown project '${entry.project}'`);
    if (
      entry.path !== undefined &&
      (entry.project !== undefined ||
        (entry.path !== "." &&
          (isAbsolute(entry.path) ||
            entry.path.includes("\\") ||
            entry.path
              .split(/[\\/]/)
              .some(
                (part) =>
                  !part ||
                  part === "." ||
                  part === ".." ||
                  [".git", ".workbench", "workbench", "target", "libexec"].includes(part),
              ))))
    )
      throw new Error(`check '${entry.name}' has an unsafe or ambiguous path`);
    if (entry.path && entry.path !== ".") {
      let directory = root;
      for (const component of entry.path.split("/")) {
        directory = join(directory, component);
        if (!existsSync(directory) || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
          throw new Error(`check '${entry.name}' path must be a real directory`);
      }
    }
    if (entry.heavy !== undefined && typeof entry.heavy !== "boolean")
      throw new Error(`check '${entry.name}' heavy must be Boolean`);
    const selectedEnvironment = environment(
      entry.environment ?? defaultEnvironment,
      `check '${entry.name}' environment`,
    );
    if (selectedEnvironment === "nix-docker" && !dockerImage)
      throw new Error(`check '${entry.name}' needs checks.nix_docker_image`);
    return {
      name: entry.name,
      role,
      command: entry.command,
      project,
      directory: entry.path === undefined ? rootOf(root, project) : join(root, entry.path),
      location: entry.path ?? project.id,
      heavy: !!entry.heavy,
      environment: selectedEnvironment,
      dockerImage,
    };
  });
}

function available(command: string): boolean {
  return (process.env.PATH ?? "").split(delimiter).some((directory) => {
    const path = join(directory, command);
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
}

function wrapped(
  directory: string,
  selected: CheckEnvironment,
  command: string[],
  repositoryRoot?: string,
  dockerImage?: string,
): string[] {
  if (selected === "none") return command;
  if (selected === "guix") {
    for (const file of ["channels.scm", "manifest.scm"]) {
      if (!existsSync(join(directory, file))) throw new Error(`${directory}: Guix check environment needs '${file}'`);
    }
    return [
      "guix",
      "time-machine",
      "-C",
      "channels.scm",
      "--",
      "shell",
      "--container",
      "--emulate-fhs",
      "--network",
      "--preserve=^WORKBENCH_PROJECT_ROOT$",
      "-m",
      "manifest.scm",
      "--",
      ...command,
    ];
  }
  for (const file of ["flake.nix", "flake.lock"]) {
    if (!existsSync(join(directory, file))) throw new Error(`${directory}: Nix check environment needs '${file}'`);
  }
  if (selected === "nix-docker") {
    if (!dockerImage) throw new Error("nix-docker requires checks.nix_docker_image");
    const source = resolve(repositoryRoot ?? directory);
    const subdirectory = relative(source, resolve(directory));
    if (subdirectory === ".." || subdirectory.startsWith(`..${sep}`) || isAbsolute(subdirectory))
      throw new Error(`${directory}: check root is outside the project tree`);
    if (source.includes(",")) throw new Error(`${source}: Docker bind mounts do not support commas in the source path`);
    const digest = dockerImage.split("@sha256:")[1]!;
    return [
      "docker",
      "run",
      "--rm",
      "--mount",
      `type=bind,src=${source},dst=/source,readonly`,
      "--mount",
      `type=volume,src=workbench-nix-${digest.slice(0, 16)},dst=/nix`,
      "--env",
      "WORKBENCH_PROJECT_ROOT=/work",
      dockerImage,
      "sh",
      "-ceu",
      'mkdir -p /work; cp -a /source/. /work/; cd "$1"; shift; exec nix --extra-experimental-features "nix-command flakes" develop --ignore-environment --keep WORKBENCH_PROJECT_ROOT --command "$@"',
      "workbench-nix-docker",
      join("/work", subdirectory),
      ...command,
    ];
  }
  return [
    "nix",
    "--extra-experimental-features",
    "nix-command flakes",
    "develop",
    "--ignore-environment",
    "--keep",
    "WORKBENCH_PROJECT_ROOT",
    "--command",
    ...command,
  ];
}

export function runCommand(
  directory: string,
  name: string,
  command: string[],
  heavy = false,
  selected: CheckEnvironment = "none",
  repositoryRoot?: string,
  dockerImage?: string,
): void {
  const invocation = wrapped(directory, selected, command, repositoryRoot, dockerImage);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(repositoryRoot ? { WORKBENCH_PROJECT_ROOT: repositoryRoot } : {}),
  };
  if (selected === "guix") delete env.GUIX_BUILD_OPTIONS;
  if (heavy && available("benchctl")) {
    const submit = spawnSync("benchctl", ["hold", "--format", "text", "--", ...invocation], {
      cwd: directory,
      env,
      encoding: "utf8",
    });
    if (submit.error || submit.status !== 0)
      throw new Error(`${name} could not submit to benchd: ${submit.stderr || submit.error}`);
    const job = submit.stdout.trim();
    if (!/^[0-9a-f]+$/.test(job)) throw new Error(`${name} received an invalid benchd job ID`);
    const follow = spawnSync("benchctl", ["follow", "--format", "text", job], {
      cwd: directory,
      env,
      stdio: "inherit",
    });
    if (follow.error || follow.status !== 0) throw new Error(`${name} failed in benchd job ${job}`);
    return;
  }
  const result = spawnSync(invocation[0]!, invocation.slice(1), { cwd: directory, env, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`${name} failed with ${result.error ?? result.status}`);
}

function containsShell(directory: string, depth = 4): boolean {
  if (depth === 0 || !existsSync(directory)) return false;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isFile() && (extname(entry.name) === ".sh" || entry.name === ".envrc")) return true;
    if (
      entry.isDirectory() &&
      ![".git", ".workbench", "target", "node_modules"].includes(entry.name) &&
      containsShell(path, depth - 1)
    )
      return true;
  }
  return false;
}

export function listChecks(root: string): void {
  console.log("built-in: Workbench records, maps, generated agent context, and Markdown");
  console.log("adapter checks: pending whitespace, merge markers, private keys, and change messages");
  const languages = catalog(root);
  for (const entry of readLanguageRoots(root)) {
    const id = entry.language;
    const language = languages.find((candidate) => candidate.id === id);
    if (!language) {
      console.log(`language guidance for ${entry.path} (${id}): no built-in reference project`);
      continue;
    }
    console.log(
      `language guidance for ${entry.path} (${language.name}): ${language.summary}; reference: ${language.reference}`,
    );
    for (const check of language.check) {
      console.log(`  recommended role ${check.role}${check.heavy ? ", heavy" : ""}: ${check.command.join(" ")}`);
    }
  }
  for (const project of readProjects(root)) {
    if (containsShell(rootOf(root, project)))
      console.log(`inferred for ${project.id}: shell formatting, syntax, and ShellCheck`);
  }
  for (const check of readChecks(root)) {
    console.log(
      `configured: ${check.name} (role: ${check.role}, root: ${check.location}, ` +
        `environment: ${check.environment}${check.heavy ? ", heavy" : ""}): ${check.command.join(" ")}`,
    );
  }
}

export function runChecks(root: string, role?: string): void {
  const selected = readChecks(root).filter((check) => !role || check.role === role);
  if (role && !selected.length) throw new Error(`no configured checks have role '${role}'`);
  for (const check of selected) {
    console.log(`Running configured check '${check.name}'...`);
    runCommand(
      check.directory,
      `configured check '${check.name}'`,
      check.command,
      check.heavy,
      check.environment,
      root,
      check.dockerImage,
    );
  }
}
