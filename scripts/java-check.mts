import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { cpuBudget } from "../app/src/core/execution/checks/cpu-budget.mjs";
import { processCancellation, runOwnedChild } from "../app/src/core/runtime/owned-child.mjs";
import { processFailure } from "../app/src/core/runtime/process-outcome.mjs";
import { createOwnedScratch } from "../app/src/core/runtime/owned-scratch.mjs";
import { combineFailures, settleCleanup } from "../app/src/core/diagnostics/diagnostic-errors.mjs";
import { publishDirectory } from "../app/src/core/runtime/directory-publication.mjs";
import { writeJavaCoverage } from "./java-coverage.mjs";
import { retainJavaTestReports } from "./java-test-reports.mjs";
import { mavenTestSelectionPom } from "../app/src/core/toolchains/maven/maven-test-selection.js";
import { isMainScript } from "./script-entry.mjs";
import { canonicalJavaSources, snapshotJavaSources, publishJavaFormatting } from "./java-sources.mjs";
import { commandInvocation } from "../app/src/core/toolchains/tool-execution.js";
import {
  javaRuntime,
  javaRuntimeArguments,
  packageJavaRelease,
  type JavaRuntime,
  type JavaSourceArtifacts,
} from "../app/src/core/toolchains/java-release.js";
import { decodeMavenAcquisition } from "../app/src/core/toolchains/maven/maven-policy.js";
import { mavenChecksums } from "../app/src/core/toolchains/maven/maven-artifacts.js";
import { readMavenMetadata, assertMavenFiles } from "../app/src/core/toolchains/maven/maven-files.js";
import { isolatedMavenEnvironment } from "../app/src/core/toolchains/maven/maven-environment.js";
import {
  assertMavenWorkspaceExternalCoordinates,
  mavenInvocationPom,
  mavenReactorPom,
  mavenWorkspaceExternalChecksums,
  prepareMavenCheckRepository,
  readMavenWorkspace,
  type MavenSourceProject,
} from "../app/src/core/toolchains/maven/maven-workspace.js";
import { withCacheLock } from "../app/src/core/storage/cache-lock.js";
import { required } from "../app/src/core/runtime/values.mjs";
import {
  diagnostic,
  DiagnosticOperation,
  DiagnosticOutcome,
  LogLevel,
} from "../app/src/core/diagnostics/diagnostics.mjs";

export interface JavaCheckOptions {
  distribution: string;
  role: string;
  root?: string;
  projectRoot?: string;
  artifact?: string;
  properties?: Readonly<Record<string, string>>;
  profiles?: readonly string[];
  /** An explicit diagnostic selection in this root; it does not establish full-gate evidence. */
  tests?: string;
}
const goals: Readonly<Record<string, readonly string[]>> = {
  setup: ["validate"],
  "dependency-verify": ["fmt:check", "-Pcoverage", "package", "jacoco:report", "jacoco:check", "spotbugs:check"],
  format: ["fmt:check"],
  "format-write": ["fmt:format"],
  type: ["compile"],
  lint: ["compile", "spotbugs:check"],
  test: ["test"],
  coverage: ["-Pcoverage", "test", "jacoco:report", "jacoco:check"],
  build: ["package", "-DskipTests"],
  docs: ["compile"],
  release: ["package", "-DskipTests"],
  diagnostic: ["test"],
};
const emptySettings = '<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"/>\n';

/** Command entry points report bounded diagnostics instead of an uncaught bundled-source stack. */
export async function runJavaCheckCommand(options: JavaCheckOptions): Promise<void> {
  try {
    await runJavaCheck(options);
  } catch (error) {
    diagnostic(
      LogLevel.Error,
      DiagnosticOperation.Command,
      DiagnosticOutcome.Failed,
      { command: `Java ${options.role}` },
      error,
    );
    process.exitCode = 1;
  }
}

