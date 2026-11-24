import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { captureCheckSource, committedCheckCoverage, fileDigest, inputDigest } from "./check-inputs.js";
import { materializeCheckSource } from "./check-source-view.js";
import { distributionRoot } from "../../projects/project-context.js";
import { createOwnedScratch } from "../../runtime/owned-scratch.mjs";
import { quote, resolveCheckCommand } from "../../toolchains/toolchains.js";
import { registrationRoot } from "../../projects/project-registration.js";
import { macosCheckTools, signCheckShell } from "./check-macos-isolation.js";
import { parseAllDocuments } from "../../configuration/runtime-parsers.mjs";
import { isRecord } from "../../runtime/values.mjs";
import { copyBuildOutputReceipt } from "../../artifacts/builds.js";
import { packageManagerInstallationPlan } from "../../artifacts/package-manager.js";
import { vcpkgInstallation } from "../../toolchains/vcpkg.js";
import { bundlerInstallation, stageBundlerArchives } from "../../toolchains/ruby-manager.js";
import { composerArchive } from "../../toolchains/php-manager.js";
import { phpCoverageInstallation } from "../../toolchains/php-coverage.js";
import { toolDownloadPath } from "../../toolchains/tool-downloads.js";
import { artifactProofPath } from "../../toolchains/acquisition/artifact-proofs.js";

export interface CheckPathMount {
  source: string;
  destination: string;
  link?: boolean;
  overlay?: boolean;
}

export interface CheckIsolation {
  project: string;
  directory: string;
  source: string;
  runtime: readonly string[];
  outputs: readonly CheckPathMount[];
  temporary?: string;
  tools?: readonly CheckPathMount[];
  environment?: Readonly<Record<string, string>>;
}

export interface CheckIsolationBackend {
  kind: "linux" | "macos";
  executable: string;
  identity: string;
}

export interface CheckIsolationGroup {
  checks: string[];
  paths: string[];
  outputs: string[];
  sourceDigest: string;
  backend: CheckIsolationBackend;
  coverage?: { path: string; digest: string | null };
  setup: { directory: string; command: string[] }[];
}

const linuxRuntime = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/etc/ld.so.cache",
  "/etc/hosts",
  "/etc/resolv.conf",
  "/etc/localtime",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/os-release",
  "/etc/alternatives",
  "/etc/ssl/certs",
  "/etc/pki",
];

