import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "smol-toml";
import { runCommand } from "../src/check-command.ts";
import { prepareCheckCommand } from "../src/check-preparation.ts";
import { nativeCheckEnvironment } from "../src/check-environment.ts";
import { assertNativeToolSelection, assetFor, nativeTools, toolDirectory } from "../src/native-assets.ts";
import { catalog } from "../src/language-config.ts";
import { required } from "../src/invariants.ts";
import { NativeToolUnavailable, toolProbes } from "../src/tool-probes.ts";

const distribution = resolve(import.meta.dirname, "..");
const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "workbench-native-selection-")));
  temporary.push(base);
  const root = join(base, "project"),
    directory = join(root, "modules/storage");
  mkdirSync(join(root, "workbench"), { recursive: true });
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(root, "workbench/config.toml"),
    stringify({
      schema_version: 1,
      markdown: { wrap_width: 120 },
      compatibility: { required: false },
    }),
  );
  writeFileSync(
    join(root, "workbench/projects.toml"),
    stringify({
      project: [{ id: "fixture", path: "." }],
      language_root: [{ language: "java", path: "modules/storage" }],
    }),
  );
  for (const [name, value] of Object.entries({
    WORKBENCH_DISTRIBUTION_ROOT: distribution,
    WORKBENCH_CACHE_HOME: join(base, "cache"),
    WORKBENCH_DATA_HOME: join(base, "data"),
    WORKBENCH_STATE_HOME: join(base, "state"),
    WORKBENCH_CONFIG_HOME: join(base, "config"),
    WORKBENCH_TOOLCHAIN: undefined,
    WORKBENCH_TOOLCHAIN_ROOT: undefined,
    WORKBENCH_PREPARED: undefined,
    WORKBENCH_OFFLINE: undefined,
    WORKBENCH_ENVIRONMENTS: undefined,
    WORKBENCH_STORAGE_EXTERNAL: "false",
    WORKBENCH_STORAGE_ROOT: undefined,
  }))
    vi.stubEnv(name, value);
  return { base, root, directory };
}
function selectors(directory: string) {
  for (const file of [".java-version", ".tool-versions"])
    writeFileSync(join(directory, file), readFileSync(join(distribution, "examples/languages/java", file)));
}
function replacement(root: string, tools?: unknown) {
  const directory = join(root, "workbench/languages/java");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "config.toml"),
    stringify({
      schema_version: 1,
      id: "java",
      name: "Java",
      summary: "Project-owned Java checks",
      reference: ".",
      manifests: ["pom.xml"],
      ...(tools === undefined ? {} : { native_tools: tools }),
    }),
  );
  writeFileSync(
    join(directory, "automation.toml"),
    stringify({ schema_version: 1, command: [{ role: "test", command: ["node", "--version"] }] }),
  );
}

test("missing native Java selectors identify the root and stop before the runner or acquisition", () => {
  const { base, root, directory } = fixture();
  selectors(root);
  const marker = join(directory, "runner-started");
  const run = () => {
    runCommand(
      directory,
      "Java setup",
      [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
      "native",
      root,
    );
  };
  expect(run).toThrow(NativeToolUnavailable);
  expect(run).toThrow(
    /modules\/storage.*java \(\.java-version\), maven \(\.tool-versions\).*workbench tools install --path 'modules\/storage'/,
  );
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(join(base, "cache/toolchains"))).toBe(false);
  writeFileSync(join(directory, ".java-version"), readFileSync(join(root, ".java-version")));
  expect(() => {
    assertNativeToolSelection(root, directory);
  }).toThrow(/selection for maven \(\.tool-versions\)/);
  rmSync(join(directory, ".java-version"));
  writeFileSync(join(directory, ".tool-versions"), readFileSync(join(root, ".tool-versions")));
  expect(() => {
    assertNativeToolSelection(root, directory);
  }).toThrow(/selection for java \(\.java-version\)/);
});

