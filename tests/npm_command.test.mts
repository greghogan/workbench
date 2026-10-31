import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { npmCommand } from "../src/npm-command.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-npm-command-")));
  roots.push(root);
  return root;
}
test.each(["windows", "posix"])("SDK npm discovery supports the %s layout without consulting another npm", (layout) => {
  const root = fixture(),
    node = join(root, "bin/node"),
    npm = join(
      root,
      layout === "windows" ? "bin/node_modules/npm/bin/npm-cli.js" : "lib/node_modules/npm/bin/npm-cli.js",
    );
  mkdirSync(dirname(npm), { recursive: true });
  writeFileSync(npm, "");
  expect(npmCommand({ node, sdkOnly: true, environment: { npm_execpath: join(root, "other/npm-cli.js") } })).toEqual({
    command: node,
    prefix: [npm],
  });
});
test("ordinary dispatch preserves explicit npm selection and rejects a missing explicit executable", () => {
  const root = fixture(),
    npm = join(root, "npm-cli.mjs"),
    node = join(root, "node");
  writeFileSync(npm, "");
  expect(npmCommand({ node, environment: { npm_execpath: npm } })).toEqual({ command: node, prefix: [npm] });
  rmSync(npm);
  expect(() => npmCommand({ node, environment: { npm_execpath: npm } })).toThrow(/Cannot locate npm-cli/);
});
test("POSIX dispatch can use PATH, while SDK-only and Windows dispatch require a located npm CLI", () => {
  const node = join(fixture(), "node");
  expect(npmCommand({ node, platform: "linux", environment: {} })).toEqual({ command: "npm", prefix: [] });
  expect(() => npmCommand({ node, sdkOnly: true, environment: {} })).toThrow(/selected Node SDK/);
  expect(() => npmCommand({ node, platform: "win32", environment: {} })).toThrow(/selected Node SDK/);
});

test.skipIf(process.platform === "win32")(
  "SDK discovery supports separate npm outputs associated with the selected Node",
  () => {
    const root = fixture(),
      node = join(root, "runtime/bin/node"),
      npm = join(root, "npm-output/lib/node_modules/npm/bin/npm-cli.js"),
      profile = join(root, "profile/bin");
    for (const path of [dirname(node), dirname(npm), profile]) mkdirSync(path, { recursive: true });
    writeFileSync(node, "selected runtime");
    writeFileSync(npm, "selected npm");
    symlinkSync(node, join(profile, "node"));
    symlinkSync(npm, join(profile, "npm"));
    expect(npmCommand({ node, sdkOnly: true, environment: { PATH: profile } })).toEqual({
      command: node,
      prefix: [npm],
    });
  },
);

test.skipIf(process.platform === "win32").each(["different runtime", "missing runtime", "shell launcher"])(
  "SDK discovery rejects an unrelated npm profile: %s",
  (layout) => {
    const root = fixture(),
      node = join(root, "runtime/bin/node"),
      npm = join(root, "npm-output/npm-cli.js"),
      profile = join(root, "profile/bin");
    for (const path of [dirname(node), dirname(npm), profile]) mkdirSync(path, { recursive: true });
    writeFileSync(node, "selected runtime");
    writeFileSync(npm, "npm");
    if (layout === "different runtime") writeFileSync(join(profile, "node"), "another runtime");
    if (layout === "shell launcher") {
      symlinkSync(node, join(profile, "node"));
      writeFileSync(join(profile, "npm"), "#!/bin/sh\n");
    } else symlinkSync(npm, join(profile, "npm"));
    expect(() => npmCommand({ node, sdkOnly: true, environment: { PATH: profile, npm_execpath: npm } })).toThrow(
      /selected Node SDK/,
    );
  },
);
