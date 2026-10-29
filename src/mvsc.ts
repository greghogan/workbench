import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync, lstatSync } from "node:fs";
import { join, win32 } from "node:path";

/** The public compiler family is mvsc; the installed toolset is Microsoft's MSVC. */
export function windowsSDKVersion(directory: string): string {
  const version = readFileSync(join(directory, ".windows-sdk-version"), "utf8").trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version))
    throw new Error(".windows-sdk-version must pin an exact four-component Windows SDK version");
  return version;
}
export function mvscLayout(installation: string, toolset: string, sdkRoot: string, sdk: string) {
  if (!/^\d+\.\d+\.\d+$/.test(toolset) || !/^\d+\.\d+\.\d+\.\d+$/.test(sdk))
    throw new Error("mvsc requires exact MSVC toolset and Windows SDK pins");
  const tools = win32.join(installation, "VC", "Tools", "MSVC", toolset);
  const bin = win32.join(tools, "bin", "Hostx64", "x64");
  sdkRoot = win32.resolve(sdkRoot);
  return {
    installation,
    toolset,
    sdk,
    tools,
    sdkRoot,
    compiler: win32.join(bin, "cl.exe"),
    linker: win32.join(bin, "link.exe"),
    resource: win32.join(sdkRoot, "bin", sdk, "x64", "rc.exe"),
    manifest: win32.join(sdkRoot, "bin", sdk, "x64", "mt.exe"),
    include: [
      win32.join(tools, "include"),
      ...["ucrt", "shared", "um", "winrt", "cppwinrt"].map((part) => win32.join(sdkRoot, "Include", sdk, part)),
    ],
    lib: [
      win32.join(tools, "lib", "x64"),
      ...["ucrt", "um"].map((part) => win32.join(sdkRoot, "Lib", sdk, part, "x64")),
    ],
    paths: [bin, win32.join(sdkRoot, "bin", sdk, "x64")],
  };
}
type Layout = ReturnType<typeof mvscLayout>;
export interface MicrosoftSDKHost {
  platform: NodeJS.Platform;
  architecture: string;
  environment: NodeJS.ProcessEnv;
  /** Tests map Windows installation paths into an actual disposable filesystem. */
  filePath: (path: string) => string;
  run: (command: string, args: string[]) => { status: number | null; stdout: string; stderr: string; error?: Error };
}
export function microsoftHost(environment: NodeJS.ProcessEnv): MicrosoftSDKHost {
  environment = { ...environment };
  return {
    platform: process.platform,
    architecture: process.arch,
    environment: { ...environment },
    filePath: (path) => path,
    run: (command, args) => spawnSync(command, args, { env: environment, encoding: "utf8", windowsHide: true }),
  };
}
interface ComponentIdentity {
  path: string;
  digest: string;
  files: number;
  bytes: number;
}
export interface ResolvedMicrosoftSDK {
  layout: Layout;
  identity: { version: 2; toolset: string; sdk: string; components: ComponentIdentity[] };
  fingerprint: string;
}

/** Hash complete selected components with bounded memory, including libraries and serviced compiler helpers. */
export function microsoftComponent(path: string, filePath: (path: string) => string): ComponentIdentity {
  const hash = createHash("sha256"),
    buffer = Buffer.alloc(1024 * 1024);
  let files = 0,
    bytes = 0;
  const visit = (directory: string, relative: string) => {
    for (const name of readdirSync(directory).sort()) {
      const native = join(directory, name),
        key = `${relative}${name}`;
      const info = lstatSync(native, { bigint: true });
      if (info.isSymbolicLink()) throw new Error(`mvsc: SDK components must not traverse links: ${native}`);
      hash.update(JSON.stringify([key, info.isDirectory() ? "directory" : "file", String(info.size)]));
      if (info.isDirectory()) visit(native, `${key}/`);
      else if (info.isFile()) {
        const fd = openSync(native, "r");
        try {
          let count: number;
          while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
        } finally {
          closeSync(fd);
        }
        const after = statSync(native, { bigint: true });
        if (info.size !== after.size || info.mtimeNs !== after.mtimeNs || info.ctimeNs !== after.ctimeNs)
          throw new Error(`mvsc: SDK changed while resolving ${native}; retry after servicing completes`);
        files++;
        bytes += Number(info.size);
      } else throw new Error(`mvsc: unsupported SDK component: ${native}`);
    }
  };
  visit(filePath(path), "");
  return { path, digest: hash.digest("hex"), files, bytes };
}

