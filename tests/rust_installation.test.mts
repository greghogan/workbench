import { completedProcess } from "./fixtures/process.mjs";
import { installNativeTools } from "../src/native-tools.ts";
import * as execution from "../src/tool-execution.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { required } from "../src/invariants.ts";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: vi.fn(() => completedProcess()),
}));

const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("repeated Rust installation reuses its version offline and reconciles newly requested components and targets", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-rust-install-"));
  temporary.push(root);
  for (const directory of ["workbench", "cargo/bin", "rustup/toolchains/1.2.3-fixture"])
    mkdirSync(join(root, directory), { recursive: true });
  for (const [name, value] of Object.entries({
    WORKBENCH_DISTRIBUTION_ROOT: resolve(import.meta.dirname, ".."),
    WORKBENCH_CONFIG_HOME: join(root, "config"),
    WORKBENCH_CACHE_HOME: join(root, "cache"),
    WORKBENCH_STATE_HOME: join(root, "state"),
    WORKBENCH_DATA_HOME: join(root, "data"),
    CARGO_HOME: join(root, "cargo"),
    RUSTUP_HOME: join(root, "rustup"),
  }))
    vi.stubEnv(name, value);
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="fixture"\npath="."\n[[language_root]]\nlanguage="rust"\npath="."\n',
  );
  writeFileSync(
    join(root, "workbench/config.toml"),
    "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
  );
  const pin = (components: string[], targets: string[]) => {
    writeFileSync(
      join(root, "rust-toolchain.toml"),
      `[toolchain]\nchannel="1.2.3"\nprofile="minimal"\ncomponents=${JSON.stringify(components)}\ntargets=${JSON.stringify(targets)}\n`,
    );
  };
  const components = new Set(["rustfmt", "clippy"]),
    targets = new Set<string>();
  const unavailable = new Set<string>();
  vi.spyOn(execution, "execute").mockImplementation((command, args) => {
    if (command === "sh") return ""; // Executable probes are covered separately.
    if (command !== "rustup") throw new Error(`Unexpected executable: ${command}`);
    if (args[0] === "toolchain") {
      // rustup's no-update operation reuses an installed version but ignores component/target additions.
      if (!args.includes("--no-update")) throw new Error("release server is offline");
    } else if (args[0] === "component" || args[0] === "target") {
      const installed = args[0] === "component" ? components : targets;
      for (const name of args.slice(4)) {
        if (unavailable.has(name)) throw new Error(`Unavailable Rust component: ${name}`);
        installed.add(name);
      }
    } else if (args[0] === "which") return join(root, "executables", required(args.at(-1), "Rust executable"));
    else throw new Error(`Unexpected rustup operation: ${args.join(" ")}`);
    return "";
  });
  pin(["rustfmt", "clippy"], []);
  await installNativeTools(root, ".", {}, "rust");
  pin(["rustfmt", "clippy", "rust-src"], ["wasm32-unknown-unknown"]);
  await installNativeTools(root, ".", {}, "rust");
  expect(components).toEqual(new Set(["rustfmt", "clippy", "rust-src"]));
  expect(targets).toEqual(new Set(["wasm32-unknown-unknown"]));
  await installNativeTools(root, ".", {}, "rust");
  unavailable.add("rust-analyzer");
  pin(["rust-analyzer"], []);
  await expect(installNativeTools(root, ".", {}, "rust")).rejects.toThrow("Unavailable Rust component: rust-analyzer");
});
