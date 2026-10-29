import { afterEach, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import * as child from "../scripts/owned-child.mjs";
import * as diagnostics from "../scripts/diagnostics.mjs";
import * as workspaceReader from "../src/maven-workspace.ts";
import { runJavaCheck, runJavaCheckCommand } from "../scripts/java-check.mts";
import { decodeMavenAcquisition, acquisitionInputs } from "../src/maven-policy.ts";
import { mavenDigest } from "../src/maven-artifacts.ts";
import {
  assertMavenWorkspaceExternalCoordinates,
  prepareMavenCheckRepository,
  mavenInvocationPom,
  mavenReactorPom,
  mavenWorkspaceExternalChecksums,
  readMavenWorkspace,
} from "../src/maven-workspace.ts";
import { packageJavaRelease } from "../src/java-release.ts";
import { zip } from "./fixtures/zip.mts";

vi.mock("../scripts/owned-child.mjs", async (original) => ({
  ...(await original<typeof import("../scripts/owned-child.mjs")>()),
  runOwnedChild: vi.fn(),
}));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const externalPath = "org/vendor/external/1/external-1.jar",
  externalHash = mavenDigest(Buffer.from("reviewed external"));
const project = (id: string, dependency = "") =>
  `<project><modelVersion>4.0.0</modelVersion><groupId>org.fixture</groupId><artifactId>${id}</artifactId><version>1</version><properties><!-- preserve 文 --><workbench.application>true</workbench.application></properties><dependencies>${dependency}</dependencies><build><finalName>${id}</finalName></build></project>`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-maven-workspace-"));
  roots.push(root);
  mkdirSync(join(root, "workbench"));
  writeFileSync(join(root, "workbench/projects.toml"), "");
  const app = join(root, "app"),
    library = join(root, "library");
  for (const [directory, id] of [
    [app, "app"],
    [library, "library"],
  ] as const) {
    mkdirSync(join(directory, ".mvn/checksums"), { recursive: true });
    mkdirSync(join(directory, "src"));
    writeFileSync(
      join(directory, "pom.xml"),
      project(
        id,
        id === "app"
          ? "<dependency><groupId>org.fixture</groupId><artifactId>library</artifactId><version>1</version></dependency>"
          : "",
      ),
    );
    writeFileSync(join(directory, "src/Example.java"), "class Example {}\n");
    writeFileSync(join(directory, ".mvn/checksums/checksums.sha256"), `${externalHash}  ${externalPath}\n`);
    writeFileSync(
      join(directory, ".mvn/acquisition.json"),
      JSON.stringify({
        resolver: "org.apache.maven.plugins:maven-dependency-plugin:3.11.0:go-offline",
        trust: [],
        ...(id === "app" ? { sources: ["../library"] } : {}),
      }),
    );
  }
  mkdirSync(dirname(join(root, "repository", externalPath)), { recursive: true });
  writeFileSync(join(root, "repository", externalPath), "reviewed external");
  vi.stubEnv("WORKBENCH_BUILD_DIR", join(root, "build"));
  vi.stubEnv("WORKBENCH_MAVEN_REPOSITORY", join(root, "repository"));
  return { root, app, library, stage: join(root, "build/java"), index: join(app, ".mvn/checksums/checksums.sha256") };
}
test("declared source identities stay separate from frozen external requirements and bind the acquisition policy", () => {
  const f = fixture();
  const workspace = readMavenWorkspace(f.app, ["../library"]);
  if (!workspace) throw new Error("Missing workspace");
  expect(workspace.sources[0]?.jarPath).toBe("org/fixture/library/1/library-1.jar");
  const external = mavenWorkspaceExternalChecksums(workspace);
  const before = readFileSync(f.index);
  expect(() => {
    assertMavenWorkspaceExternalCoordinates(workspace, external);
  }).not.toThrow();
  expect(external.has("org/fixture/library/1/library-1.pom")).toBe(false);
  expect(readFileSync(f.index)).toEqual(before);
  const policy = acquisitionInputs(f.app).policy;
  writeFileSync(join(f.library, "src/Example.java"), "class Example { int value; }\n");
  expect(acquisitionInputs(f.app).policy).toBe(policy);
  writeFileSync(join(f.library, "pom.xml"), project("library") + "\n");
  expect(acquisitionInputs(f.app).policy).not.toBe(policy);
  const revised = acquisitionInputs(f.app).policy;
  writeFileSync(join(f.library, ".mvn/checksums/checksums.sha256"), "");
  expect(acquisitionInputs(f.app).policy).not.toBe(revised);
});
test("source workspaces reject invalid ownership and identities while leaving dependency order to Maven", () => {
  const f = fixture();
  expect(() => readMavenWorkspace(f.app, ["../library", "../library"])).toThrow(/Duplicate/);
  expect(() => readMavenWorkspace(f.app, ["../library"], f.app)).toThrow(/outside/);
  writeFileSync(
    join(f.library, "pom.xml"),
    project(
      "library",
      "<dependency><groupId>org.fixture</groupId><artifactId>app</artifactId><version>1</version></dependency>",
    ),
  );
  expect(readMavenWorkspace(f.app, ["../library"])).toBeDefined();
  writeFileSync(join(f.library, "pom.xml"), project("library").replace("<modelVersion>", "<parent/><modelVersion>"));
  expect(() => readMavenWorkspace(f.app, ["../library"])).toThrow(/standalone POMs without parent/);
  writeFileSync(join(f.library, "pom.xml"), project("app"));
  expect(() => readMavenWorkspace(f.app, ["../library"])).toThrow(/Duplicate Maven source coordinates/);
  writeFileSync(join(f.library, "pom.xml"), project("library"));
  const workspace = readMavenWorkspace(f.app, ["../library"]);
  if (!workspace) throw new Error("Missing workspace");
  expect(() => {
    assertMavenWorkspaceExternalCoordinates(workspace, new Map([[workspace.sources[0]?.jarPath ?? "", externalHash]]));
  }).toThrow(/must not appear in the external/);
  writeFileSync(join(f.library, ".mvn/checksums/checksums.sha256"), `${"1".repeat(64)}  ${externalPath}\n`);
  expect(mavenWorkspaceExternalChecksums(workspace).get(externalPath)).toBe(externalHash);
  const refreshed = readMavenWorkspace(f.app, ["../library"]);
  if (!refreshed) throw new Error("Missing workspace");
  expect(() => mavenWorkspaceExternalChecksums(refreshed)).toThrow(/Conflicting/);
});
test("invocation property edits preserve XML comments and do not confuse comment text with element values", () => {
  const input = Buffer.from(
    "<project><!-- <workbench.application>unchanged</workbench.application> 文😀 --><properties><workbench.application>true</workbench.application><keep>value</keep></properties></project>",
  );
  const output = mavenInvocationPom(input, {
    "workbench.application": "false",
    "workbench.runtimeArgs": "a&b<c>",
  }).toString();
  expect(output).toContain("<!-- <workbench.application>unchanged</workbench.application> 文😀 -->");
  expect(output).toContain("<workbench.application>false</workbench.application><keep>value</keep>");
  expect(output).toContain("<workbench.runtimeArgs>a&amp;b&lt;c&gt;</workbench.runtimeArgs>");
  expect(mavenInvocationPom(Buffer.from("<project><properties/></project>"), { value: "x" }).toString()).toBe(
    "<project><properties><value>x</value></properties></project>",
  );
  expect(mavenInvocationPom(Buffer.from("<project/>"), { value: "x" }).toString()).toBe(
    "<project><properties><value>x</value></properties></project>",
  );
  expect(() => mavenReactorPom(["../escape"])).toThrow(/private Maven module/);
  expect(() =>
    decodeMavenAcquisition({
      resolver: "org.apache.maven.plugins:maven-dependency-plugin:3.11.0:go-offline",
      trust: [],
      sources: ["../library", "../library"],
    }),
  ).toThrow(/requires/);
});