/** An instance owns one operation's snapshot; a new operation observes SDK servicing. */
export class MicrosoftSDKResolver {
  private readonly resolved = new Map<string, ResolvedMicrosoftSDK>();
  constructor(private readonly host: MicrosoftSDKHost = microsoftHost(process.env)) {}
  resolve(directory: string, toolset: string): ResolvedMicrosoftSDK {
    const host = this.host;
    if (host.platform !== "win32" || host.architecture !== "x64") throw new Error("mvsc requires native Windows x64");
    const sdk = windowsSDKVersion(directory),
      programFiles = host.environment["ProgramFiles(x86)"];
    if (!programFiles) throw new Error("mvsc: Windows ProgramFiles(x86) is unavailable");
    const key = JSON.stringify([toolset, sdk]);
    const prior = this.resolved.get(key);
    if (prior) return prior;
    const found = host.run(win32.join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe"), [
      "-products",
      "*",
      "-sort",
      "-utf8",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property",
      "installationPath",
    ]);
    if (found.error || found.status !== 0)
      throw new Error(
        "mvsc: install Visual Studio or Build Tools with Desktop development with C++, including the pinned MSVC toolset and Windows SDK",
        { cause: found.error ?? new Error(found.stderr) },
      );
    const registry = host.run(win32.join(host.environment.SystemRoot ?? "C:\\Windows", "System32", "reg.exe"), [
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots",
      "/v",
      "KitsRoot10",
      "/reg:32",
    ]);
    const sdkRoot = registry.status === 0 ? /KitsRoot10\s+REG_SZ\s+(.+)/.exec(registry.stdout)?.[1]?.trim() : undefined;
    if (!sdkRoot)
      throw new Error("mvsc: Windows SDK installation root is unavailable; install the pinned SDK", {
        cause: registry.error ?? new Error(registry.stderr),
      });
    const directoryExists = (path: string) => {
      try {
        return statSync(host.filePath(path)).isDirectory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    };
    const fileExists = (path: string) => {
      try {
        return statSync(host.filePath(path)).isFile();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    };
    for (const installation of found.stdout.trim().split(/\r?\n/).filter(Boolean)) {
      const layout = mvscLayout(installation, toolset, sdkRoot, sdk);
      if (
        ![layout.compiler, layout.linker, layout.resource, layout.manifest].every(fileExists) ||
        ![...layout.include, ...layout.lib].every(directoryExists)
      )
        continue;
      const components = [...layout.paths, ...layout.include, ...layout.lib].map((path) =>
        microsoftComponent(path, host.filePath),
      );
      const identity = { version: 2 as const, toolset, sdk, components };
      const value = {
        layout,
        identity,
        fingerprint: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
      };
      this.resolved.set(key, value);
      return value;
    }
    throw new Error(
      `mvsc: install MSVC toolset ${toolset} and Windows SDK ${sdk} using Visual Studio Installer; no complete matching Windows x64 installation was found`,
    );
  }
}

const operations = new AsyncLocalStorage<Map<string, MicrosoftSDKResolver>>();
export function withMicrosoftSDKOperation<T>(action: () => T): T {
  return operations.run(new Map(), action);
}
export function resolveMicrosoftSDK(
  directory: string,
  toolset: string,
  base: NodeJS.ProcessEnv = process.env,
): ResolvedMicrosoftSDK {
  const operation = operations.getStore();
  if (!operation) return new MicrosoftSDKResolver(microsoftHost(base)).resolve(directory, toolset);
  const key = JSON.stringify([base["ProgramFiles(x86)"], base.SystemRoot]);
  let resolver = operation.get(key);
  if (!resolver) {
    resolver = new MicrosoftSDKResolver(microsoftHost(base));
    operation.set(key, resolver);
  }
  return resolver.resolve(directory, toolset);
}

export function microsoftEnvironment(resolved: ResolvedMicrosoftSDK, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { layout } = resolved,
    env = { ...base };
  const path = Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "";
  for (const name of Object.keys(env))
    if (
      /^(?:PATH|CL|_CL_|LINK|_LINK_|INCLUDE|LIB|LIBPATH|CC|CXX|CFLAGS|CXXFLAGS|CPPFLAGS|LDFLAGS|CPATH|C_INCLUDE_PATH|CPLUS_INCLUDE_PATH|LIBRARY_PATH|CMAKE_PREFIX_PATH|VCToolsInstallDir|VCToolsVersion|WindowsSdkDir|WindowsSDKVersion|UniversalCRTSdkDir|UCRTVersion)$/i.test(
        name,
      )
    )
      Reflect.deleteProperty(env, name);
  return {
    ...env,
    PATH: [...layout.paths, path].join(";"),
    INCLUDE: layout.include.join(";"),
    LIB: layout.lib.join(";"),
    LIBPATH: layout.lib.join(";"),
    VCToolsInstallDir: `${layout.tools}\\`,
    VCToolsVersion: layout.toolset,
    WindowsSdkDir: `${layout.sdkRoot}\\`,
    WindowsSDKVersion: `${layout.sdk}\\`,
    UniversalCRTSdkDir: `${layout.sdkRoot}\\`,
    UCRTVersion: layout.sdk,
    WORKBENCH_CC: layout.compiler.replaceAll("\\", "/"),
    WORKBENCH_CXX: layout.compiler.replaceAll("\\", "/"),
    WORKBENCH_MVSC_IDENTITY: resolved.fingerprint,
    VSLANG: "1033",
  };
}
