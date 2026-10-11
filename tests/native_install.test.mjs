import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { archivePath, download, execute, installAsset } from "../src/tool-downloads.ts";
import { installNativeTools, nativeEnvironment, listNativeTools } from "../src/native-tools.ts";
import { nativeTools, assetFor, toolDirectory } from "../src/native-assets.ts";
import { ciMatrix } from "../src/ci.ts";
import { userDirectory } from "../src/storage.ts";
import { acquisitionIdentity, acquisitionProvenance, filterIdentity } from "../src/artifact-policy.ts";
import * as core from "../src/core.ts";

const temporary = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-install-"));
  temporary.push(root);
  vi.stubEnv("WORKBENCH_DATA_HOME", join(root, "data"));
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "cache"));
  return root;
}
function asset(bytes, extra = {}) {
  return {
    url: "https://tools.example/tool",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    format: "binary",
    bin: ".",
    strip: 0,
    executable: "checker",
    authenticationUnavailable: {
      reason: "Unsigned local test fixture",
      source: "https://tools.example/tool",
      checked: "2026-10-09",
    },
    ...extra,
  };
}
function serve(bytes) {
  const fetcher = vi.fn(() => Promise.resolve(new Response(bytes)));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
// Construct small ustar fixtures so archive checks test real extractors without external downloads.
function tar(entries) {
  const blocks = [];
  for (const { name, content = "", type = "0", link = "" } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000755\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write(link, 157, 100);
    header.write("ustar\0", 257);
    header.write("00", 263);
    header.write(
      `${header
        .reduce((sum, value) => sum + value, 0)
        .toString(8)
        .padStart(6, "0")}\0 `,
      148,
    );
    blocks.push(header);
    if (content) {
      const body = Buffer.alloc(Math.ceil(content.length / 512) * 512);
      body.write(content);
      blocks.push(body);
    }
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

test("verified downloads are reusable; corrupt responses and caches never become installations", async () => {
  const root = fixture();
  const bytes = "#!/bin/sh\nprintf 'ready'\n";
  const pinned = asset(bytes);
  const fetcher = serve(bytes);
  const path = await download(pinned);
  expect(readFileSync(path, "utf8")).toBe(bytes);
  expect(await download(pinned)).toBe(path);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const installation = join(root, "installed");
  await installAsset(installation, pinned);
  expect(readFileSync(join(installation, "checker"), "utf8")).toBe(bytes);
  await installAsset(installation, pinned);
  writeFileSync(join(installation, ".workbench-artifact"), "different");
  await expect(installAsset(installation, pinned)).rejects.toThrow(/receipt/);
  writeFileSync(path, "corrupted");
  await expect(download(pinned)).rejects.toThrow(/cached artifact checksum/);
  rmSync(path);
  serve("wrong response");
  await expect(installAsset(join(root, "rejected"), pinned)).rejects.toThrow(/checksum/);
  expect(existsSync(join(root, "rejected"))).toBe(false);
  expect(readdirSync(join(root, "cache/downloads"))).toEqual([]);
  mkdirSync(join(root, "foreign"));
  await expect(installAsset(join(root, "foreign"), pinned)).rejects.toThrow(/refusing to overwrite/);
});

test.skipIf(process.platform !== "linux")(
  "GCC source installation verifies prerequisites and publishes only the staged installation",
  async () => {
    const root = fixture();
    const destination = join(root, "installed gcc");
    const bytes = tar([
      { name: "gcc/", type: "5" },
      { name: "gcc/contrib/", type: "5" },
      {
        name: "gcc/contrib/download_prerequisites",
        content: '#!/bin/sh\n[ "$1" = --verify ] && [ "$2" = --sha512 ] && [ "$3" = --no-isl ]\n',
      },
      {
        name: "gcc/configure",
        content:
          '#!/bin/sh\nprefix=${1#--prefix=}\ncat > Makefile <<EOF\nall:\n\t@true\ninstall-strip:\n\tmkdir -p "\\$(DESTDIR)$prefix/bin"\n\tprintf installed > "\\$(DESTDIR)$prefix/bin/gcc"\nEOF\n',
      },
    ]);
    serve(bytes);
    const pinned = asset(bytes, { format: "tar", strip: 1, bin: "bin", build: "gcc" });
    if (process.platform !== "linux") {
      await expect(installAsset(destination, pinned)).rejects.toThrow(/currently supports Linux/);
      expect(existsSync(destination)).toBe(false);
      return;
    }
    await installAsset(destination, pinned);
    expect(readFileSync(join(destination, "bin/gcc"), "utf8")).toBe("installed");
    expect(readFileSync(join(destination, ".workbench-artifact"), "utf8").trim()).toBe(pinned.sha256);
    expect(readdirSync(root).filter((name) => name.endsWith(".partial"))).toEqual([]);
    await installAsset(destination, pinned);
  },
);

test.skipIf(process.platform !== "linux")(
  "Debian runtimes retain libraries and licenses without cross-package documentation links",
  async () => {
    const root = fixture();
    writeFileSync(join(root, "debian-binary"), "2.0\n");
    writeFileSync(join(root, "control.tar.gz"), gzipSync(tar([])));
    const payload = (link) =>
      gzipSync(
        tar([
          { name: "./usr/lib/fixture/libxml2.so.2.9", content: "library" },
          { name: "./usr/lib/fixture/libxml2.so.2", type: "2", link },
          { name: "./usr/share/doc/libxml2/copyright", content: "license" },
          { name: "./usr/share/doc/libxml2/NEWS.gz", type: "2", link: "../libxml2-dev/NEWS.gz" },
        ]),
      );
    for (const [name, link] of [
      ["valid", "libxml2.so.2.9"],
      ["dangling", "missing-library"],
      ["escape", "../../../../outside"],
    ]) {
      writeFileSync(join(root, "data.tar.gz"), payload(link));
      const archive = join(root, `${name}.deb`);
      execute("ar", ["rc", archive, "debian-binary", "control.tar.gz", "data.tar.gz"], { cwd: root });
      const bytes = readFileSync(archive);
      serve(bytes);
      const destination = join(root, name);
      const installation = installAsset(destination, asset(bytes, { format: "deb", bin: "usr/lib/fixture" }));
      if (name === "valid") {
        await installation;
        expect(readFileSync(join(destination, "usr/lib/fixture/libxml2.so.2"), "utf8")).toBe("library");
        expect(readFileSync(join(destination, "usr/share/doc/libxml2/copyright"), "utf8")).toBe("license");
        expect(
          lstatSync(join(destination, "usr/share/doc/libxml2/NEWS.gz"), { throwIfNoEntry: false }),
        ).toBeUndefined();
      } else {
        await expect(installation).rejects.toThrow();
        expect(existsSync(destination)).toBe(false);
      }
      expect(readdirSync(root).some((entry) => entry.endsWith(".partial"))).toBe(false);
    }
  },
);

test("downloads reject transport downgrades, redirect loops, and interrupted streams", async () => {
  const root = fixture();
  const pinned = asset("payload");
  await expect(download({ ...pinned, sha256: "wrong" })).rejects.toThrow(/SHA-256/);
  await expect(download({ ...pinned, url: "http://tools.example/tool" })).rejects.toThrow(/HTTPS/);
  vi.stubGlobal(
    "fetch",
    async () => new Response(null, { status: 302, headers: { location: "http://tools.example/tool" } }),
  );
  await expect(download(pinned)).rejects.toThrow(/HTTPS/);
  vi.stubGlobal("fetch", async () => new Response(null, { status: 302, headers: { location: "/again" } }));
  await expect(download(pinned)).rejects.toThrow(/too many/);
  vi.stubGlobal("fetch", async () => new Response(null, { status: 302 }));
  await expect(download(pinned)).rejects.toThrow(/no location/);
  vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));
  await expect(download(pinned)).rejects.toThrow(/404/);
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("connection lost"));
          },
        }),
      ),
  );
  await expect(download(pinned)).rejects.toThrow(/connection lost/);
  expect(readdirSync(join(root, "cache/downloads"))).toEqual([]);
});