function within(parent: string, path: string): boolean {
  const child = relative(parent, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function overlaps(left: string, right: string): boolean {
  return within(left, right) || within(right, left);
}

const linuxOfflineNamespace = ["--unshare-user", "--unshare-net", "--die-with-parent", "--dev-bind", "/", "/"];

function probeLinuxBackend(env: NodeJS.ProcessEnv, namespace: string[]): CheckIsolationBackend | undefined {
  if (process.platform !== "linux") return undefined;
  for (const path of (env.PATH ?? "").split(delimiter).filter(isAbsolute)) {
    const candidate = join(path, "bwrap");
    try {
      accessSync(candidate, constants.X_OK);
      const executable = realpathSync(candidate);
      const probe = spawnSync(executable, [...namespace, "--", "/usr/bin/true"], { timeout: 5000, stdio: "ignore" });
      if (probe.status === 0)
        return { kind: "linux", executable, identity: inputDigest(["bubblewrap", 1, fileDigest(executable)]) };
    } catch {
      /* Try the next native launcher. The complete gate can run without scoped evidence. */
    }
  }
  return undefined;
}

export function linuxCheckBackend(env: NodeJS.ProcessEnv = process.env): CheckIsolationBackend | undefined {
  return probeLinuxBackend(env, [
    "--unshare-user",
    "--unshare-pid",
    "--disable-userns",
    "--die-with-parent",
    ...linuxRuntime.flatMap((entry) => ["--ro-bind-try", entry, entry]),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
  ]);
}

/** Verify an existing offline container or give the command a private network with only loopback. */
export function linuxOfflineCommand(command: string[], env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "linux") return command;
  const interfaces = Object.values(networkInterfaces()).flat();
  if (interfaces.length && interfaces.every((address) => address?.internal)) return command;
  const backend = probeLinuxBackend(env, linuxOfflineNamespace);
  if (!backend) throw new Error("Offline Linux execution needs Bubblewrap with working user and network namespaces");
  return [backend.executable, ...linuxOfflineNamespace, "--", ...command];
}

export function nativeCheckBackend(project?: string): CheckIsolationBackend | undefined {
  if (project && (process.platform === "linux" || process.platform === "darwin")) {
    const owner = registrationRoot(project);
    const runtime = distributionRoot(project);
    if (runtime !== project && [project, owner].some((root) => overlaps(runtime, root))) return undefined;
    if (process.platform === "linux" && linuxRuntime.some((path) => within(path, project) || within(path, owner)))
      return undefined;
  }
  if (process.platform !== "darwin") {
    return linuxCheckBackend();
  }
  const scratch = createOwnedScratch(join(tmpdir(), "workbench-checks"), "launcher");
  let launcher: ReturnType<typeof signCheckShell> | undefined;
  try {
    const visible = join(scratch.directory, "visible");
    const hidden = join(scratch.directory, "hidden");
    writeFileSync(visible, "expected\n");
    writeFileSync(hidden, "omitted\n");
    launcher = signCheckShell(scratch.directory, [visible], []);
    const result = spawnSync(
      launcher.executable,
      [
        "-eu",
        "-c",
        'test "$(cat "$1")" = expected; if /bin/sh -c \'cat "$1"\' child "$2"; then exit 1; fi',
        "workbench",
        visible,
        hidden,
      ],
      { timeout: 5000, stdio: "ignore" },
    );
    if (result.status === 0)
      return {
        kind: "macos",
        executable: macosCheckTools[0],
        identity: inputDigest(["macos-app-sandbox", 1, ...macosCheckTools.map(fileDigest)]),
      };
  } catch {
    /* An unqualified launcher supplies no scoped evidence. */
  } finally {
    try {
      launcher?.release();
    } finally {
      scratch.release();
    }
  }
  return undefined;
}

export function checkBackendName(backend: CheckIsolationBackend) {
  return backend.kind === "linux" ? "Linux mount namespace" : "macOS App Sandbox";
}

/** Mount the same logical checkout path for relative and absolute inputs inside an empty root. */
export function linuxCheckInvocation(
  bubblewrap: string,
  isolation: CheckIsolation,
  invocation: readonly string[],
): string[] {
  const { project, source, directory, runtime, outputs } = isolation;
  const owner = registrationRoot(project);
  const system = [...new Set([...linuxRuntime, ...runtime])];
  for (const path of system) {
    const actual = existsSync(path) ? realpathSync(path) : path;
    if (!isAbsolute(path) || [project, owner].some((root) => overlaps(path, root) || overlaps(actual, root)))
      throw new Error(`Check runtime overlaps the scoped project: ${path}`);
  }
  if (!within(project, directory)) throw new Error("Check working directory is outside the scoped project");
  return [
    bubblewrap,
    "--unshare-user",
    "--unshare-pid",
    "--disable-userns",
    "--die-with-parent",
    ...linuxRuntime.flatMap((path) => ["--ro-bind-try", path, path]),
    ...runtime.filter((path) => !linuxRuntime.includes(path)).flatMap((path) => ["--ro-bind", path, path]),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    ...(isolation.temporary ? ["--bind", isolation.temporary, "/tmp"] : ["--tmpfs", "/tmp"]),
    "--setenv",
    "HOME",
    "/tmp",
    "--setenv",
    "TMPDIR",
    "/tmp",
    ...Object.entries(isolation.environment ?? {}).flatMap(([name, value]) => ["--setenv", name, value]),
    "--ro-bind",
    source,
    project,
    ...outputs.flatMap(({ source, destination }) => ["--bind", source, destination]),
    ...(isolation.tools ?? []).flatMap(({ source, destination, overlay }) =>
      overlay ? ["--overlay-src", source, "--tmp-overlay", destination] : ["--ro-bind", source, destination],
    ),
    "--chdir",
    directory,
    "--",
    ...invocation,
  ];
}

function macosCheckInvocation(scope: string, isolation: CheckIsolation, inherited: NodeJS.ProcessEnv) {
  const { project, directory, source, temporary, runtime, outputs, tools } = isolation;
  const owner = registrationRoot(project);
  const associations = new Map<string, string>();
  const translate = (path: string) => {
    for (const [original, replacement] of associations)
      if (path === original || path.startsWith(original + sep)) return join(replacement, relative(original, path));
    return within(project, path) ? join(source, relative(project, path)) : path;
  };
  const writable: string[] = [];
  for (const output of outputs) {
    const destination = within(project, output.destination) ? translate(output.destination) : output.source;
    associations.set(output.destination, destination);
    writable.push(destination + sep);
  }
  const readOnly = [source + sep];
  for (const tool of tools ?? []) {
    if (within(project, tool.destination)) {
      const destination = translate(tool.destination);
      if (tool.link) {
        rmdirSync(destination);
        symlinkSync(tool.source, destination, "dir");
        readOnly.push(realpathSync(tool.source) + sep);
      } else cpSync(tool.source, destination, { recursive: true });
    } else {
      readOnly.push(tool.source + (statSync(tool.source).isDirectory() ? sep : ""));
      associations.set(tool.destination, tool.source);
    }
  }
  for (const path of runtime) {
    const actual = realpathSync(path);
    if (overlaps(actual, project) || overlaps(actual, owner))
      throw new Error(`Check runtime overlaps the scoped project: ${path}`);
    readOnly.push(actual + sep);
  }
  if (temporary) writable.push(temporary + sep);
  const shell = signCheckShell(scope, readOnly, writable);
  const variables: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(inherited).flatMap(([name, value]) => {
        if (!value) return [];
        const mapped =
          name === "PATH"
            ? value
                .split(delimiter)
                .map((path) => (isAbsolute(path) ? translate(path) : path))
                .join(delimiter)
            : isAbsolute(value)
              ? translate(value)
              : value;
        return mapped === value ? [] : [[name, mapped]];
      }),
    ),
    ...(temporary ? { HOME: temporary, TMPDIR: temporary, TMP: temporary, TEMP: temporary } : {}),
    ...Object.fromEntries(Object.entries(isolation.environment ?? {}).map(([name, path]) => [name, translate(path)])),
  };
  return {
    translate,
    launch: (command: string[]) => [
      "/usr/bin/env",
      ...Object.entries(variables).map(([name, value]) => `${name}=${value}`),
      shell.executable,
      "-eu",
      "-c",
      'cd "$1"; shift; exec "$@"',
      "workbench",
      translate(directory),
      ...command,
    ],
    release: shell.release,
  };
}

