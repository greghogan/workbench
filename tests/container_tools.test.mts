import { required } from "../src/invariants.ts";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { containerCLI, containerToolsDirectory, installContainerCLI } from "../src/container-tools.ts";

const state = vi.hoisted(() => ({
  calls: [] as string[][],
  fail: "",
  version: "0.89.0",
  directory: "",
  publishedDuringVerification: [] as boolean[],
}));
vi.mock("../src/tool-downloads.js", () => ({
  execute: (command: string, args: string[], options: { cwd: string }) => {
    state.calls.push([command, ...args]);
    if (args[0] === "audit" || command === "node") state.publishedDuringVerification.push(existsSync(state.directory));
    if (command === "npm" && args[0] === "ci") {
      const packageRoot = join(options.cwd, "node_modules/@devcontainers/cli");
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({ version: "0.89.0", bin: { devcontainer: "devcontainer.js" } }),
      );
      writeFileSync(join(packageRoot, "devcontainer.js"), "// fixture executable\n");
    }
    if (args.includes(state.fail)) throw new Error("signature verification failed");
    return state.version;
  },
}));
let root: string, temporary: string;
beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "workbench-container-bootstrap-"));
  root = join(temporary, "runtime");
  cpSync(new URL("../scripts/container-tools", import.meta.url), join(root, "scripts/container-tools"), {
    recursive: true,
  });
  writeFileSync(join(root, "package.json"), '{"name":"packaged-workbench"}');
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(temporary, "cache"));
  state.calls = [];
  state.fail = "";
  state.version = "0.89.0";
  state.directory = containerToolsDirectory(root);
  state.publishedDuringVerification = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(temporary, { recursive: true, force: true });
});
test("isolated container bootstrap verifies signatures before activation and reuses only a complete installation", () => {
  expect(() => containerCLI(root)).toThrow(/Install the locked/);
  installContainerCLI(root, process.env);
  const cli = containerCLI(root);
  expect(readFileSync(cli, "utf8")).toBe("// fixture executable\n");
  expect(state.calls.slice(0, 2)).toEqual([
    ["npm", "ci", "--ignore-scripts", "--include=optional", "--no-audit", "--no-fund"],
    ["npm", "audit", "signatures"],
  ]);
  expect(state.publishedDuringVerification).toEqual([false, false]);
  expect(existsSync(state.directory)).toBe(true);
  const calls = state.calls.length;
  installContainerCLI(root, process.env);
  expect(state.calls).toHaveLength(calls);
  writeFileSync(
    join(dirname(cli), "package.json"),
    JSON.stringify({ version: "0.1.0", bin: { devcontainer: "devcontainer.js" } }),
  );
  expect(() => {
    installContainerCLI(root, process.env);
  }).toThrow(/does not match/);
});
test.each(["signature", "version"])(
  "failed %s verification removes private staging without activating the CLI",
  (failure) => {
    if (failure === "signature") state.fail = "signatures";
    else state.version = "0.1.0";
    const directory = containerToolsDirectory(root);
    expect(() => {
      installContainerCLI(root, process.env);
    }).toThrow(/verification failed|expected/);
    expect(existsSync(directory)).toBe(false);
    expect(readdirSync(dirname(directory)).filter((name) => name.endsWith(".partial"))).toEqual([]);
  },
);
test("bootstrap declarations reject unverified packages and escaping executable paths before acquisition", () => {
  const file = join(root, "scripts/container-tools/package-lock.json");
  const lock = JSON.parse(readFileSync(file, "utf8")) as {
    packages: Record<string, { integrity: string; bin: { devcontainer: string } }>;
  };
  const selected = required(lock.packages["node_modules/@devcontainers/cli"], "Container CLI lock entry");
  selected.integrity = "sha1-invalid";
  writeFileSync(file, JSON.stringify(lock));
  expect(() => {
    installContainerCLI(root, process.env);
  }).toThrow(/strong integrity/);
  selected.integrity = `sha512-${"A".repeat(86)}==`;
  selected.bin.devcontainer = "../../../outside.js";
  writeFileSync(file, JSON.stringify(lock));
  expect(() => {
    installContainerCLI(root, process.env);
  }).toThrow(/unsafe relative path/);
  expect(state.calls).toEqual([]);
});