test("archive installation preserves valid content and rejects escapes before publication", async () => {
  const root = fixture();
  vi.stubEnv("LC_ALL", "C");
  const good = tar([
    { name: "tool/bin/checker", content: "hello" },
    { name: "tool/test/Þfoo.go", content: "test" },
    { name: "tool/bin/alias", type: "2", link: "checker" },
  ]);
  serve(good);
  await installAsset(join(root, "valid"), asset(good, { format: "tar", strip: 1, bin: "bin" }));
  expect(readFileSync(join(root, "valid/bin/checker"), "utf8")).toBe("hello");
  expect(readFileSync(join(root, "valid/test/Þfoo.go"), "utf8")).toBe("test");
  expect(readFileSync(join(root, "valid/bin/alias"), "utf8")).toBe("hello");
  symlinkSync(root, join(root, "checkout-alias"), "junction");
  await installAsset(join(root, "checkout-alias/aliased"), asset(good, { format: "tar", strip: 1, bin: "bin" }));
  expect(readFileSync(join(root, "aliased/bin/alias"), "utf8")).toBe("hello");
  for (const entries of [
    [{ name: "../escaped", content: "bad" }],
    [{ name: "tool/escape", type: "2", link: "../../escaped" }],
    [{ name: "tool/escape", type: "1", link: "../escaped" }],
    [{ name: "tool/pipe", type: "6" }],
    [
      { name: "tool/dir", type: "2", link: "target" },
      { name: "tool/dir/file", content: "bad" },
    ],
    [
      { name: "tool/file", content: "first" },
      { name: "tool/./file", content: "duplicate" },
    ],
    [{ name: "one/file" }, { name: "two/file" }],
  ]) {
    const bytes = tar(entries);
    serve(bytes);
    await expect(installAsset(join(root, "invalid"), asset(bytes, { format: "tar", strip: 1 }))).rejects.toThrow();
    expect(existsSync(join(root, "invalid"))).toBe(false);
    expect(existsSync(join(root, "escaped"))).toBe(false);
    expect(readdirSync(root).some((name) => name.endsWith(".partial"))).toBe(false);
  }
  for (const unsafe of ["/absolute", "a/../b", "C:drive", "a\\b", "line\nbreak", ""])
    expect(() => archivePath(unsafe)).toThrow(/unsafe/);
});

