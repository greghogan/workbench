import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { parse } from "smol-toml";
import { parseTOML } from "toml-eslint-parser";
import { setConfiguration } from "../../../src/core/configuration/config-command.ts";
import { setUserOption } from "../../../src/core/configuration/user-config.ts";
import { selectDevelopment } from "../../../src/core/artifacts/development.ts";
import { reserveRecordNumber, syncRecordSequences } from "../../../src/core/records/record-sequences.ts";

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

test("global updates and unsets retain comments while removing empty sections", () => {
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
  expect(parse(after).skills).toBeUndefined();
});

test("development selection retains comments when replacing an environment selection", () => {
  const root = fixture();
  const path = join(root, "workbench/local.toml");
  const before =
    '# environment rationale\n[checks] # old selection\nenvironment="native" # environment choice\n[execution]\nmax_jobs = 2 # machine limit\n';
  writeFileSync(path, before);
  selectDevelopment(root, "native");
  const after = readFileSync(path, "utf8");
  expect(comments(after)).toEqual(comments(before));
  expect(after).toContain("[execution]\nmax_jobs = 2 # machine limit\n");
  expect(parse(after).checks).toBeUndefined();
  expect(parse(after).development).toEqual({ profile: "native" });
});

test.each([
  { counters: '[next] # retained counters\nADR = "A" # next decision\n', first: "A", next: "B" },
  { counters: "", first: "0", next: "1" },
])("record allocation preserves unrelated project state with initial ID $first", ({ counters, first, next }) => {
  const root = fixture();
  const path = join(root, "workbench/state.toml");
  const before = `# allocation policy\n${counters}[extensions]\nnote = "retained" # other state\n`;
  writeFileSync(path, before);
  syncRecordSequences(root);
  expect(reserveRecordNumber(root, "ADR")).toBe(first);
  const after = readFileSync(path, "utf8");
  expect(comments(after)).toEqual(comments(before));
  expect(parse(after).next).toMatchObject({ ADR: next });
  expect(parse(after).extensions).toEqual({ note: "retained" });
});

test.each(['next = ["0"]\n', "next = 1979-05-27T07:32:00Z\n", "[next]\nTSK = 2\n"])(
  "malformed record counters remain unchanged after a rejected allocation: %s",
  (contents) => {
    const root = fixture();
    const path = join(root, "workbench/state.toml");
    writeFileSync(path, contents);
    expect(() => reserveRecordNumber(root, "TSK")).toThrow(/state\.toml: invalid/);
    expect(readFileSync(path, "utf8")).toBe(contents);
  },
);
