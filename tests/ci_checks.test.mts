import { afterEach, expect, test, vi } from "vitest";
import { runCIChecks } from "../src/ci-checks.ts";
import * as targets from "../src/ci-targets.ts";
import * as gates from "../src/check-gates.ts";
import * as validation from "../src/validation.ts";
import { CheckNetwork } from "../scripts/check-network.mjs";
import { readCITargets } from "../scripts/ci-contract.mjs";
import { stageFixtures } from "./fixtures/check-stages.mjs";

const fixture = stageFixtures();
afterEach(() => {
  vi.restoreAllMocks();
});
function declared(path: string) {
  vi.spyOn(targets, "ciTargets").mockReturnValue(
    readCITargets([
      {
        id: "declared",
        path,
        kind: "native",
        os: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
        architecture: process.arch,
        environment: "native",
        release: false,
        phases: ["native-install", "native-check"],
        checks: [],
      },
    ]),
  );
}

test("empty network partitions validate a real complete gate while undeclared targets never execute", async () => {
  const { root } = fixture();
  declared("service");
  const run = vi.spyOn(gates, "runGate").mockResolvedValue(undefined);
  const validate = vi.spyOn(validation, "validate").mockResolvedValue(undefined);
  await runCIChecks(root, "service", "native", CheckNetwork.Online);
  expect(validate).toHaveBeenCalledExactlyOnceWith(root);
  expect(run).not.toHaveBeenCalled();
  await runCIChecks(root, "service", "native", CheckNetwork.Offline);
  expect(run).toHaveBeenCalledExactlyOnceWith(
    root,
    "check",
    expect.objectContaining({ stage: "ci", cache: false, network: CheckNetwork.Offline }),
  );
  run.mockClear();
  validate.mockClear();
  await expect(runCIChecks(root, "missing", "native", CheckNetwork.Online)).rejects.toThrow(
    /configured native platform/,
  );
  await expect(runCIChecks(root, "service", "native", CheckNetwork.Online, "unknown")).rejects.toThrow(
    /configured native platform/,
  );
  expect(run).not.toHaveBeenCalled();
  expect(validate).not.toHaveBeenCalled();
});

test("a completely empty CI gate retains the ordinary gate's allow-empty policy", async () => {
  const { root, config, save } = fixture();
  declared("service");
  config.check = [];
  save();
  const failure = new Error("ordinary empty gate rejected");
  const run = vi.spyOn(gates, "runGate").mockRejectedValue(failure);
  const validate = vi.spyOn(validation, "validate");
  await expect(runCIChecks(root, "service", "native", CheckNetwork.Online)).rejects.toBe(failure);
  expect(run).toHaveBeenCalledExactlyOnceWith(root, "check", expect.objectContaining({ network: CheckNetwork.All }));
  expect(validate).not.toHaveBeenCalled();
});