test("public installation honors declared pins and checks before altering unsupported roots", async () => {
  const root = fixture();
  const distribution = join(root, "distribution");
  mkdirSync(join(distribution, "scripts"), { recursive: true });
  mkdirSync(join(distribution, "languages"), { recursive: true });
  writeFileSync(join(distribution, "languages/index.toml"), "");
  mkdirSync(join(root, "workbench"));
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="app"\npath="."\n[[language_root]]\nlanguage="typescript"\npath="."\n',
  );
  writeFileSync(join(root, ".node-version"), "9.8.7");
  const bytes = "#!/bin/sh\nprintf 'v9.8.7\\n'\n";
  const pinned = asset(bytes, { executable: "node" });
  const metadata = { node: { "9.8.7": { [`${process.platform}-${process.arch}`]: pinned } } };
  writeFileSync(join(distribution, "scripts/native-assets.json"), JSON.stringify(metadata));
  const fetcher = serve(bytes);
  const before = nativeEnvironment(root, distribution).PATH;
  expect(before).toBe(process.env.PATH);
  // Tests use POSIX executable fixtures, as do the project's other shell contracts.
  if (process.platform !== "win32") {
    await installNativeTools(root);
    const env = nativeEnvironment(root, distribution);
    expect(execute("node", ["--version"], { env, capture: true }).trim()).toBe("v9.8.7");
    expect(env.PATH.split(delimiter)[0]).toContain(join(userDirectory("cache"), "toolchains", "node"));
    expect(existsSync(join(userDirectory("data"), "toolchains"))).toBe(false);
    expect(process.env.PATH).toBe(before);
    fetcher.mockClear();
    rmSync(userDirectory("cache"), { recursive: true });
    expect(nativeEnvironment(root, distribution).PATH).toBe(before);
    expect(fetcher).not.toHaveBeenCalled();
    await installNativeTools(root);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(execute("node", ["--version"], { env: nativeEnvironment(root, distribution), capture: true }).trim()).toBe(
      "v9.8.7",
    );
  }
  writeFileSync(join(root, ".node-version"), "9.8.8");
  fetcher.mockClear();
  await expect(installNativeTools(root)).rejects.toThrow(/no verified node 9.8.8 artifact/);
  expect(fetcher).not.toHaveBeenCalled();
  await expect(installNativeTools(root, "missing")).rejects.toThrow(/registered language root/);
  writeFileSync(join(root, ".tool-versions"), "node 9.8.8\n");
  expect(() => nativeTools(root)).toThrow(/duplicate native authority/);
});

