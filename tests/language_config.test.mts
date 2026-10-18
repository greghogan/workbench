import { required } from "../src/invariants.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "smol-toml";
import { catalog } from "../src/language-config.ts";
import { readChecks } from "../src/checks.ts";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
function definition(
  base: string,
  id: string,
  commands: { role: string; command: string[] }[] | { surprise: boolean; role: string; command: string[] }[],
) {
  const directory = join(base, id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "config.toml"),
    stringify({
      schema_version: 1,
      id,
      name: id,
      summary: `${id} checks`,
      reference: ".",
      manifests: [`${id}.manifest`],
    }),
  );
  writeFileSync(join(directory, "automation.toml"), stringify({ schema_version: 1, command: commands }));
  return directory;
}
const command = (value: string) => ({ role: "test", command: ["node", "-e", `console.log(${JSON.stringify(value)})`] });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-language-config-"));
  temporary.push(root);
  const distribution = join(root, "distribution");
  mkdirSync(join(distribution, "languages"), { recursive: true });
  writeFileSync(
    join(distribution, "languages/index.toml"),
    stringify({ schema_version: 1, languages: ["typescript"] }),
  );
  definition(join(distribution, "languages"), "typescript", [command("shared")]);
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  mkdirSync(join(root, "workbench"));
  writeFileSync(
    join(root, "workbench/config.toml"),
    "schema_version = 1\n[markdown]\nwrap_width = 120\n[compatibility]\nrequired = false\n",
  );
  writeFileSync(
    join(root, "workbench/projects.toml"),
    stringify({
      project: [{ id: "app", path: "." }],
      language_root: [{ language: "typescript", path: "." }],
    }),
  );
  writeFileSync(
    join(root, "workbench/automation.toml"),
    stringify({ check_suite: [{ language: "typescript", path: "." }] }),
  );
  return { root, distribution, local: join(root, "workbench/languages") };
}

test("shared definitions are referenced; local replacements remain complete through distribution changes", () => {
  const { root, distribution, local } = fixture();
  expect(required(catalog(root)[0], "Expected fixture value: catalog(root)[0]").source).toBe("shared");
  expect(required(readChecks(root)[0], "Expected fixture value: readChecks(root)[0]").command).toEqual(
    command("shared").command,
  );
  const directory = definition(local, "typescript", [command("local")]);
  expect(catalog(root)[0]).toMatchObject({ source: "local replacement", directory, referenceRoot: root });
  expect(readChecks(root)).toHaveLength(1);
  expect(readChecks(root)[0]).toMatchObject({
    command: command("local").command,
    source: `local replacement: ${join(directory, "automation.toml")}`,
  });
  definition(join(distribution, "languages"), "typescript", [
    command("updated shared"),
    { role: "lint", command: ["node", "--version"] },
  ]);
  expect(readChecks(root).map((entry) => entry.command)).toEqual([command("local").command]);
  rmSync(directory, { recursive: true });
  expect(readChecks(root).map((entry) => entry.role)).toEqual(["test", "lint"]);
  expect(required(readChecks(root)[0], "Expected fixture value: readChecks(root)[0]").command).toEqual(
    command("updated shared").command,
  );
});

test("ignored shared definitions are not parsed, and incomplete local definitions do not fall back", () => {
  const { root, distribution, local } = fixture();
  const directory = definition(local, "typescript", [command("local")]);
  writeFileSync(join(distribution, "languages/typescript/config.toml"), "invalid [");
  expect(required(readChecks(root)[0], "Expected fixture value: readChecks(root)[0]").command).toEqual(
    command("local").command,
  );
  rmSync(join(directory, "automation.toml"));
  expect(() => catalog(root)).toThrow(/automation.toml/);
  writeFileSync(join(directory, "automation.toml"), "schema_version = 1\ncommand = []\n");
  expect(() => catalog(root)).toThrow(/nonempty command/);
});

test("local additions supply independent executable suites without a bundled language identity", () => {
  const { root, local } = fixture();
  definition(local, "custom", [command("new language")]);
  writeFileSync(
    join(root, "workbench/projects.toml"),
    stringify({
      project: [{ id: "app", path: "." }],
      language_root: [{ language: "custom", path: "." }],
    }),
  );
  writeFileSync(
    join(root, "workbench/automation.toml"),
    stringify({ check_suite: [{ language: "custom", path: "." }] }),
  );
  expect(
    required(
      catalog(root).find((entry) => entry.id === "custom"),
      'Expected fixture value: catalog(root).find((entry) => entry.id === "custom")',
    ).source,
  ).toBe("local addition");
  expect(readChecks(root).map((entry) => entry.command)).toEqual([command("new language").command]);
});

test("definitions reject ambiguous commands, unknown fields, unsafe paths, and linked directories", () => {
  const { root, local } = fixture();
  const directory = definition(local, "typescript", [command("a"), command("b")]);
  expect(() => catalog(root)).toThrow(/duplicate command/);
  definition(local, "typescript", [{ ...command("a"), surprise: true }]);
  expect(() => catalog(root)).toThrow(/unknown field 'surprise'/);
  definition(local, "typescript", [command("a")]);
  const config = join(directory, "config.toml");
  writeFileSync(config, readFileSync(config, "utf8").replace('reference = "."', 'reference = "../escape"'));
  expect(() => catalog(root)).toThrow(/unsafe relative path/);
  rmSync(directory, { recursive: true });
  symlinkSync(join(root, "distribution/languages/typescript"), directory, "junction");
  expect(() => catalog(root)).toThrow(/real language directory/);
});

test("duplicate suite selections fail instead of executing commands twice", () => {
  const { root } = fixture();
  writeFileSync(
    join(root, "workbench/automation.toml"),
    stringify({ check_suite: Array(2).fill({ language: "typescript", path: "." }) }),
  );
  expect(() => readChecks(root)).toThrow(/unique nonempty name/);
});

test("starter copies accept declared files and reject duplicates, empty lists, and escaping paths", () => {
  const { root, local } = fixture();
  const directory = definition(local, "typescript", [command("local")]);
  const path = join(directory, "config.toml");
  const original = readFileSync(path, "utf8");
  writeFileSync(path, `${original}\nstarter = ["src/index.js", "package.json"]\n`);
  expect(required(catalog(root)[0], "Expected fixture value: catalog(root)[0]").starter).toEqual([
    "src/index.js",
    "package.json",
  ]);
  for (const starter of [[], ["package.json", "package.json"], ["../escape"], ["/absolute"]] as const) {
    writeFileSync(path, `${original}\nstarter = ${JSON.stringify(starter)}\n`);
    expect(() => catalog(root)).toThrow(/starter|unsafe relative path/);
  }
});