function preparedVirtualStore(modules: string): string {
  const path = join(modules, ".modules.yaml");
  const documents = parseAllDocuments(readFileSync(path, "utf8"));
  const metadata: unknown = documents.at(-1)?.toJSON();
  if (
    documents.some((document) => document.errors.length) ||
    !isRecord(metadata) ||
    typeof metadata.virtualStoreDir !== "string"
  )
    throw new Error("Invalid prepared Workbench dependencies");
  return realpathSync(resolve(dirname(realpathSync(path)), metadata.virtualStoreDir));
}

function preparedModules(project: string, source: string): CheckPathMount[] {
  const modules = join(project, "node_modules");
  const store = preparedVirtualStore(modules);
  const checkoutModules = realpathSync(modules);
  if (within(store, project) || (within(project, store) && !within(checkoutModules, store)))
    throw new Error("Prepared dependency storage overlaps check source");
  mkdirSync(join(source, "node_modules"));
  const mounts: CheckPathMount[] = [
    { source: modules, destination: modules, link: true },
    ...(!within(checkoutModules, store) ? [{ source: store, destination: store }] : []),
  ];
  const owner = registrationRoot(project);
  const provider = join(owner, "node_modules");
  const launchers = join(provider, ".bin");
  // Staged shims delegate to the provider's launchers when both snapshots share one prepared store.
  if (
    owner !== project &&
    lstatSync(launchers, { throwIfNoEntry: false })?.isDirectory() &&
    existsSync(join(provider, ".modules.yaml")) &&
    preparedVirtualStore(provider) === store
  ) {
    mounts.push({ source: realpathSync(launchers), destination: launchers });
  }
  return mounts;
}