test.skipIf(process.platform === "win32")(
  "selected installs probe their authenticated executable without requiring unrelated tools",
  async () => {
    const root = fixture();
    const distribution = join(root, "distribution");
    mkdirSync(join(distribution, "scripts"), { recursive: true });
    mkdirSync(join(distribution, "languages"), { recursive: true });
    writeFileSync(join(distribution, "languages/index.toml"), "");
    mkdirSync(join(root, "workbench"));
    writeFileSync(join(distribution, ".node-version"), "9.8.7");
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
    writeFileSync(
      join(root, "workbench/projects.toml"),
      '[[project]]\nid="app"\npath="."\n[[language_root]]\nlanguage="python"\npath="."\n',
    );
    writeFileSync(join(root, ".python-version"), "3.14.8");
    writeFileSync(join(root, ".tool-versions"), "uv 1.2.3\n");
    const hostBin = join(root, "host-bin");
    mkdirSync(hostBin);
    writeFileSync(join(hostBin, "uv"), '#!/bin/sh\nprintf "uv 1.2.3\\n"\n', { mode: 0o755 });
    vi.stubEnv("PATH", `${hostBin}${delimiter}${process.env.PATH}`);
    for (const actual of ["1.2.3", "1.2.4"]) {
      const bytes = `#!/bin/sh\n[ "$1" != python ] || exit 1\nprintf 'uv ${actual}\\n'\n`;
      const pinned = asset(bytes, { executable: "uv" });
      writeFileSync(
        join(distribution, "scripts/native-assets.json"),
        JSON.stringify({ uv: { "1.2.3": { [`${process.platform}-${process.arch}`]: pinned } } }),
      );
      const fetcher = serve(bytes);
      if (actual === "1.2.3") await installNativeTools(root, ".", {}, "uv");
      else await expect(installNativeTools(root, ".", {}, "uv")).rejects.toThrow(/expected 1.2.3/);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(existsSync(join(userDirectory("cache"), "toolchains", "node"))).toBe(false);
    }
    writeFileSync(join(root, ".tool-versions"), "unknown-package 1.2.3\n");
    await expect(installNativeTools(root, ".", {}, "unknown-package")).rejects.toThrow(
      /no explicit verification probes/,
    );
  },
);

