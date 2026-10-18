import { required } from "../src/invariants.ts";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  watch,
} from "node:fs";
import { constants, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { decodeShellSession, interactiveShell, shellCommand, shellSession } from "../src/shell-session.ts";

function expectLauncherRemoved(path: string) {
  // PowerShell may prepend its own directory to PATH before starting the child.
  const bin = path.split(delimiter).find((entry: string) => basename(dirname(entry)).startsWith("workbench-shell-"));
  expect(bin).toBeDefined();
  expect(existsSync(dirname(required(bin, "Expected fixture value")))).toBe(false);
}

test("session requests validate registered roots, environment names, and every transported field", () => {
  const request = {
    path: "app",
    environment: "native",
    profile: "",
    toolchain: "",
    command: ["node", "literal argument"],
    plain: true,
    noColor: true,
  };
  expect(decodeShellSession(JSON.stringify(request), ["app"])).toEqual(request);
  for (const value of [
    null,
    [],
    {},
    { ...request, path: "../outside" },
    { ...request, command: ["node", 1] },
    { ...request, profile: null },
    { ...request, plain: "true" },
    { ...request, noColor: null },
  ] as const)
    expect(() => decodeShellSession(JSON.stringify(value), ["app"])).toThrow(/invalid shell session context/);
  for (const environment of ["invalid", "nix-docker"])
    expect(() => decodeShellSession(JSON.stringify({ ...request, environment }), ["app"])).toThrow(/environment/);
});

test("interactive shells follow the execution platform and Unix preference with startup files disabled", () => {
  expect(interactiveShell("linux", {})).toEqual(["bash", "--noprofile", "--norc", "-i"]);
  expect(interactiveShell("darwin", {})).toEqual(["/bin/zsh", "-f", "-i"]);
  expect(interactiveShell("linux", { SHELL: "/custom/zsh" })).toEqual(["/custom/zsh", "-f", "-i"]);
  expect(interactiveShell("darwin", { SHELL: "/custom/fish" })).toEqual([
    "/custom/fish",
    "--no-config",
    "--interactive",
  ]);
  expect(interactiveShell("linux", { SHELL: "/bin/sh" })).toEqual(["/bin/sh", "-i"]);
  expect(interactiveShell("linux", { SHELL: "/bin/tcsh" })).toEqual(["/bin/tcsh", "-f", "-i"]);
  const windows = interactiveShell("win32", { SHELL: "/bin/bash" });
  expect(windows[0]).toBe("pwsh");
  expect(windows).toContain("-NoProfile");
  expect(windows).toContain("-NoExit");
  expect(() => interactiveShell("linux", { SHELL: "/bin/bash -c injected" })).toThrow(/unsupported interactive shell/);
});

const hasPowerShell = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;
test.skipIf(!hasPowerShell)("PowerShell transport preserves literal native arguments and exit status", () => {
  const literals = ["", "white space", 'a"b', "a'b", "$(Write-Error injected); & echo unsafe", "%PATH%", "雪"];
  const invocation = shellCommand(
    [process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)))", ...literals],
    "win32",
  );
  const result = spawnSync(required(invocation[0], "Expected fixture value"), invocation.slice(1), {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(literals);
  const failure = shellCommand([process.execPath, "-e", "process.exit(23)"], "win32");
  expect(spawnSync(required(failure[0], "Expected fixture value"), failure.slice(1)).status).toBe(23);
});

test.skipIf(process.platform !== "win32")(
  "Windows command sessions discover the private cmd launcher and retain arguments and status",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-windows shell-'")));
    try {
      mkdirSync(join(root, "bundle"));
      writeFileSync(
        join(root, "bundle/main.cjs"),
        "require('node:fs').writeFileSync('nested.json',JSON.stringify({args:process.argv.slice(2),path:process.env.PATH}));process.exitCode=7;",
      );
      const literals = ["white space", "quote's", "雪"];
      const status = await shellSession(root, root, { path: ".", environment: "native", profile: "", toolchain: "" }, [
        "workbench.cmd",
        ...literals,
      ]);
      expect(status).toBe(7);
      const result = JSON.parse(readFileSync(join(root, "nested.json"), "utf8")) as { args: string[]; path: string };
      expect(result.args).toEqual(literals);
      expectLauncherRemoved(result.path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.each([0, 7])(
  "sessions export context, preserve literal arguments, and clean launchers after exit %i",
  async (code) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-shell-session-")));
    try {
      for (const key of ["TMP", "TEMP", "TMPDIR"]) vi.stubEnv(key, root);
      const app = join(root, "app");
      mkdirSync(app);
      const output = join(root, "result.json");
      const literal = "$(touch unwanted); ' quoted";
      const script = `require('node:fs').writeFileSync(process.argv[1], JSON.stringify({cwd:process.cwd(),root:process.env.WORKBENCH_PROJECT_ROOT,directory:process.env.WORKBENCH_SHELL_ROOT,environment:process.env.WORKBENCH_SHELL_ENVIRONMENT,profile:process.env.WORKBENCH_DEVELOPMENT_PROFILE,tools:process.env.WORKBENCH_TOOLCHAIN,path:process.env.PATH,argument:process.argv[2]})); process.exit(${String(code)});`;
      const status = await shellSession(
        root,
        resolve(import.meta.dirname, ".."),
        { path: "app", environment: "native", profile: "selected", toolchain: "node-latest" },
        [process.execPath, "-e", script, output, literal],
      );
      expect(status).toBe(code);
      const result = JSON.parse(readFileSync(output, "utf8")) as { args: string[]; path: string };
      expect(result).toMatchObject({
        cwd: app,
        root,
        directory: app,
        environment: "native",
        profile: "selected",
        tools: "node-latest",
        argument: literal,
      });
      expectLauncherRemoved(result.path);
      expect(existsSync(join(app, "unwanted"))).toBe(false);
      expect(readdirSync(root).some((name) => name.startsWith("workbench-shell-"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("launch failure removes private session files and restores signal listeners", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-shell-failure-")));
  try {
    for (const key of ["TMP", "TEMP", "TMPDIR"]) vi.stubEnv(key, root);
    vi.stubEnv("PATH", root);
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    await expect(
      shellSession(root, root, { path: ".", environment: "native", profile: "", toolchain: "" }, [
        join(root, "missing-command"),
      ]),
    ).rejects.toThrow(/cannot start/);
    expect(readdirSync(root)).toEqual([]);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "nested Bash, zsh, and fish commands discover the selected distribution without exported functions",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-shell-nested-")));
    try {
      mkdirSync(join(root, "bundle"));
      writeFileSync(
        join(root, "bundle/main.cjs"),
        "require('node:fs').writeFileSync('nested.json',JSON.stringify({args:process.argv.slice(2),root:process.env.WORKBENCH_SHELL_ROOT}));",
      );
      for (const shell of ["bash", "zsh", "fish"]) {
        if (spawnSync(shell, ["--version"]).status !== 0) continue;
        expect(
          await shellSession(root, root, { path: ".", environment: "nix", profile: "", toolchain: "" }, [
            shell,
            "-c",
            "workbench 'literal argument'",
          ]),
        ).toBe(0);
        expect(JSON.parse(readFileSync(join(root, "nested.json"), "utf8"))).toEqual({
          args: ["literal argument"],
          root,
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32").each(["SIGINT", "SIGTERM", "SIGKILL", "SIGHUP"] as const)(
  "sessions preserve child termination by %s",
  async (signal) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-shell-signal-")));
    try {
      for (const name of ["TMP", "TEMP", "TMPDIR"]) vi.stubEnv(name, root);
      expect(
        await shellSession(root, root, { path: ".", environment: "native", profile: "", toolchain: "" }, [
          process.execPath,
          "-e",
          "process.kill(process.pid,process.argv[1])",
          signal,
        ]),
      ).toBe(128 + constants.signals[signal]);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")("termination drains the session child and removes its launcher", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-shell-termination-")));
  let pending;
  const state = { settled: false };
  let observer: import("node:fs").FSWatcher | undefined, watchdog: NodeJS.Timeout | undefined;
  try {
    const ready = join(root, "ready.json");
    const started = new Promise<void>((resolve, reject) => {
      observer = watch(root, () => {
        if (existsSync(ready)) resolve();
      });
      observer.on("error", reject);
      watchdog = setTimeout(() => {
        reject(new Error("session child did not report readiness"));
      }, 15000);
    });
    pending = shellSession(root, root, { path: ".", environment: "native", profile: "", toolchain: "" }, [
      process.execPath,
      "-e",
      `const fs = require("node:fs");
const ready = process.argv[1];
fs.writeFileSync(ready + ".tmp", JSON.stringify({path: process.env.PATH}));
fs.renameSync(ready + ".tmp", ready);
setInterval(() => {}, 1000);`,
      ready,
    ]);
    void pending.then(
      () => {
        state.settled = true;
      },
      () => {
        state.settled = true;
      },
    );
    await Promise.race([
      started,
      pending.then(() => {
        throw new Error("session child exited before readiness");
      }),
    ]);
    expect(existsSync(ready)).toBe(true);
    process.emit("SIGTERM");
    expect(await pending).toBe(143);
    const path = (JSON.parse(readFileSync(ready, "utf8")) as { path: string }).path.split(delimiter)[0];
    expect(existsSync(dirname(required(path, "Expected fixture value")))).toBe(false);
  } finally {
    observer?.close();
    clearTimeout(watchdog);
    if (!state.settled) process.emit("SIGTERM");
    await pending?.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