function checkTrustFiles(project: string, env: NodeJS.ProcessEnv, scoped: Record<string, string>): CheckPathMount[] {
  const owner = registrationRoot(project);
  const names = ["SSL_CERT_FILE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "NODE_EXTRA_CA_CERTS", "CARGO_HTTP_CAINFO"];
  return names.flatMap((name) => {
    const path = env[name];
    if (!path || !isAbsolute(path) || !existsSync(path)) return [];
    const source = realpathSync(path);
    if (
      within(project, path) ||
      within(owner, path) ||
      within(project, source) ||
      within(owner, source) ||
      !statSync(source).isFile()
    )
      return [];
    const destination = `/run/workbench/trust/${name}`;
    scoped[name] = destination;
    return [{ source, destination }];
  });
}

export function usesPreparedCheckModules(project: string, setup: CheckIsolationGroup["setup"]): boolean {
  return (
    distributionRoot(project) === project &&
    setup.some(
      ({ command }) => command.includes("scripts/setup-development.mts") && command.includes("--reuse-prepared"),
    )
  );
}

export function prepareIsolatedChecks(
  project: string,
  directory: string,
  groups: readonly CheckIsolationGroup[],
  env: NodeJS.ProcessEnv,
) {
  const storage = env.WORKBENCH_STORAGE_ROOT;
  const parent = join(storage && !within(project, storage) ? storage : tmpdir(), "workbench-checks");
  const scratch = createOwnedScratch(parent, "scope");
  const releaseLaunchers: (() => void)[] = [];
  const release = () => {
    const errors: unknown[] = [];
    for (const cleanup of [...releaseLaunchers, scratch.release]) {
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Cannot release scoped check workspace");
  };
  try {
    const toolRoot = distributionRoot(project);
    const owner = registrationRoot(project);
    const runtime = new Set<string>(toolRoot === project ? [] : [toolRoot]);
    for (const path of (env.PATH ?? "").split(delimiter)) {
      if (!isAbsolute(path) || !existsSync(path) || linuxRuntime.some((base) => within(base, path))) continue;
      const install = dirname(path);
      if (![project, owner].some((root) => overlaps(install, root) || overlaps(realpathSync(install), root)))
        runtime.add(install);
    }
    const node = dirname(dirname(process.execPath));
    if (!linuxRuntime.some((base) => within(base, node))) runtime.add(node);
    const commands = new Map<
      string,
      {
        group: CheckIsolationGroup;
        launch: (command: string[]) => string[];
        translate: (path: string) => string;
      }
    >();
    const initialized = new Set<CheckIsolationGroup>();
    const distributionBundle = join(project, "bundle");
    const bundledTools = join(scratch.directory, "bundle");
    if (toolRoot === project && existsSync(distributionBundle))
      cpSync(distributionBundle, bundledTools, { recursive: true, mode: constants.COPYFILE_FICLONE });
    for (const [index, group] of groups.entries()) {
      const scope = join(scratch.directory, String(index));
      const source = join(scope, "source");
      const temporary = join(scope, "tmp");
      mkdirSync(source, { recursive: true });
      mkdirSync(temporary);
      const actual = captureCheckSource(project, group.paths);
      if (actual.digest !== group.sourceDigest) throw new Error("Scoped check inputs changed before launch");
      materializeCheckSource(project, source, actual.entries);
      const environment: Record<string, string> = { WORKBENCH_CHECK_SCOPED: "1" };
      const home = env.HOME ?? homedir();
      const managerCache =
        env.XDG_CACHE_HOME ?? join(home, process.platform === "darwin" ? "Library/Caches" : ".cache");
      const tools = checkTrustFiles(project, env, environment);
      const cacheSource = (path: string) => {
        const source = realpathSync(path);
        if ([project, owner].some((root) => overlaps(source, root) || overlaps(path, root)))
          throw new Error(`Prepared dependency storage overlaps captured check source: ${path}`);
        return source;
      };
      const mavenRepository = env.WORKBENCH_MAVEN_REPOSITORY;
      if (existsSync(join(directory, "pom.xml")) && mavenRepository && existsSync(mavenRepository)) {
        tools.push({ source: cacheSource(mavenRepository), destination: mavenRepository });
      }
      if (existsSync(join(directory, "go.mod"))) {
        const goPath = env.GOPATH?.split(delimiter)[0] ?? join(env.HOME ?? homedir(), "go");
        const cache = env.GOMODCACHE ?? join(goPath, "pkg", "mod");
        if (isAbsolute(cache) && existsSync(cache)) {
          const source = realpathSync(cache);
          if ([project, owner].some((root) => overlaps(source, root)))
            throw new Error("Go module storage overlaps captured check source");
          const destination = "/run/workbench/go-mod";
          tools.push({ source, destination });
          environment.GOMODCACHE = destination;
        }
        environment.GOCACHE = group.backend.kind === "linux" ? "/tmp/go-build" : join(temporary, "go-build");
        environment.GOTELEMETRY = "off";
      }
      if (env.RUSTUP_TOOLCHAIN) {
        const home = env.HOME ?? homedir();
        const rustup = realpathSync(env.RUSTUP_HOME ?? join(home, ".rustup"));
        if ([project, owner].some((root) => overlaps(rustup, root)))
          throw new Error("Rustup toolchain storage overlaps captured source");
        const rustupPath = "/run/workbench/rustup";
        tools.push({ source: rustup, destination: rustupPath });
        environment.RUSTUP_HOME = rustupPath;
        const cargo = join(temporary, "cargo");
        mkdirSync(cargo);
        const cargoHome = env.CARGO_HOME ?? join(home, ".cargo");
        const privateCargo = group.backend.kind === "linux" ? "/tmp/cargo" : cargo;
        for (const name of ["registry", "git"]) {
          const path = join(cargoHome, name);
          if (!existsSync(path)) continue;
          const source = realpathSync(path);
          if ([project, owner].some((root) => overlaps(source, root)))
            throw new Error("Cargo dependency storage overlaps captured check source");
          tools.push({ source, destination: join(privateCargo, name) });
        }
        for (const name of ["config", "config.toml"]) {
          const path = join(cargoHome, name);
          if (!existsSync(path)) continue;
          const source = realpathSync(path);
          if (![project, owner].some((root) => within(root, source)) && statSync(source).isFile())
            cpSync(source, join(cargo, name));
        }
        environment.CARGO_HOME = privateCargo;
      }
      if (existsSync(bundledTools) && !existsSync(join(source, "bundle"))) {
        mkdirSync(join(source, "bundle"));
        tools.push({ source: bundledTools, destination: distributionBundle, link: true });
      }
      if (usesPreparedCheckModules(project, group.setup)) tools.push(...preparedModules(project, source));
      const appendOutput = (destination: string, outputs: CheckPathMount[]) => {
        if (outputs.some((output) => within(output.destination, destination))) return;
        if (within(project, destination)) {
          const entry = relative(project, destination).split(sep).join("/");
          if (actual.entries.some(([path]) => path === entry || path.startsWith(entry + "/")))
            throw new Error(`Check output overlaps captured source: ${entry}`);
          mkdirSync(join(source, entry), { recursive: true });
        } else if (
          within(destination, project) ||
          [...linuxRuntime, ...runtime].some((path) => overlaps(destination, path))
        ) {
          throw new Error(`Check output overlaps a read-only workspace: ${destination}`);
        }
        const output = join(scope, "outputs", String(outputs.length));
        mkdirSync(output, { recursive: true });
        outputs.push({ source: output, destination });
        return output;
      };
      const outputs: CheckPathMount[] = [];
      const seedCache = (path: string) => {
        const lower = cacheSource(path);
        const overlay =
          group.backend.kind === "linux" &&
          spawnSync(
            group.backend.executable,
            [
              "--unshare-user",
              "--overlay-src",
              lower,
              "--tmp-overlay",
              "/prepared",
              ...linuxRuntime.flatMap((path) => ["--ro-bind-try", path, path]),
              "--",
              "/usr/bin/true",
            ],
            { timeout: 5000, stdio: "ignore" },
          ).status === 0;
        if (overlay) tools.push({ source: lower, destination: path, overlay });
        else {
          const output = appendOutput(path, outputs);
          if (!output) throw new Error(`Prepared dependency storage overlaps another output: ${path}`);
          cpSync(lower, output, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
        }
      };
      for (const name of ["WORKBENCH_BUILD_DIR", "WORKBENCH_DEPENDENCIES_DIR", "WORKBENCH_DIST_DIR"]) {
        const value = env[name];
        if (!value || !isAbsolute(value)) continue;
        const output = appendOutput(value, outputs);
        if (name === "WORKBENCH_BUILD_DIR" && output) copyBuildOutputReceipt(value, output);
      }
      if (group.setup.some(({ command }) => command[0] === "{packageManager}" && command[1] === "install")) {
        appendOutput(join(directory, "node_modules"), outputs);
        const store = env.PNPM_CONFIG_STORE_DIR;
        const virtual = env.PNPM_CONFIG_VIRTUAL_STORE_DIR;
        if (store && virtual) {
          const bootstrap = packageManagerInstallationPlan(directory, toolRoot).directory;
          if (!existsSync(bootstrap) || !existsSync(store))
            throw new Error("Scoped pnpm dependencies are missing; run workbench prepare for this root");
          tools.push({ source: cacheSource(bootstrap), destination: bootstrap });
          appendOutput(virtual, outputs);
          seedCache(store);
          const metadata = join(managerCache, "pnpm");
          if (existsSync(metadata)) {
            tools.push({ source: cacheSource(metadata), destination: metadata });
            environment.XDG_CACHE_HOME = dirname(metadata);
          }
          const privateRuntime = join(temporary, "run");
          mkdirSync(privateRuntime, { mode: 0o700 });
          environment.XDG_RUNTIME_DIR = group.backend.kind === "linux" ? "/tmp/run" : privateRuntime;
        }
      }
      if (existsSync(join(directory, "uv.lock"))) {
        const cache = env.UV_CACHE_DIR ?? join(managerCache, "uv");
        if (!existsSync(cache))
          throw new Error("Scoped uv dependencies are missing; run workbench prepare for this root");
        seedCache(cache);
        environment.UV_CACHE_DIR = cache;
        environment.UV_LINK_MODE = "copy";
        if (!env.UV_PROJECT_ENVIRONMENT) appendOutput(join(directory, ".venv"), outputs);
      }
      if (existsSync(join(directory, "Gemfile.lock"))) {
        const { destination, downloads } = bundlerInstallation(directory, toolRoot, env);
        if (!existsSync(destination) || !existsSync(downloads))
          throw new Error("Scoped Ruby dependencies are missing; run workbench prepare for this root");
        tools.push({ source: cacheSource(destination), destination });
        stageBundlerArchives(directory, cacheSource(downloads), join(temporary, "gems"));
        const privateHome = group.backend.kind === "linux" ? "/tmp" : temporary;
        environment.BUNDLE_CACHE_PATH = join(privateHome, "gems");
        environment.BUNDLE_USER_CACHE = join(privateHome, "bundler");
      }
      const composerCache = env.WORKBENCH_COMPOSER_CACHE;
      if (composerCache && existsSync(join(directory, ".composer-version"))) {
        const { artifact } = composerArchive(directory, toolRoot);
        const files = [
          toolDownloadPath(artifact),
          ...(artifact.signature ? [artifactProofPath(artifact.signature.url)] : []),
        ];
        if (!existsSync(composerCache) || files.some((file) => !existsSync(file)))
          throw new Error("Scoped Composer dependencies are missing; run workbench prepare for this root");
        for (const file of files) tools.push({ source: cacheSource(file), destination: file });
        seedCache(composerCache);
        if (group.backend.kind === "linux" && group.coverage && existsSync(join(directory, ".xdebug-version"))) {
          const { destination } = phpCoverageInstallation(directory, toolRoot, env);
          if (!existsSync(destination)) throw new Error("Scoped Xdebug installation is missing; run workbench prepare");
          tools.push({ source: cacheSource(destination), destination });
        }
      }
      if (existsSync(join(directory, "vcpkg.json")) && existsSync(join(directory, ".vcpkg-version"))) {
        const { installation } = vcpkgInstallation(directory);
        const downloads = env.VCPKG_DOWNLOADS ?? join(env.WORKBENCH_CACHE_HOME ?? managerCache, "vcpkg/downloads");
        if (!existsSync(installation) || !existsSync(downloads))
          throw new Error("Scoped vcpkg dependencies are missing; run workbench prepare for this root");
        seedCache(installation);
        seedCache(downloads);
        const cache = join(managerCache, "vcpkg");
        if (existsSync(cache)) {
          seedCache(cache);
          environment.XDG_CACHE_HOME = managerCache;
        }
      }
      if (group.coverage) {
        appendOutput(join(directory, "coverage"), outputs);
        const contents = committedCheckCoverage(registrationRoot(project), group.coverage.path, env);
        if ((contents === undefined ? null : inputDigest(contents)) !== group.coverage.digest)
          throw new Error("Committed coverage baseline changed before launch");
        const baseline = join(scope, "baseline.json");
        writeFileSync(baseline, contents ?? "", { mode: 0o600 });
        const destination = "/run/workbench/coverage-baseline.json";
        tools.push({ source: baseline, destination });
        environment.WORKBENCH_CHECK_BASELINE = destination;
      }
      for (const name of group.outputs) appendOutput(join(project, name), outputs);
      const isolation = { project, directory, source, temporary, runtime: [...runtime], outputs, tools, environment };
      const macos = group.backend.kind === "macos" ? macosCheckInvocation(scope, isolation, env) : undefined;
      if (macos) releaseLaunchers.push(macos.release);
      const execution = macos ?? {
        translate: (path: string) => path,
        launch: (command: string[]) => linuxCheckInvocation(group.backend.executable, isolation, command),
      };
      for (const name of group.checks) commands.set(name, { group, ...execution });
    }
    return {
      wrap: (name: string, command: string[]) => {
        const options = commands.get(name);
        if (!options) return command;
        const { group, launch, translate } = options;
        const translated = (arguments_: string[]) =>
          arguments_.map((value) => (isAbsolute(value) ? translate(value) : value));
        command = translated(command);
        if (!initialized.has(group) && group.setup.length) {
          initialized.add(group);
          const setup = group.setup.map(
            ({ directory, command }) =>
              `(cd ${quote(translate(directory))} && ${translated(resolveCheckCommand(directory, command, toolRoot))
                .map(quote)
                .join(" ")})`,
          );
          command = ["/bin/sh", "-eu", "-c", [...setup, 'exec "$@"'].join("\n"), "workbench", ...command];
        }
        return launch(command);
      },
      release,
    };
  } catch (error) {
    try {
      release();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Cannot prepare a scoped check", { cause: cleanup });
    }
    throw error;
  }
}