test("selection preserves user defaults and separates native LLVM from managed headers", () => {
  const root = fixture();
  const distribution = resolve(import.meta.dirname, "..");
  writeFileSync(join(root, "rust-toolchain.toml"), '[toolchain]\nchannel="1.99.0"\n');
  vi.stubEnv("RUSTUP_TOOLCHAIN", "user-default");
  const rust = nativeEnvironment(root, distribution);
  expect(rust.RUSTUP_TOOLCHAIN).toBe("1.99.0");
  expect(process.env.RUSTUP_TOOLCHAIN).toBe("user-default");
  writeFileSync(join(root, ".llvm-version"), "23.1.3");
  const llvm = JSON.parse(readFileSync(join(distribution, "scripts/llvm-assets.json"), "utf8"))["23.1.3"][
    `${process.platform}-${process.arch}`
  ];
  if (llvm) {
    const filter = JSON.parse(readFileSync(join(distribution, "languages/c/llvm-filter.json"), "utf8"));
    if (process.platform === "win32") filter.required = filter.required.map((path) => `${path}.exe`);
    const location = join(
      userDirectory("cache"),
      "toolchains/llvm/23.1.3",
      `${process.platform}-${process.arch}`,
      `${llvm.sha256.slice(0, 16)}-${filterIdentity(filter).slice(0, 16)}-${acquisitionIdentity(assetFor(distribution, { name: "llvm", version: "23.1.3" }, root)).slice(0, 16)}`,
    );
    mkdirSync(location, { recursive: true });
    writeFileSync(join(location, ".workbench-artifact"), llvm.sha256);
    vi.stubEnv("CPATH", ["/gnu/store/managed/include", "/chosen/include"].join(delimiter));
    expect(nativeEnvironment(root, distribution).CPATH).toBe("/chosen/include");
  }
  vi.stubEnv("WORKBENCH_DATA_HOME", "relative");
  expect(() => userDirectory("data")).toThrow(/absolute/);
});

test("LLVM filters belong to the selected complete language definition", () => {
  const root = fixture();
  const distribution = resolve(import.meta.dirname, "..");
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  mkdirSync(join(root, "workbench/languages"), { recursive: true });
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="app"\npath="."\n[[language_root]]\nlanguage="c"\npath="."\n',
  );
  writeFileSync(join(root, ".llvm-version"), "23.1.3");
  const local = join(root, "workbench/languages/c");
  cpSync(join(distribution, "languages/c"), local, { recursive: true });
  const filterPath = join(local, "llvm-filter.json");
  const filter = JSON.parse(readFileSync(filterPath, "utf8"));
  filter.revision += 1;
  writeFileSync(filterPath, JSON.stringify(filter));
  if (process.platform === "win32") filter.required = filter.required.map((path) => `${path}.exe`);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    listNativeTools(root);
    expect(log.mock.calls.flat().join("\n")).toContain(`-${filterIdentity(filter).slice(0, 16)}`);
    rmSync(filterPath);
    expect(() => listNativeTools(root)).toThrow(/llvm-filter.json/);
  } finally {
    log.mockRestore();
  }
});

test("LLVM discovery separates archive and filter identities and exposes missing or mismatched installations", () => {
  const root = fixture();
  const distribution = resolve(import.meta.dirname, "..");
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  mkdirSync(join(root, "workbench"));
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="app"\npath="."\n[[language_root]]\nlanguage="c"\npath="."\n',
  );
  writeFileSync(join(root, ".llvm-version"), "23.1.3");
  const platform = `${process.platform}-${process.arch}`;
  const pinned = JSON.parse(readFileSync(join(distribution, "scripts/llvm-assets.json"), "utf8"))["23.1.3"][platform];
  const filter = JSON.parse(readFileSync(join(distribution, "languages/c/llvm-filter.json"), "utf8"));
  if (process.platform === "win32") filter.required = filter.required.map((path) => `${path}.exe`);
  const parent = join(userDirectory("cache"), "toolchains/llvm/23.1.3", platform);
  const current = toolDirectory(
    { name: "llvm", version: "23.1.3" },
    assetFor(distribution, { name: "llvm", version: "23.1.3" }, root),
  );
  const stale = [
    join(userDirectory("data"), "toolchains/llvm/23.1.3", platform, current.split(/[\\/]/).at(-1)),
    join(parent, "0".repeat(16)),
    join(parent, pinned.sha256.slice(0, 16)),
    join(parent, `${pinned.sha256.slice(0, 16)}-${"0".repeat(16)}`),
  ];
  for (const directory of stale) {
    mkdirSync(join(directory, "bin"), { recursive: true });
    writeFileSync(join(directory, ".workbench-artifact"), pinned.sha256);
  }
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const status = () => {
    log.mockClear();
    listNativeTools(root);
    return log.mock.calls.flat().find((line) => line.includes("llvm 23.1.3"));
  };
  try {
    expect(status()).toContain(`${current} [not installed]`);
    const paths = nativeEnvironment(root, distribution).PATH.split(delimiter);
    for (const directory of stale) expect(paths).not.toContain(join(directory, "bin"));
    mkdirSync(join(current, "bin"), { recursive: true });
    expect(status()).toContain("[incomplete installation]");
    writeFileSync(join(current, ".workbench-artifact"), "0".repeat(64));
    expect(status()).toContain("[receipt mismatch]");
    expect(nativeEnvironment(root, distribution).PATH.split(delimiter)).not.toContain(join(current, "bin"));
    writeFileSync(join(current, ".workbench-artifact"), pinned.sha256);
    expect(status()).toContain("[installed]");
    expect(nativeEnvironment(root, distribution).PATH.split(delimiter)[0]).toBe(join(current, "bin"));
    vi.stubEnv("WORKBENCH_DATA_HOME", join(root, "other-data"));
    expect(nativeEnvironment(root, distribution).PATH.split(delimiter)[0]).toBe(join(current, "bin"));
    const cache = userDirectory("cache");
    vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "other-cache"));
    expect(status()).toContain("[not installed]");
    expect(nativeEnvironment(root, distribution).PATH.split(delimiter)).not.toContain(join(current, "bin"));
    vi.stubEnv("WORKBENCH_CACHE_HOME", cache);
    rmSync(current, { recursive: true });
    expect(status()).toContain("[not installed]");
    expect(nativeEnvironment(root, distribution).PATH.split(delimiter)).not.toContain(join(current, "bin"));
  } finally {
    log.mockRestore();
  }
});

