import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { MicrosoftSDKResolver, microsoftEnvironment, mvscLayout, type MicrosoftSDKHost } from "../src/mvsc.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-sdk-layout-"));
  temporary.push(root);
  writeFileSync(join(root, ".windows-sdk-version"), "10.0.26100.0");
  const layout = mvscLayout("C:\\VS space 雪", "14.44.35207", "D:\\SDK", "10.0.26100.0");
  const filePath = (path: string) => join(root, ...path.replaceAll(":", "").split(/[\\/]/));
  for (const path of [...layout.include, ...layout.lib, ...layout.paths]) {
    mkdirSync(filePath(path), { recursive: true });
    writeFileSync(join(filePath(path), "component.bin"), "initial");
  }
  for (const path of [layout.compiler, layout.linker, layout.resource, layout.manifest]) {
    mkdirSync(dirname(filePath(path)), { recursive: true });
    writeFileSync(filePath(path), "executable");
  }
  const run = vi.fn((command: string) => ({
    status: 0,
    stdout: command.endsWith("vswhere.exe") ? `${layout.installation}\r\n` : `KitsRoot10 REG_SZ D:\\SDK\\\r\n`,
    stderr: "",
  }));
  const host: MicrosoftSDKHost = {
    platform: "win32",
    architecture: "x64",
    environment: { "ProgramFiles(x86)": "C:\\Programs", SystemRoot: "C:\\OS" },
    filePath,
    run,
  };
  return { root, layout, host, filePath, run };
}
test("complete SDK components include STL and Windows libraries; each operation owns one identity", () => {
  const f = fixture(),
    resolver = new MicrosoftSDKResolver(f.host),
    first = resolver.resolve(f.root, "14.44.35207");
  expect(resolver.resolve(f.root, "14.44.35207")).toBe(first);
  expect(f.run).toHaveBeenCalledTimes(2);
  writeFileSync(join(f.filePath(f.layout.include[0] ?? ""), "vector"), "serviced STL");
  const stl = new MicrosoftSDKResolver(f.host).resolve(f.root, "14.44.35207");
  expect(stl.fingerprint).not.toBe(first.fingerprint);
  writeFileSync(join(f.filePath(f.layout.lib[2] ?? ""), "kernel32.lib"), "serviced UM");
  expect(new MicrosoftSDKResolver(f.host).resolve(f.root, "14.44.35207").fingerprint).not.toBe(stl.fingerprint);
  const env = microsoftEnvironment(first, { CL: "/O1", Path: "C:\\Git" });
  expect(env.CL).toBeUndefined();
  expect(env.WORKBENCH_MVSC_IDENTITY).toBe(first.fingerprint);
  expect(env.Path).toBeUndefined();
  expect(env.PATH).toContain("C:\\Git");
  expect(f.run.mock.calls[0]?.[0]).toContain("C:\\Programs");
  expect(f.run.mock.calls[1]?.[0]).toBe(win32.join("C:\\OS", "System32", "reg.exe"));
});
test("an incomplete first installation is skipped and missing SDK components produce pinned setup guidance", () => {
  const f = fixture();
  f.run.mockImplementation((command) => ({
    status: 0,
    stdout: command.endsWith("vswhere.exe")
      ? `C:\\incomplete\r\n${f.layout.installation}\r\n`
      : "KitsRoot10 REG_SZ D:\\SDK",
    stderr: "",
  }));
  expect(new MicrosoftSDKResolver(f.host).resolve(f.root, "14.44.35207").layout.installation).toBe(
    f.layout.installation,
  );
  rmSync(f.filePath(f.layout.manifest));
  expect(() => new MicrosoftSDKResolver(f.host).resolve(f.root, "14.44.35207")).toThrow(
    /install MSVC toolset 14.44.35207 and Windows SDK/,
  );
});
test("host and discovery failures retain their cause without executing a compiler", () => {
  const f = fixture();
  expect(() => new MicrosoftSDKResolver({ ...f.host, architecture: "arm64" }).resolve(f.root, "14.44.35207")).toThrow(
    /native Windows x64/,
  );
  f.run.mockReturnValue({ status: 1, stdout: "", stderr: "fixture SDK registration failure" });
  expect(() => new MicrosoftSDKResolver(f.host).resolve(f.root, "14.44.35207")).toThrow(/Desktop development/);
  f.run.mockImplementation((command) => ({
    status: 0,
    stdout: command.endsWith("vswhere.exe") ? f.layout.installation : "",
    stderr: "fixture SDK registration failure",
  }));
  expect(() => new MicrosoftSDKResolver(f.host).resolve(f.root, "14.44.35207")).toThrow(/SDK installation root/);
  expect(f.run.mock.calls.every(([command]) => /(?:vswhere|reg)\.exe$/.test(command))).toBe(true);
});
