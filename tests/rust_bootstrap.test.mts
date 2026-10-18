import { completedProcess } from "./fixtures/process.mjs";
import { required } from "../src/invariants.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as downloads from "../src/tool-downloads.ts";
import { ensureRustup } from "../src/native-tools.ts";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));
const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each([false, true])(
  "rustup bootstrap belongs to the selected Cargo home (already installed: %s)",
  async (installed) => {
    const root = mkdtempSync(join(tmpdir(), "workbench-rustup-home-"));
    temporary.push(root);
    vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "cache"));
    const cargo = join(root, "cargo"),
      binary = join(cargo, "bin", process.platform === "win32" ? "rustup.exe" : "rustup");
    const environment = { PATH: join(root, "host-bin"), CARGO_HOME: cargo, RUSTUP_HOME: join(root, "rustup") };
    vi.mocked(spawnSync).mockImplementation((command: string) =>
      completedProcess({
        status: command === "rustup" || (command === binary && installed) ? 0 : 1,
      }),
    );
    const acquire = vi.spyOn(downloads, "installAsset").mockResolvedValue(undefined);
    const execute = vi.spyOn(downloads, "execute").mockImplementation((_command, _args, options) => {
      mkdirSync(join(required(options?.env?.CARGO_HOME, "Cargo home"), "bin"), { recursive: true });
      writeFileSync(binary, "selected Cargo home proxy");
      return "";
    });
    if (installed) {
      mkdirSync(join(cargo, "bin"), { recursive: true });
      writeFileSync(binary, "existing selected proxy");
    }
    const result = await ensureRustup(resolve(import.meta.dirname, ".."), environment);
    expect(result).toMatchObject({ ...environment, PATH: `${join(cargo, "bin")}${delimiter}${environment.PATH}` });
    expect(spawnSync).toHaveBeenCalledWith(binary, ["--version"], expect.any(Object));
    expect(acquire).toHaveBeenCalledTimes(installed ? 0 : 1);
    expect(execute).toHaveBeenCalledTimes(installed ? 0 : 1);
    expect(readFileSync(binary, "utf8")).toBe(installed ? "existing selected proxy" : "selected Cargo home proxy");
  },
);