test("effective native selections preserve configured profiles and verified installation paths", () => {
  const { base, root, directory } = fixture();
  selectors(directory);
  expect(() => {
    assertNativeToolSelection(root, directory);
  }).not.toThrow();
  expect(() => nativeCheckEnvironment(root, directory)).toThrow(/not installed in its managed cache/);
  const selected = nativeTools(directory, distribution);
  const bins: string[] = [];
  for (const tool of selected.filter((tool) => ["java", "maven"].includes(tool.name))) {
    const asset = required(assetFor(distribution, tool), "Java starter tool metadata");
    const destination = toolDirectory(tool, asset),
      bin = join(destination, asset.bin);
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(destination, ".workbench-artifact"), asset.sha256);
    for (const probe of toolProbes(tool))
      writeFileSync(
        join(bin, `${probe.executable}${process.platform === "win32" ? (probe.windowsSuffix ?? ".exe") : ""}`),
        "not executed during selection",
      );
    bins.push(bin);
  }
  const environment = nativeCheckEnvironment(root, directory);
  expect(environment.PATH?.split(delimiter).slice(0, 2)).toEqual(bins);
  expect(environment.JAVA_HOME).toBe(resolve(required(bins[0], "Java SDK bin"), ".."));
  const config = join(root, "workbench/config.toml");
  writeFileSync(
    config,
    readFileSync(config, "utf8") +
      '\n[[toolchains.profiles]]\nname="java-other"\npaths=["modules/storage"]\n[toolchains.profiles.tools]\njava="21.0.13+7"\n',
  );
  expect(() => {
    assertNativeToolSelection(root, directory, { toolchain: "java-other" });
  }).not.toThrow();
  expect(
    nativeTools(directory, distribution, { toolchain: "java-other" }).find((tool) => tool.name === "java"),
  ).toMatchObject({ version: "21.0.13+7", source: "tool profile 'java-other'" });
  vi.stubEnv("WORKBENCH_TOOLCHAIN_ROOT", root);
  vi.stubEnv("WORKBENCH_TOOLCHAIN", "java-other");
  expect(() => {
    assertNativeToolSelection(root, directory);
  }).not.toThrow();
  expect(nativeTools(directory, distribution).find((tool) => tool.name === "java")).toMatchObject({
    version: "21.0.13+7",
    source: "tool profile 'java-other'",
  });
  expect(existsSync(join(base, "cache/toolchains/java/21.0.13+7"))).toBe(false);
});

test("complete language replacements control their native requirements", () => {
  const { root, directory } = fixture();
  replacement(root);
  const marker = join(directory, "runner-started");
  runCommand(
    directory,
    "project Java check",
    [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
    "native",
    root,
  );
  expect(readFileSync(marker, "utf8")).toBe("started");
  replacement(root, ["java"]);
  expect(() => {
    assertNativeToolSelection(root, directory);
  }).toThrow(/selection for java \(\.java-version\)/);
  writeFileSync(
    join(directory, ".java-version"),
    readFileSync(join(distribution, "examples/languages/java/.java-version")),
  );
  expect(() => {
    assertNativeToolSelection(root, directory);
  }).not.toThrow();
});

test("language native requirements reject ambiguous names and duplicates", () => {
  const { root } = fixture();
  for (const names of [["Java"], ["maven", "maven"], ["java", ""], "java"]) {
    replacement(root, names);
    expect(() => catalog(root)).toThrow(/native_tools/);
  }
});

test.skipIf(process.platform === "win32").each(["nix", "guix"] as const)(
  "%s runners retain independent authorities without native selectors",
  (selected) => {
    const { root, directory } = fixture();
    for (const file of ["flake.nix", "flake.lock", "manifest.scm", "channels.scm"])
      writeFileSync(join(directory, file), "{}");
    const prepared = prepareCheckCommand({
      directory,
      name: "Managed Java setup",
      command: [process.execPath, "-e", "process.exit(0)"],
      selected,
      repositoryRoot: root,
    });
    expect(prepared.invocation).toContain(selected);
    expect(existsSync(join(directory, ".java-version"))).toBe(false);
    expect(existsSync(join(directory, ".tool-versions"))).toBe(false);
  },
);