test("installer failures preserve exit status with inherited output and captured diagnostics", () => {
  for (const capture of [false, true]) {
    expect(() => execute(process.execPath, ["-e", "process.exit(23)"], { capture })).toThrow(/failed: exit 23/);
  }
  expect(() =>
    execute(process.execPath, ["-e", 'process.stderr.write("acquisition failed"); process.exit(23)'], {
      capture: true,
    }),
  ).toThrow(/failed: acquisition failed/);
  expect(execute(process.execPath, ["-e", "process.exit(0)"])).toBe("");
});

test("Linux ARM64 C/C++ installation resolves every required artifact and selects isolated compiler paths", async () => {
  const readText = core.readText;
  vi.spyOn(core, "readText").mockImplementation((path) =>
    path === "/etc/os-release" ? "ID=fixture\n" : readText(path),
  );
  const root = fixture();
  const distribution = resolve(import.meta.dirname, "..");
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const assets = JSON.parse(readFileSync(join(distribution, "scripts/native-assets.json"), "utf8"));
  const llvm = JSON.parse(readFileSync(join(distribution, "scripts/llvm-assets.json"), "utf8"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const arch = Object.getOwnPropertyDescriptor(process, "arch");
  mkdirSync(join(root, "workbench"));
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="app"\npath="."\n[[language_root]]\nlanguage="cpp"\npath="."\n' +
      'standard="20"\ncompiler="clang"\ncompilers.clang={minimum="21.1.8",ci_versions=["21.1.8"]}\n' +
      'compilers.gcc={minimum="14.4.0",ci_versions=["14.4.0","15.3.0","16.2.0"],ci_architectures=["x64","arm64"]}\n',
  );
  writeFileSync(join(root, ".llvm-version"), "23.1.3");
  writeFileSync(join(root, ".tool-versions"), "cmake 4.4.4\nninja 1.13.2\n");
  const fetcher = vi.fn(() => {
    throw new Error("unexpected network access");
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    Object.defineProperty(process, "arch", { ...arch, value: "arm64" });
    const filter = JSON.parse(readFileSync(join(distribution, "languages/cpp/llvm-filter.json"), "utf8"));
    const location = (name, version) =>
      toolDirectory({ name, version }, assetFor(distribution, { name, version }, root));
    for (const tool of nativeTools(root, distribution)) {
      const pinned =
        tool.name === "llvm" ? llvm[tool.version]["linux-arm64"] : assets[tool.name][tool.version]["linux-arm64"];
      const directory = location(tool.name, tool.version, pinned);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, ".workbench-artifact"), pinned.sha256);
      if (tool.name === "llvm") {
        const entries = filter.required.map((path) => {
          mkdirSync(join(directory, "bin"), { recursive: true });
          writeFileSync(join(directory, path), "");
          return {
            path,
            mode: lstatSync(join(directory, path)).mode & 0o777,
            bytes: 0,
            sha256: createHash("sha256").digest("hex"),
            type: "file",
          };
        });
        const fullAsset = assetFor(distribution, tool, root);
        const manifest = JSON.stringify({
          source: pinned.sha256,
          filter: filterIdentity(filter),
          policy: acquisitionIdentity(fullAsset),
          provenance: acquisitionProvenance(fullAsset),
          entries,
        });
        writeFileSync(join(directory, ".workbench-manifest.json"), manifest);
        writeFileSync(
          join(directory, ".workbench-manifest.sha256"),
          createHash("sha256").update(manifest).digest("hex"),
        );
      }
    }
    for (const version of ["14.4.0", "15.3.0", "16.2.0"]) {
      const pinned = assets.gcc[version]["linux-arm64"];
      expect(pinned).toEqual(assets.gcc[version]["linux-x64"]);
      const directory = location("gcc", version, pinned);
      mkdirSync(directory, { recursive: true });
      const selection = { compiler: "gcc", compilerVersion: version };
      await expect(installNativeTools(root, ".", selection)).rejects.toThrow(/foreign installation/);
      writeFileSync(join(directory, ".workbench-artifact"), pinned.sha256);
      const env = nativeEnvironment(root, distribution, selection);
      expect(env.WORKBENCH_CC).toBe(join(directory, "bin/gcc"));
      expect(env.WORKBENCH_CXX).toBe(join(directory, "bin/g++"));
      expect(env.PATH.split(delimiter)[0]).toBe(join(directory, "bin"));
      expect(env.LD_LIBRARY_PATH.split(delimiter)).toContain(join(directory, "lib"));
    }
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process, "arch", arch);
  }
});

