import { required } from "./invariants.js";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { userDirectory } from "./storage.js";

export interface ToolAsset {
  url: string;
  sha256: string;
  format: "tar" | "zip" | "binary";
  strip: number;
  bin: string;
  executable?: string;
  build?: "gcc";
}

export function commandInvocation(command: string, args: string[]): string[] {
  return process.platform === "win32"
    ? ["sh", "-eu", "-c", 'exec "$@"', "workbench-command", command.replaceAll("\\", "/"), ...args]
    : [command, ...args];
}

export function execute(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean; maxBuffer?: number } = {},
): string {
  const { capture, ...rest } = options;
  // Git Bash supplies literal argument forwarding for Windows package-manager shims.
  const invocation = commandInvocation(command, args);
  const result = spawnSync(required(invocation[0], "tool execution needs a command"), invocation.slice(1), {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...rest,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed: ${result.error?.message ?? ((capture ? result.stderr.trim() : "") || `exit ${String(result.status ?? result.signal)}`)}`,
    );
  return capture ? result.stdout : "";
}

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Redirects never downgrade transport. Content is verified before extraction or execution. */
export async function download(asset: Pick<ToolAsset, "url" | "sha256">): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error("tool artifact requires a recorded SHA-256 digest");
  let url = new URL(asset.url);
  if (url.protocol !== "https:") throw new Error("tool downloads require HTTPS, including redirects");
  const folder = join(userDirectory("cache"), "downloads");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const target = join(folder, `${asset.sha256}-${basename(url.pathname)}`);
  if (existsSync(target)) {
    if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink() || (await digest(target)) !== asset.sha256)
      throw new Error(`${target}: cached artifact checksum mismatch; remove it and retry installation`);
    return target;
  }
  const temporary = `${target}.${randomUUID()}.partial`;
  try {
    for (let redirects = 0; redirects < 10; redirects++) {
      if (url.protocol !== "https:") throw new Error("tool downloads require HTTPS, including redirects");
      const response = await fetch(url, { redirect: "manual" });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("tool download redirect has no location");
        url = new URL(location, url);
        continue;
      }
      if (!response.ok || !response.body)
        throw new Error(`tool download failed: ${String(response.status)}: ${url.origin}${url.pathname}`);
      await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      if ((await digest(temporary)) !== asset.sha256) throw new Error(`tool artifact checksum mismatch: ${asset.url}`);
      renameSync(temporary, target);
      return target;
    }
    throw new Error("too many tool download redirects");
  } finally {
    rmSync(temporary, { force: true });
  }
}

function unsafeArchiveText(value: string): boolean {
  return (
    /[\\:]/.test(value) ||
    value.split("").some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}

export function archivePath(path: string): string {
  if (!path || unsafeArchiveText(path) || path.startsWith("/") || path.split("/").includes(".."))
    throw new Error(`unsafe tool archive path: ${JSON.stringify(path)}`);
  return path.replace(/^\.\//, "").replace(/\/$/, "");
}

// tar quotes non-ASCII bytes under the C locale (for example, Go's Unicode test fixtures).
// Decode octal runs before path validation; control bytes and backslashes remain forbidden.
function archiveListing(value: string): string {
  return value.replace(/(?:\\[0-7]{3})+/g, (run) =>
    new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(
        required(run.match(/[0-7]{3}/g), "expected run.match(/[0-7]{3}/g)").map((byte) => Number.parseInt(byte, 8)),
      ),
    ),
  );
}

/** Inspect every member and link before the system extractor sees a private, empty destination. */
export function extractArchive(archive: string, destination: string, asset: ToolAsset): string {
  if (process.platform === "win32" && !process.env.SystemRoot)
    throw new Error("SystemRoot is required to locate Windows tar.exe");
  const tar =
    process.platform === "win32"
      ? join(required(process.env.SystemRoot, "expected process.env.SystemRoot"), "System32/tar.exe")
      : "tar";
  const zip = asset.format === "zip" && process.platform !== "win32";
  const members = archiveListing(
    execute(zip ? "unzip" : tar, zip ? ["-Z1", archive] : ["-tf", archive], {
      capture: true,
      maxBuffer: 128 * 1024 * 1024,
    }),
  )
    .trim()
    .split(/\r?\n/);
  members.forEach(archivePath);
  const listing = archiveListing(
    execute(zip ? "zipinfo" : tar, zip ? ["-l", archive] : ["-tvf", archive], {
      capture: true,
      maxBuffer: 128 * 1024 * 1024,
    }),
  );
  for (const line of listing.split(/\r?\n/)) {
    if (zip) {
      if (/^[lbcp]/.test(line)) throw new Error("ZIP tool archives must contain only files and directories");
    } else if (line) {
      if (!/^[dlh-]/.test(line)) throw new Error("tool archive contains a special file");
      if (/^[lh]/.test(line)) {
        const separator = line.startsWith("l") ? " -> " : " link to ";
        const index = line.lastIndexOf(separator);
        if (index < 0) throw new Error("cannot verify tool archive link");
        const target = line.slice(index + separator.length);
        if (!target || unsafeArchiveText(target) || target.startsWith("/"))
          throw new Error("unsafe tool archive link target");
        const member = members.find((name) => line.slice(0, index).endsWith(` ${name}`));
        if (!member) throw new Error("cannot identify tool archive link");
        const resolved = line.startsWith("l") ? posix.normalize(posix.join(posix.dirname(member), target)) : target;
        archivePath(resolved);
        if (asset.strip === 1 && resolved.split("/")[0] !== member.split("/")[0])
          throw new Error("tool archive link escapes its top directory");
      }
    }
  }
  execute(
    zip ? "unzip" : tar,
    zip ? ["-q", archive, "-d", destination] : ["-xf", archive, "--no-same-owner", "-C", destination],
  );
  // Detect dangling/escaping links too; installation is published only after validation.
  const verify = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const pathWithin = relative(destination, realpathSync(path));
        if (isAbsolute(pathWithin) || pathWithin === ".." || pathWithin.startsWith(`..${sep}`))
          throw new Error("tool archive link escapes installation");
      } else if (entry.isDirectory()) verify(path);
    }
  };
  verify(destination);
  if (asset.strip === 0) return destination;
  const entries = readdirSync(destination);
  if (
    asset.strip !== 1 ||
    entries.length !== 1 ||
    !lstatSync(join(destination, required(entries[0], "expected entries[0]"))).isDirectory()
  )
    throw new Error("tool archive has an unexpected directory layout");
  return join(destination, required(entries[0], "expected entries[0]"));
}

export async function installAsset(directory: string, asset: ToolAsset): Promise<void> {
  const receipt = join(directory, ".workbench-artifact");
  if (existsSync(receipt)) {
    if (readFileSync(receipt, "utf8").trim() !== asset.sha256)
      throw new Error(`${directory}: tool installation receipt does not match its artifact`);
    return;
  }
  if (existsSync(directory)) throw new Error(`${directory}: incomplete or foreign installation; refusing to overwrite`);
  const archive = await download(asset);
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  const staging = `${directory}.${randomUUID()}.partial`;
  mkdirSync(staging, { mode: 0o700 });
  try {
    let content = staging;
    if (asset.format === "binary") {
      const name = archivePath(asset.executable ?? "");
      if (basename(name) !== name) throw new Error("binary tool name must be a filename");
      await pipeline(createReadStream(archive), createWriteStream(join(staging, name), { flags: "wx" }));
      chmodSync(join(staging, name), 0o755);
    } else content = extractArchive(archive, staging, asset);
    if (asset.build === "gcc") {
      if (process.platform !== "linux") throw new Error("the GCC source installer currently supports Linux");
      execute("sh", ["contrib/download_prerequisites", "--verify", "--sha512", "--no-isl"], { cwd: content });
      const build = join(staging, "build");
      const image = join(staging, "image");
      mkdirSync(build);
      execute(
        join(content, "configure"),
        [
          `--prefix=${directory}`,
          "--enable-languages=c,c++",
          "--disable-bootstrap",
          "--disable-multilib",
          "--disable-nls",
          "--without-isl",
        ],
        { cwd: build },
      );
      execute("make", ["-j2"], { cwd: build });
      execute("make", ["install", `DESTDIR=${image}`], { cwd: build });
      content = join(image, directory);
    }
    if (!existsSync(resolve(content, asset.bin))) throw new Error("tool archive is missing its executable directory");
    writeFileSync(join(content, ".workbench-artifact"), `${asset.sha256}\n`);
    try {
      renameSync(content, directory);
    } catch (error) {
      if (!existsSync(receipt) || readFileSync(receipt, "utf8").trim() !== asset.sha256) throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