/** Build the selected root and its declared sources using Maven's normal reactor and isolated owned outputs. */
export async function runJavaCheck(options: JavaCheckOptions): Promise<void> {
  const source = resolve(options.root ?? process.cwd()),
    distribution = resolve(options.distribution),
    role = options.role;
  const selectedGoals = goals[role];
  if (!selectedGoals) throw new Error(`Unknown Java check: ${role}`);
  if (
    role === "diagnostic"
      ? !options.tests?.trim() || Buffer.byteLength(options.tests) > 1024 || /[\0\r\n]/.test(options.tests)
      : options.tests !== undefined
  )
    throw new Error("Supply a bounded test selector only with the diagnostic Java role");
  const properties = options.properties ?? {};
  for (const name of Object.keys(properties))
    if (
      !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) ||
      /^(?:aether\.|maven\.|workbench\.(?:build|application|runtimeArgs|cpus)$)/.test(name)
    )
      throw new Error(`Java check properties cannot replace owned verification/build settings: ${name}`);
  if (options.profiles?.some((profile) => !/^[A-Za-z0-9_+.][A-Za-z0-9_+.-]*$/.test(profile)))
    throw new Error("Java check profiles require literal profile names");
  const configuration = join(source, ".mvn/acquisition.json"),
    configurationBytes = readMavenMetadata(configuration),
    config = decodeMavenAcquisition(JSON.parse(configurationBytes.toString("utf8"))),
    pom = readMavenMetadata(join(source, "pom.xml")),
    index = readMavenMetadata(join(source, ".mvn/checksums/checksums.sha256"));
  const workspace = readMavenWorkspace(source, config.sources ?? [], options.projectRoot, { pom, checksums: index });
  const shared = process.env.WORKBENCH_MAVEN_REPOSITORY;
  if (!shared) throw new Error("Java checks require WORKBENCH_MAVEN_REPOSITORY; use a configured Workbench command");
  const modules = workspace ? [workspace.consumer, ...workspace.sources] : [];
  if (workspace && modules.some((module) => existsSync(join(module.root, ".mvn/extensions.xml"))))
    throw new Error("Java source workspaces do not support Maven core extensions");
  const inputs = [
    { path: configuration, bytes: configurationBytes },
    ...(workspace ? modules : [{ root: source, pom, checksums: index }]).flatMap((module) => [
      { path: join(module.root, "pom.xml"), bytes: module.pom },
      { path: join(module.root, ".mvn/checksums/checksums.sha256"), bytes: module.checksums },
    ]),
  ];
  const external = workspace ? mavenWorkspaceExternalChecksums(workspace) : mavenChecksums(index.toString("utf8"));
  if (workspace) assertMavenWorkspaceExternalCoordinates(workspace, external);
  const buildRoot = resolve(process.env.WORKBENCH_BUILD_DIR ?? join(source, "build"));
  mkdirSync(buildRoot, { recursive: true });
  const scratch = createOwnedScratch(buildRoot, "java-check"),
    cancellation = processCancellation();
  const consumer = join(scratch.directory, "java"),
    stable = join(buildRoot, role === "diagnostic" ? "java-diagnostic" : "java");
  let failure: unknown,
    preserve = false;
  try {
    const runtime = javaRuntime(source),
      cpus = cpuBudget();
    const stage = (root: string, directory: string, module?: MavenSourceProject) => {
      if (existsSync(join(root, "src"))) snapshotJavaSources(join(root, "src"));
      mkdirSync(directory);
      for (const name of ["pom.xml", ".mvn", "src", "LICENSE", "LICENSE.workbench-example"])
        if (existsSync(join(root, name)))
          cpSync(join(root, name), join(directory, name), { recursive: true, preserveTimestamps: true });
      writeFileSync(join(directory, "pom.xml"), module?.pom ?? pom);
      writeFileSync(join(directory, ".mvn/checksums/checksums.sha256"), module?.checksums ?? index);
      if (module) {
        const selectedRuntime: JavaRuntime = root === source ? runtime : { ...javaRuntime(root), kind: "library" };
        writeFileSync(
          join(directory, "pom.xml"),
          mavenInvocationPom(module.pom, {
            "workbench.build": "target",
            "workbench.application": String(selectedRuntime.kind === "application"),
            "workbench.runtimeArgs": javaRuntimeArguments(selectedRuntime).join(" "),
          }),
        );
      }
      if (role === "diagnostic") {
        const path = join(directory, "pom.xml");
        writeFileSync(path, mavenTestSelectionPom(readFileSync(path), root === source ? options.tests : undefined));
      }
    };
    const originals = role === "format-write" ? snapshotJavaSources(join(source, "src")) : undefined;
    stage(source, consumer, workspace?.consumer);
    if (workspace) {
      workspace.sources.forEach((module, i) => {
        stage(module.root, join(scratch.directory, `provider-${String(i)}`), module);
      });
      cpSync(join(source, ".mvn"), join(scratch.directory, ".mvn"), { recursive: true });
      writeFileSync(
        join(scratch.directory, "pom.xml"),
        mavenReactorPom([...workspace.sources.map((_, i) => `provider-${String(i)}`), "java"]),
      );
    }
    if (selectedGoals.some((goal) => goal === "fmt:check" || goal === "fmt:format"))
      canonicalJavaSources(join(consumer, "src"), role === "format-write");
    const diagnosticContext =
      role === "diagnostic"
        ? {
            toolchain: {
              ...(existsSync(join(source, ".java-version"))
                ? { java: readMavenMetadata(join(source, ".java-version")).toString("utf8").trim() }
                : {}),
              ...(existsSync(join(source, ".tool-versions"))
                ? { tools: readMavenMetadata(join(source, ".tool-versions")).toString("utf8").trim() }
                : {}),
            },
            modules: [
              { root: source, directory: consumer },
              ...(workspace?.sources.map((module, index) => ({
                root: module.root,
                directory: join(scratch.directory, `provider-${String(index)}`),
              })) ?? []),
            ].map((module) => {
              const digest = createHash("sha256");
              for (const entry of readdirSync(module.directory, { recursive: true, withFileTypes: true })
                .filter((entry) => entry.isFile())
                .sort((left, right) =>
                  join(left.parentPath, left.name).localeCompare(join(right.parentPath, right.name)),
                )) {
                const path = join(entry.parentPath, entry.name),
                  bytes = readFileSync(path);
                digest
                  .update(JSON.stringify([relative(module.directory, path).replaceAll("\\", "/"), bytes.length]))
                  .update(bytes);
              }
              return {
                path: relative(source, module.root).replaceAll("\\", "/") || ".",
                inputsSha256: digest.digest("hex"),
              };
            }),
          }
        : undefined;
    const cwd = workspace ? scratch.directory : consumer;
    const privateRepository = workspace !== undefined || process.env.WORKBENCH_CHECK_SCOPED === "1";
    const repository = privateRepository ? join(scratch.directory, "repository") : shared;
    const common = [
      "--batch-mode",
      "--strict-checksums",
      "--no-transfer-progress",
      "-T",
      String(cpus),
      `-Dmaven.repo.local=${repository}`,
      `-Dworkbench.cpus=${String(cpus)}`,
    ];
    if (privateRepository) {
      await prepareMavenCheckRepository(shared, external, repository, cancellation.signal);
      const global = join(scratch.directory, "global-settings.xml");
      writeFileSync(global, emptySettings);
      const settings = join(cwd, ".mvn/settings.xml");
      if (!existsSync(settings)) writeFileSync(settings, emptySettings);
      common.push(
        "--offline",
        "--settings",
        settings,
        "--global-settings",
        global,
        "-Dmaven.repo.local.head=",
        "-Dmaven.repo.local.tail=",
        "-Daether.offline.protocols=",
        "-Daether.offline.hosts=",
        "-Daether.offline.repositories=",
        "-Daether.enhancedLocalRepository.split=false",
        "-Daether.artifactResolver.postProcessor.trustedChecksums=false",
      );
    } else
      common.push(
        "-Daether.artifactResolver.postProcessor.trustedChecksums=true",
        "-Daether.artifactResolver.postProcessor.trustedChecksums.record=false",
        "-Daether.artifactResolver.postProcessor.trustedChecksums.failIfMissing=true",
        `-Daether.trustedChecksumsSource.summaryFile.basedir=${join(consumer, ".mvn/checksums")}`,
      );
    if (!workspace)
      common.push(
        `-Dworkbench.build=${join(consumer, "target")}`,
        `-Dworkbench.application=${String(runtime.kind === "application")}`,
        `-Dworkbench.runtimeArgs=${javaRuntimeArguments(runtime).join(" ")}`,
      );
    common.push(
      ...Object.entries(properties).map(([name, value]) => `-D${name}=${value}`),
      ...(options.profiles?.length ? [`-P${options.profiles.join(",")}`] : []),
    );
    const env = privateRepository
      ? isolatedMavenEnvironment(process.env, cwd, `-XX:ActiveProcessorCount=${String(cpus)}`)
      : { ...process.env, MAVEN_OPTS: `${process.env.MAVEN_OPTS ?? ""} -XX:ActiveProcessorCount=${String(cpus)}` };
    const command = commandInvocation(
      "mvn",
      [
        ...common,
        ...(workspace ? ["-pl", "java", ...(["format", "format-write"].includes(role) ? [] : ["-am"])] : []),
        ...selectedGoals,
      ],
      env,
      cwd,
    );
    const startedAt = new Date().toISOString();
    const result = await runOwnedChild(required(command[0], "Maven command"), command.slice(1), {
      cwd,
      env,
      signal: cancellation.signal,
      owner: scratch.owner,
      stopDescendantsOnExit: true,
    });
    let problem = processFailure(`Maven ${role}`, result);
    if (result.descendantsActive) {
      preserve = true;
      throw new Error(`Maven termination is unproven; preserving Java staging: ${scratch.directory}`, {
        cause: problem,
      });
    }
    if (["test", "coverage", "dependency-verify", "diagnostic"].includes(role))
      try {
        const failures = retainJavaTestReports(
          join(consumer, "target/surefire-reports"),
          source,
          {
            role,
            startedAt,
            status: result.status,
            signal: result.signal,
            ...(result.error ? { error: result.error.message } : {}),
            ...(options.tests ? { tests: options.tests } : {}),
            ...(diagnosticContext ? { context: diagnosticContext } : {}),
          },
          workspace
            ? [
                {
                  id: "java",
                  path: `${workspace.consumer.artifact} (.)`,
                  reports: join(consumer, "target/surefire-reports"),
                },
                ...workspace.sources.map((module, index) => ({
                  id: `provider-${String(index)}`,
                  path: `${module.artifact} (${relative(source, module.root).replaceAll("\\", "/")})`,
                  reports: join(scratch.directory, `provider-${String(index)}`, "target/surefire-reports"),
                })),
              ]
            : [],
        );
        if (problem && failures.length)
          problem = new Error(`${problem.message}\n${failures.slice(0, 8).join("\n")}`, { cause: problem });
      } catch (error) {
        if (problem) throw combineFailures(problem, error, "Maven execution and report retention failed");
        throw error;
      }
    if (problem) throw problem;
    cancellation.signal.throwIfAborted();
    assertMavenFiles(inputs);
    const report = join(consumer, "target/site/jacoco/jacoco.xml");
    if (role === "coverage" && existsSync(report)) writeJavaCoverage(readFileSync(report, "utf8"), source);
    if (originals) publishJavaFormatting(join(source, "src"), join(consumer, "src"), originals);
    if (role === "release") {
      const name = options.artifact ?? workspace?.consumer.jar;
      if (!name || !/^[A-Za-z0-9_+.-]+\.jar$/.test(name))
        throw new Error("Supply the project's portable Java artifact name");
      const artifacts: JavaSourceArtifacts = new Map(
        workspace?.sources.flatMap(
          (module, i) =>
            [
              [module.pomPath, join(scratch.directory, `provider-${String(i)}`, "pom.xml")],
              [module.jarPath, join(scratch.directory, `provider-${String(i)}`, "target", module.jar)],
            ] as [string, string][],
        ),
      );
      const output = resolve(
        process.env.WORKBENCH_RELEASE_OUTPUT ?? process.env.WORKBENCH_DIST_DIR ?? join(source, "dist"),
      );
      await packageJavaRelease(source, join(consumer, "target", name), repository, join(output, name.slice(0, -4)), {
        ...(workspace ? { sourceArtifacts: artifacts, externalChecksums: external } : {}),
        signal: cancellation.signal,
      });
    }
    if (role === "docs") {
      const checked = await runOwnedChild(
        process.execPath,
        [join(distribution, "bin/workbench.mjs"), "docs", "README.md"],
        {
          cwd: source,
          env: { ...process.env, WORKBENCH_BUILD_DIR: scratch.directory },
          signal: cancellation.signal,
          owner: scratch.owner,
          stopDescendantsOnExit: true,
        },
      );
      const problem = processFailure("Java documentation verification", checked);
      if (checked.descendantsActive) {
        preserve = true;
        throw new Error(`Java documentation termination is unproven; preserving ${scratch.directory}`, {
          cause: problem,
        });
      }
      if (problem) throw problem;
    }
    const previous = join(scratch.directory, "previous-java");
    cancellation.signal.throwIfAborted();
    try {
      await withCacheLock(stable, () => {
        cancellation.signal.throwIfAborted();
        if (lstatSync(stable, { throwIfNoEntry: false })?.isSymbolicLink())
          throw new Error("Java build output must not be a symbolic link");
        publishDirectory(consumer, stable, previous);
        if (existsSync(previous)) rmSync(previous, { recursive: true });
        return Promise.resolve();
      });
    } catch (error) {
      if (existsSync(previous)) {
        preserve = true;
        scratch.owner.markUncertain();
      }
      throw error;
    }
  } catch (error) {
    failure = error;
  }
  await settleCleanup([cancellation.close, ...(preserve ? [] : [scratch.release])], failure);
}

if (isMainScript(import.meta.url)) {
  try {
    if (process.argv[2] !== "diagnostic" || !process.argv[3] || process.argv.length !== 4)
      throw new Error("Use java-check.mjs diagnostic TEST_SELECTOR in a prepared Java root");
    await runJavaCheck({
      distribution: resolve(import.meta.dirname, ".."),
      role: "diagnostic",
      tests: process.argv[3],
    });
  } catch (error) {
    diagnostic(
      LogLevel.Error,
      DiagnosticOperation.Command,
      DiagnosticOutcome.Failed,
      { command: "Java diagnostic" },
      error,
    );
    process.exitCode = 1;
  }
}