test("every native CI platform resolves the declared native tool pins", () => {
  const readText = core.readText;
  vi.spyOn(core, "readText").mockImplementation((path) =>
    path === "/etc/os-release" ? "ID=fixture\n" : readText(path),
  );
  const distribution = resolve(import.meta.dirname, "..");
  const assets = JSON.parse(readFileSync(join(distribution, "scripts/native-assets.json"), "utf8"));
  const llvm = JSON.parse(readFileSync(join(distribution, "scripts/llvm-assets.json"), "utf8"));
  const bootstrap = JSON.parse(readFileSync(join(distribution, "scripts/bootstrap-tools.json"), "utf8"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const arch = Object.getOwnPropertyDescriptor(process, "arch");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    for (const target of ciMatrix(distribution).native.include) {
      const os = { linux: "linux", macos: "darwin", windows: "win32" }[target.os];
      Object.defineProperty(process, "platform", { ...platform, value: os });
      Object.defineProperty(process, "arch", { ...arch, value: target.architecture });
      listNativeTools(distribution, target.path);
      const key = `${os}-${target.architecture}`;
      for (const tool of nativeTools(resolve(distribution, target.path), distribution)) {
        if (tool.name === "python" || tool.name === "miri") continue;
        const name = tool.name === "rust" ? "rustup-init" : tool.name;
        const version = tool.name === "rust" ? bootstrap[name] : tool.version;
        const pinned = name === "llvm" ? llvm[version][key] : assets[name][version][key];
        expect(pinned, `${target.path}: ${name} ${version} on ${key}`).toBeDefined();
        expect(pinned.sha256).toMatch(/^[a-f0-9]{64}$/);
      }
    }
    expect(log.mock.calls.flat().join("\n")).not.toContain("no bundled installer");
  } finally {
    log.mockRestore();
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process, "arch", arch);
  }
});
