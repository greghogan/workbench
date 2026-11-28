import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { runWindowsStartup } from "../../../../../scripts/check-windows-startup-vm.mts";

const fixtures: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-windows-startup-test-"));
  fixtures.push(root);
  const tools = join(root, "bin");
  const scratch = join(root, "scratch");
  const artifacts = join(root, "artifacts");
  for (const directory of [tools, scratch, artifacts]) mkdirSync(directory);
  vi.stubEnv("PATH", tools);
  vi.stubEnv("TMPDIR", scratch);
  vi.stubEnv("WORKBENCH_EXTENDED_ARTIFACTS", artifacts);
  vi.stubEnv("WINDOWS_STARTUP_TEST_MARKER", join(root, "guest-started"));
  const write = (path: string, contents: string) => {
    writeFileSync(path, contents);
    return { path, sha256: createHash("sha256").update(contents).digest("hex") };
  };
  const image = write(join(root, "base.qcow2"), "verified image bytes");
  const node = write(join(root, "node.exe"), "verified Windows runtime bytes");
  const firmware = {
    code: write(join(root, "code.fd"), "verified firmware"),
    variables: write(join(root, "variables.fd"), "original variables"),
  };
  const archive = write(join(artifacts, "workbench.tar.gz"), "verified candidate");
  writeFileSync(join(artifacts, "SHA256SUMS"), `${archive.sha256}  workbench.tar.gz\n`);
  const install = (executable: string, script: string) => {
    writeFileSync(join(tools, executable), `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
  };
  const prepare = () => {
    install(
      "qemu-img",
      `const { writeFileSync } = require("node:fs");
        if (process.argv[2] === "info") console.log(JSON.stringify({ format: "qcow2" }));
        else writeFileSync(process.argv.at(-1), "fresh overlay");`,
    );
    install(
      "virt-customize",
      `const { existsSync } = require("node:fs");
        const payload = process.argv[process.argv.indexOf("--copy-in") + 1].slice(0,-2);
        if (!existsSync(payload + "/verify.ps1") || !existsSync(payload + "/node.exe")) process.exit(1);`,
    );
  };
  return { image, node, firmware, install, prepare, scratch, marker: join(root, "guest-started") };
}

test.skipIf(process.platform === "win32")(
  "Windows startup reports both guest results and discards the overlay",
  async () => {
    const { image, node, firmware, install, prepare, scratch } = fixture();
    prepare();
    install(
      "qemu-system-x86_64",
      `const fs = require("node:fs");
      if (!process.argv.includes("if=pflash,format=raw,file=uefi-vars.fd")) process.exit(1);
      fs.writeFileSync("uefi-vars.fd", "modified variables");
      console.log("discard private guest output");
      console.log("WB-TEST PASS SCM automatically started the listener");
      console.log("WB-TEST PASS Task Scheduler automatically started the listener");
      console.log("WB-TEST PASS BOTH WINDOWS STARTUP CHECKS");
      setInterval(() => {}, 1000);`,
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runWindowsStartup({ image, node, firmware }, AbortSignal.timeout(5000));
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenNthCalledWith(1, "PASS Windows SCM started the shared service before sign-in.");
    expect(log).toHaveBeenNthCalledWith(
      2,
      "PASS Windows Task Scheduler started the private service at ordinary-user sign-in.",
    );
    expect(readdirSync(scratch)).toEqual([]);
    expect(readFileSync(image.path, "utf8")).toBe("verified image bytes");
    expect(readFileSync(firmware.variables.path, "utf8")).toBe("original variables");
  },
);

test.skipIf(process.platform === "win32")(
  "Windows startup explains missing tools and removes canceled guests",
  async () => {
    const { image, node, install, prepare, marker } = fixture();
    await expect(runWindowsStartup({ image, node }, AbortSignal.timeout(5000))).rejects.toThrow(/requires qemu-img/);
    prepare();
    install(
      "qemu-system-x86_64",
      `require("node:fs").writeFileSync(process.env.WINDOWS_STARTUP_TEST_MARKER, process.cwd());
      setInterval(() => {}, 1000);`,
    );
    const stop = new AbortController();
    const result = expect(runWindowsStartup({ image, node }, stop.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    try {
      await expect.poll(() => existsSync(marker), { timeout: 5000 }).toBe(true);
    } finally {
      stop.abort();
    }
    await result;
    expect(existsSync(readFileSync(marker, "utf8"))).toBe(false);
    expect(readFileSync(image.path, "utf8")).toBe("verified image bytes");
  },
);