const jarBytes = zip([{ name: "META-INF/MANIFEST.MF", content: "Manifest-Version: 1.0\n\n" }]);
test("one-pass workspace checks use a verified private offline cache and Maven reactor ordering", async () => {
  const f = fixture(),
    originalPom = readFileSync(join(f.library, "pom.xml")),
    originalIndex = readFileSync(f.index);
  const inherited = [
    "MAVEN_ARGS",
    "MAVEN_OPTS",
    "MAVEN_EXT_CLASS_PATH",
    "MAVEN_HOME",
    "M2_HOME",
    "JAVA_TOOL_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "_JAVA_OPTIONS",
    "CLASSPATH",
    "Java_Tool_Options",
    "Jdk_Java_Options",
    "Maven_Ext_Class_Path",
    "maven_opts",
    "Maven_Basedir",
    "Maven_Projectbasedir",
  ];
  for (const name of inherited) vi.stubEnv(name, "host-injection-canary");
  writeFileSync(join(f.app, ".mvn/jvm.config"), "-Dproject.declared.option=true\n");
  let invocation = "";
  vi.mocked(child.runOwnedChild).mockImplementation((_command, args, options) => {
    invocation = options.cwd;
    const repository = args.find((arg) => arg.startsWith("-Dmaven.repo.local="))?.slice("-Dmaven.repo.local=".length);
    if (!repository) throw new Error("Missing private repository");
    expect(repository).not.toBe(join(f.root, "repository"));
    expect(readFileSync(join(repository, externalPath), "utf8")).toBe("reviewed external");
    expect(args).toContain("--offline");
    expect(args).toContain("-am");
    expect(args).not.toContain("install");
    expect(args).toContain("compile");
    expect(args).not.toContain("package");
    for (const name of inherited) expect(options.env[name]).not.toBe("host-injection-canary");
    expect(options.env.MAVEN_OPTS).toMatch(/^-XX:ActiveProcessorCount=\d+$/);
    expect(readFileSync(join(options.cwd, ".mvn/jvm.config"), "utf8")).toBe("-Dproject.declared.option=true\n");
    expect(readFileSync(join(options.cwd, "provider-0/pom.xml"), "utf8")).toContain(
      "<workbench.application>false</workbench.application>",
    );
    return Promise.resolve({ pid: 1, status: 0, signal: null });
  });
  await runJavaCheck({ distribution: f.root, root: f.app, role: "type" });
  expect(child.runOwnedChild).toHaveBeenCalledOnce();
  expect(existsSync(invocation)).toBe(false);
  expect(existsSync(join(f.root, "build/java/pom.xml"))).toBe(true);
  expect(readFileSync(join(f.library, "pom.xml"))).toEqual(originalPom);
  expect(readFileSync(f.index)).toEqual(originalIndex);
  expect(existsSync(join(f.root, "repository/org/fixture/library"))).toBe(false);
});
test("the Java command boundary reports a shared diagnostic while the programmatic runner rejects", async () => {
  const report = vi.spyOn(diagnostics, "diagnostic").mockImplementation(() => undefined);
  const options = { distribution: ".", role: "unsupported" },
    previous = process.exitCode;
  try {
    await expect(runJavaCheck(options)).rejects.toThrow(/Unknown Java check/);
    await expect(runJavaCheckCommand(options)).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(report).toHaveBeenCalledWith(
      diagnostics.LogLevel.Error,
      diagnostics.DiagnosticOperation.Command,
      diagnostics.DiagnosticOutcome.Failed,
      { command: "Java unsupported" },
      expect.objectContaining({ message: "Unknown Java check: unsupported" }),
    );
  } finally {
    process.exitCode = previous;
  }
});
test("corrupt external cache bytes fail before any project or plugin executes", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "repository", externalPath), "corrupt external");
  await expect(runJavaCheck({ distribution: f.root, root: f.app, role: "build" })).rejects.toThrow(/checksum mismatch/);
  expect(child.runOwnedChild).not.toHaveBeenCalled();
});
test("cancellation after Maven drains does not publish formatter edits or replace previous output", async () => {
  const f = fixture(),
    controller = new AbortController();
  mkdirSync(f.stage, { recursive: true });
  writeFileSync(join(f.stage, "previous"), "previous output");
  vi.spyOn(child, "processCancellation").mockReturnValue({ signal: controller.signal, close: () => undefined });
  vi.mocked(child.runOwnedChild).mockImplementation((_command, _args, options) => {
    writeFileSync(join(options.cwd, "java/src/Example.java"), "class Example { /* formatter candidate */ }\n");
    controller.abort();
    return Promise.resolve({ pid: 1, status: 0, signal: null });
  });
  await expect(runJavaCheck({ distribution: f.root, root: f.app, role: "format-write" })).rejects.toThrow(/abort/i);
  expect(readFileSync(join(f.app, "src/Example.java"), "utf8")).toBe("class Example {}\n");
  expect(readFileSync(join(f.stage, "previous"), "utf8")).toBe("previous output");
});
test("private repository metadata contains only verified frozen entries and copies never alias shared bytes", async () => {
  const f = fixture(),
    shared = join(f.root, "repository"),
    target = join(f.root, "private");
  writeFileSync(join(dirname(join(shared, externalPath)), "unreviewed.jar"), "not allowed");
  writeFileSync(join(dirname(join(shared, externalPath)), "_remote.repositories"), "unreviewed.jar>untrusted=\n");
  await prepareMavenCheckRepository(shared, new Map([[externalPath, externalHash]]), target);
  expect(readFileSync(join(dirname(join(target, externalPath)), "_remote.repositories"), "utf8")).toBe(
    "external-1.jar>=\n",
  );
  expect(existsSync(join(dirname(join(target, externalPath)), "unreviewed.jar"))).toBe(false);
  expect(readFileSync(join(target, "org/vendor/external/maven-metadata-local.xml"), "utf8")).toContain(
    "<versions><version>1</version></versions>",
  );
  writeFileSync(join(shared, externalPath), "later shared modification");
  expect(readFileSync(join(target, externalPath), "utf8")).toBe("reviewed external");
});
test("concurrent workspace invocations own distinct scratch and publish without deleting each other's files", async () => {
  const f = fixture(),
    locations: string[] = [],
    completions: (() => void)[] = [];
  let both!: () => void;
  const entered = new Promise<void>((resolve) => {
    both = resolve;
  });
  vi.mocked(child.runOwnedChild).mockImplementation((_command, _args, options) => {
    locations.push(options.cwd);
    if (locations.length === 2) both();
    return new Promise((resolve) => {
      completions.push(() => {
        resolve({ pid: 1, status: 0, signal: null });
      });
    });
  });
  const first = runJavaCheck({ distribution: f.root, root: f.app, role: "build" });
  const second = runJavaCheck({ distribution: f.root, root: f.app, role: "build" });
  await entered;
  expect(new Set(locations).size).toBe(2);
  expect(locations.every((path) => existsSync(join(path, "provider-0/pom.xml")))).toBe(true);
  for (const complete of completions) complete();
  await Promise.all([first, second]);
  expect(locations.every((path) => !existsSync(path))).toBe(true);
  expect(existsSync(join(f.root, "build/java/pom.xml"))).toBe(true);
});
test("formatting owns only the selected root even when a sibling has been staged", async () => {
  const f = fixture();
  vi.mocked(child.runOwnedChild).mockImplementation((_command, args, options) => {
    expect(args).not.toContain("-am");
    writeFileSync(join(options.cwd, "java/src/Example.java"), "class Example { /* formatted */ }\n");
    writeFileSync(join(options.cwd, "provider-0/src/Example.java"), "class Example { /* provider stage */ }\n");
    return Promise.resolve({ pid: 1, status: 0, signal: null });
  });
  await runJavaCheck({ distribution: f.root, root: f.app, role: "format-write" });
  expect(readFileSync(join(f.app, "src/Example.java"), "utf8")).toContain("formatted");
  expect(readFileSync(join(f.library, "src/Example.java"), "utf8")).toBe("class Example {}\n");
});
test("runtime packaging selects the invocation source JAR and retains frozen upstream bytes", async () => {
  const f = fixture(),
    repository = join(f.root, "repository"),
    local = join(f.root, "invocation");
  const externalPom = externalPath.replace(/jar$/, "pom"),
    localJar = "org/fixture/library/1/library-1.jar",
    localPom = localJar.replace(/jar$/, "pom");
  const external = new Map<string, string>();
  const sourceFiles = new Map<string, string>();
  for (const [base, path, bytes, index] of [
    [repository, externalPath, jarBytes, external],
    [repository, externalPom, Buffer.from("<project/>"), external],
    [local, localJar, jarBytes, sourceFiles],
    [local, localPom, Buffer.from("<project/>"), sourceFiles],
  ] as const) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), bytes);
    index.set(path, index === external ? mavenDigest(bytes) : join(base, path));
  }
  writeFileSync(f.index, [...external].map(([path, hash]) => `${hash}  ${path}\n`).join(""));
  const jar = join(f.app, "app.jar");
  writeFileSync(
    jar,
    zip([
      {
        name: "META-INF/MANIFEST.MF",
        content: `Manifest-Version: 1.0\nMain-Class: App\nClass-Path: lib/${localJar} lib/${externalPath}\n\n`,
      },
    ]),
  );
  const output = join(f.root, "dist");
  await packageJavaRelease(f.app, jar, repository, output, {
    sourceArtifacts: sourceFiles,
  });
  expect(readFileSync(join(output, "lib", localJar))).toEqual(jarBytes);
  expect(existsSync(join(repository, localJar))).toBe(false);
  const changed = zip([
    { name: "META-INF/MANIFEST.MF", content: "Manifest-Version: 1.0\n\n" },
    { name: "new-source-output", content: "new current source output" },
  ]);
  writeFileSync(join(local, localJar), changed);
  await packageJavaRelease(f.app, jar, repository, output, { sourceArtifacts: sourceFiles });
  expect(readFileSync(join(output, "lib", localJar))).toEqual(changed);
  writeFileSync(join(local, localJar), "tampered");
  await expect(
    packageJavaRelease(f.app, jar, repository, output, {
      sourceArtifacts: sourceFiles,
    }),
  ).rejects.toThrow(/central directory|zip|ZIP|Invalid/);
  expect(readFileSync(join(output, "lib", localJar))).toEqual(changed);
  if (process.platform !== "win32") {
    rmSync(join(local, localJar));
    symlinkSync(join(repository, externalPath), join(local, localJar));
    await expect(
      packageJavaRelease(f.app, jar, repository, output, {
        sourceArtifacts: sourceFiles,
      }),
    ).rejects.toThrow(/regular file/);
  }
});

test("a POM edit between workspace capture and staging cannot pass the final input guard", async () => {
  const f = fixture(),
    read = workspaceReader.readMavenWorkspace;
  mkdirSync(f.stage, { recursive: true });
  writeFileSync(join(f.stage, "previous"), "accepted previous output");
  vi.spyOn(workspaceReader, "readMavenWorkspace").mockImplementationOnce((...args) => {
    const workspace = read(...args);
    writeFileSync(join(f.app, "pom.xml"), project("edited-app"));
    return workspace;
  });
  vi.mocked(child.runOwnedChild).mockResolvedValue({ pid: 1, status: 0, signal: null });
  await expect(runJavaCheck({ distribution: f.root, root: f.app, role: "type" })).rejects.toThrow(
    /input changed during execution/,
  );
  expect(readFileSync(join(f.stage, "previous"), "utf8")).toBe("accepted previous output");
  expect(readFileSync(join(f.app, "pom.xml"), "utf8")).toBe(project("edited-app"));
});
