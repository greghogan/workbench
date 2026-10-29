import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { parse } from "smol-toml";
import { parseTOML } from "toml-eslint-parser";
import { setConfiguration } from "../src/config-command.ts";
import { setUserOption } from "../src/user-config.ts";
import { useDevelopment } from "../src/development.ts";
import { reserveRecordNumber, syncRecordSequences } from "../src/record-sequences.ts";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const comments = (text: string) =>
  parseTOML(text, { tomlVersion: "1.1.0" }).comments.map((comment) => text.slice(...comment.range));
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "workbench-toml-mutation-"));
  directories.push(root);
  mkdirSync(join(root, "workbench"));
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="root"\npath="."\n');
  writeFileSync(
    join(root, "workbench/config.toml"),
    'schema_version=1\n# formatting rationale\n[markdown] # prose\nwrap_width = 120 # human choice\n[compatibility]\nrequired=false\n[development]\ndefault="native"\n[[development.profiles]]\nname="native"\nbuilder="native"\nworkspace="host"\n',
  );
  vi.stubEnv("WORKBENCH_CONFIG_HOME", join(root, "global"));
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "cache"));
  vi.stubEnv("WORKBENCH_LOCAL_CONFIG_ROOT", undefined);
  vi.stubEnv("WORKBENCH_PROFILE_CONTEXT", undefined);
  vi.stubEnv("WORKBENCH_WORKSPACE_CONTEXT", undefined);
  vi.stubEnv("WORKBENCH_DEVELOPMENT_PROFILE", undefined);
  vi.stubEnv("WORKBENCH_SHELL_ENVIRONMENT", undefined);
  vi.stubEnv("WORKBENCH_SHELL_ROOT", undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  return root;
}

test("project configuration updates preserve every unrelated byte", () => {
  const root = fixture();
  const path = join(root, "workbench/config.toml");
  const before = readFileSync(path, "utf8");
  setConfiguration(root, "markdown.wrap_width", "100", "project");
  expect(readFileSync(path, "utf8")).toBe(before.replace("wrap_width = 120", "wrap_width = 100"));
});

test("global updates and unsets retain comments in arrays and empty sections", () => {
  const root = fixture();
  mkdirSync(join(root, "global"));
  const path = join(root, "global/config.toml");
  const before =
    '# user preferences\n[skills] # selection\nenabled=[\n "first", # first rationale\n "second", # second rationale\n] # list\n[storage] # machine storage\nexternal=false # local choice\n';
  writeFileSync(path, before);
  setUserOption("skills.enabled", '["second","third"]');
  setUserOption("skills.enabled");
  const after = readFileSync(path, "utf8");
  expect(comments(after)).toEqual(comments(before));
  expect(after).toContain("[storage] # machine storage\nexternal=false # local choice\n");
  expect(parse(after).skills).toEqual({});
});

test("development selection retains comments when replacing an environment selection", async () => {
  const root = fixture();
  const path = join(root, "workbench/local.toml");
  const before =
    '# environment rationale\n[checks] # old selection\nenvironment="native" # environment choice\n[execution]\nmax_jobs = 2 # machine limit\n';
  writeFileSync(path, before);
  await useDevelopment(root, "native");
  const after = readFileSync(path, "utf8");
  expect(comments(after)).toEqual(comments(before));
  expect(after).toContain("[execution]\nmax_jobs = 2 # machine limit\n");
  expect(parse(after).checks).toBeUndefined();
  expect(parse(after).development).toEqual({ profile: "native" });
});

test("record allocation and sequence synchronization retain comments and numeric spelling", () => {
  const root = fixture();
  const path = join(root, "workbench/record-sequences.toml");
  const before = '# allocation policy\n[next] # retained counters\nADR = "A" # next decision\n';
  writeFileSync(path, before);
  syncRecordSequences(root);
  expect(reserveRecordNumber(root, "ADR")).toBe("A");
  const after = readFileSync(path, "utf8");
  expect(comments(after)).toEqual(comments(before));
  expect(after).toContain('ADR = "B" # next decision');
});
