import { boundTarArchive, extractZipArchive } from "./archive-extraction.js";
import { required } from "./invariants.js";
import { randomUUID } from "node:crypto";
import { cpuBudget } from "../scripts/cpu-budget.mjs";
import { withCacheLock } from "./cache-lock.js";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { userDirectory } from "./storage.js";
import { extractFilteredArtifact, verifyFilteredInstallation } from "./filtered-artifacts.js";
import type { ArchiveFilter } from "./artifact-policy.js";
import {
  authenticateChecksums,
  signatureVerifier,
  type ArtifactSignature,
  type SignedChecksums,
} from "./artifact-signatures.js";
import { authenticateAttestation, type ArtifactAttestation } from "./artifact-attestations.js";
import { artifactLimits, artifactResponse, ByteLimit, DigestStream } from "./artifact-streams.js";
import { buildRuby, buildPhp } from "./runtime-builds.js";
import { extractSevenZip } from "./seven-zip.js";
import { authenticateRepository, type AptRepository } from "./artifact-repositories.js";

export interface ToolAsset {
  url: string;
  sha256: string;
  format: "tar" | "zip" | "7z" | "binary" | "deb";
  strip: number;
  bin: string;
  executable?: string;
  build?: "gcc" | "ruby" | "php";
  phpExtensions?: string[];
  filter?: ArchiveFilter;
  signature?: ArtifactSignature;
  checksums?: SignedChecksums;
  authenticationUnavailable?: { reason: string; source: string; checked: string };
  repository?: AptRepository;
  attestation?: ArtifactAttestation;
  zstdWindowLogMax?: number;
  archiveLimits?: { entries: number };
}

export function commandInvocation(command: string, args: string[]): string[] {
  return process.platform === "win32" && !/\.exe$/i.test(command)
    ? ["sh", "-eu", "-c", 'exec "$@"', "workbench-command", command.replaceAll("\\", "/"), ...args]
    : [command, ...args];
}

export function execute(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean; maxBuffer?: number; timeout?: number } = {},
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

/** Redirects never downgrade transport. Content is verified before extraction or execution. */
export async function download(
  asset: Pick<ToolAsset, "url" | "sha256" | "attestation" | "signature" | "checksums" | "repository">,
  options: { signal?: AbortSignal; compressed?: number } = {},
): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error("tool artifact requires a recorded SHA-256 digest");
  const url = new URL(asset.url);
  if (url.protocol !== "https:") throw new Error("tool downloads require HTTPS, including redirects");
  const folder = join(userDirectory("cache"), "downloads");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const target = join(folder, `${asset.sha256}-${basename(url.pathname)}`);
  const temporary = `${target}.${randomUUID()}.partial`;
  const staging = mkdtempSync(join(folder, ".authentication-"));
  const signal = AbortSignal.any([
    AbortSignal.timeout(artifactLimits.milliseconds),
    ...(options.signal ? [options.signal] : []),
  ]);
  let signature: Awaited<ReturnType<typeof signatureVerifier>> | undefined;
  try {
    if (asset.attestation) await authenticateAttestation(asset.attestation, asset.sha256, signal);
    if (asset.checksums) await authenticateChecksums(asset.checksums, asset.sha256, staging, signal);
    if (asset.repository) await authenticateRepository(asset.repository, asset, staging, signal);
    if (asset.signature) signature = await signatureVerifier(asset.signature, staging, signal);
    const cached = existsSync(target);
    if (cached && (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()))
      throw new Error(`${target}: cached artifact checksum mismatch; remove it and retry installation`);
    const incoming = new DigestStream(options.compressed ?? artifactLimits.compressed, "tool download");
    const source = cached ? createReadStream(target) : await artifactResponse(asset.url, signal);
    const output = cached
      ? new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        })
      : createWriteStream(temporary, { flags: "wx", mode: 0o600 });
    await pipeline([source, incoming, ...(signature ? [signature.relay] : []), output], { signal });
    if (incoming.hash.digest("hex") !== asset.sha256) {
      if (cached) throw new Error(`${target}: cached artifact checksum mismatch; remove it and retry installation`);
      throw new Error(`tool artifact checksum mismatch: ${asset.url}`);
    }
    await signature?.finish();
    if (!cached) renameSync(temporary, target);
    return target;
  } finally {
    await signature?.cancel();
    rmSync(temporary, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

export function unsafeArchiveText(value: string): boolean {
  return (
    /[\\:]/.test(value) ||
    value.split("").some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}

export function archivePath(path: string): string {
  if (!path || unsafeArchiveText(path) || path.startsWith("/") || path.split("/").includes(".."))
    throw new Error(`unsafe tool archive path: ${JSON.stringify(path)}`);
  const normalized = posix.normalize(path.replace(/^\.\//, "").replace(/\/$/, ""));
  if (!normalized || normalized === ".") throw new Error("unsafe empty tool archive path");
  if (
    process.platform === "win32" &&
    normalized
      .split("/")
      .some((part) => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
  )
    throw new Error("unsafe Windows tool archive path");
  return normalized;
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
export async function extractArchive(
  archive: string,
  destination: string,
  asset: ToolAsset,
  include?: (path: string) => boolean,
): Promise<string> {
  const limits = { ...artifactLimits, entries: asset.archiveLimits?.entries ?? artifactLimits.entries };
  if (asset.format === "zip") return extractZipArchive(archive, destination, asset.strip, limits);
  if (asset.format === "7z") return extractSevenZip(archive, destination, asset.strip, limits);
  await boundTarArchive(archive, limits);
  if (process.platform === "win32" && !process.env.SystemRoot)
    throw new Error("SystemRoot is required to locate Windows tar.exe");
  const tar =
    process.platform === "win32"
      ? join(required(process.env.SystemRoot, "expected process.env.SystemRoot"), "System32/tar.exe")
      : "tar";
  const members = archiveListing(
    execute(tar, ["-tf", archive], {
      timeout: limits.milliseconds,
      capture: true,
      maxBuffer: 128 * 1024 * 1024,
    }),
  )
    .trim()
    .split(/\r?\n/)
    .filter((member) => member !== "." && member !== "./");
  members.forEach(archivePath);
  const names = members.map((member) => archivePath(member));
  const key = (name: string) => (process.platform === "win32" ? name.toLowerCase() : name);
  if (new Set(names.map(key)).size !== names.length) throw new Error("tool archive contains duplicate paths");
  const links = new Set<string>();
  const listing = archiveListing(
    execute(tar, ["-tvf", archive], {
      timeout: limits.milliseconds,
      capture: true,
      maxBuffer: 128 * 1024 * 1024,
    }),
  );
  for (const line of listing.split(/\r?\n/)) {
    if (line) {
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
        links.add(key(archivePath(member)));
        const resolved = line.startsWith("l") ? posix.normalize(posix.join(posix.dirname(member), target)) : target;
        archivePath(resolved);
        if (asset.strip === 1 && resolved.split("/")[0] !== member.split("/")[0])
          throw new Error("tool archive link escapes its top directory");
      }
    }
  }
  for (const name of names) {
    let parent = posix.dirname(name);
    while (parent !== ".") {
      if (links.has(key(parent))) throw new Error("tool archive entry has a link as its parent");
      parent = posix.dirname(parent);
    }
  }
  const selection = include ? mkdtempSync(join(dirname(destination), ".members-")) : undefined;
  try {
    const list = selection ? join(selection, "paths") : undefined;
    if (list) writeFileSync(list, members.filter((member) => include?.(archivePath(member))).join("\0") + "\0");
    execute(
      tar,
      [
        "-xf",
        archive,
        "--no-same-owner",
        "-C",
        destination,
        ...(list ? ["--no-recursion", "--verbatim-files-from", "--null", "--files-from", list] : []),
      ],
      { timeout: limits.milliseconds },
    );
  } finally {
    if (selection) rmSync(selection, { recursive: true, force: true });
  }
  // Detect dangling/escaping links too; installation is published only after validation.
  const canonicalDestination = realpathSync(destination);
  const verify = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const pathWithin = relative(canonicalDestination, realpathSync(path));
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
  await withCacheLock(directory, () => installLockedAsset(directory, asset));
}

async function installLockedAsset(directory: string, asset: ToolAsset): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error("tool artifact requires a recorded SHA-256 digest");
  if (
    asset.zstdWindowLogMax !== undefined &&
    (!asset.filter ||
      !new URL(asset.url).pathname.endsWith(".zst") ||
      !Number.isSafeInteger(asset.zstdWindowLogMax) ||
      asset.zstdWindowLogMax < 10 ||
      asset.zstdWindowLogMax > 30)
  )
    throw new Error("a filtered Zstandard artifact requires a window limit between 10 and 30 (at most 1 GiB)");
  if (
    asset.archiveLimits &&
    (!Number.isSafeInteger(asset.archiveLimits.entries) ||
      asset.archiveLimits.entries < 1 ||
      asset.archiveLimits.entries > 400_000)
  )
    throw new Error("artifact entry override must be between 1 and 400,000");
  const receipt = join(directory, ".workbench-artifact");
  if (existsSync(receipt)) {
    if (readFileSync(receipt, "utf8").trim() !== asset.sha256)
      throw new Error(`${directory}: tool installation receipt does not match its artifact`);
    if (asset.filter) await verifyFilteredInstallation(directory, { ...asset, filter: asset.filter });
    return;
  }
  if (existsSync(directory)) throw new Error(`${directory}: incomplete or foreign installation; refusing to overwrite`);
  const archive = asset.filter ? undefined : await download(asset);
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  const staging = `${directory}.${randomUUID()}.partial`;
  mkdirSync(staging, { mode: 0o700 });
  try {
    let content = staging;
    if (asset.filter) {
      if (asset.format !== "tar" || ![0, 1].includes(asset.strip))
        throw new Error("streaming filters require a supported tar layout");
      content = await extractFilteredArtifact({ ...asset, filter: asset.filter }, staging, {
        ...artifactLimits,
        windowLog: asset.zstdWindowLogMax ?? artifactLimits.windowLog,
      });
    } else if (asset.format === "binary") {
      const name = archivePath(asset.executable ?? "");
      if (basename(name) !== name) throw new Error("binary tool name must be a filename");
      await pipeline(
        createReadStream(required(archive, "expected verified binary download")),
        new ByteLimit(artifactLimits.file, "tool executable"),
        createWriteStream(join(staging, name), { flags: "wx" }),
        { signal: AbortSignal.timeout(artifactLimits.milliseconds) },
      );
      chmodSync(join(staging, name), 0o755);
    } else if (asset.format === "deb") {
      const verified = required(archive, "expected verified Debian package");
      const members = execute("ar", ["t", verified], { capture: true, timeout: artifactLimits.milliseconds })
        .trim()
        .split(/\r?\n/);
      if (
        members.length !== 3 ||
        members[0] !== "debian-binary" ||
        !/^control\.tar\.(?:gz|xz|zst)$/.test(members[1] ?? "") ||
        !/^data\.tar\.(?:gz|xz|zst)$/.test(members[2] ?? "")
      )
        throw new Error("unsupported Debian package layout");
      const data = required(members[2], "missing Debian payload");
      execute("ar", ["x", verified, data], { cwd: staging, timeout: artifactLimits.milliseconds });
      const payload = join(staging, "payload");
      mkdirSync(payload);
      // Runtime packages need their library directory and licenses, not documentation links into other packages.
      const library = archivePath(asset.bin);
      content = await extractArchive(
        join(staging, data),
        payload,
        { ...asset, format: "tar" },
        (name) =>
          name === library || name.startsWith(`${library}/`) || /^usr\/share\/doc\/[^/]+\/copyright$/.test(name),
      );
    } else content = await extractArchive(required(archive, "expected verified archive download"), staging, asset);
    if (asset.build === "ruby") content = buildRuby(content, staging, directory, execute);
    if (asset.build === "php") content = buildPhp(content, staging, directory, execute);
    if (asset.phpExtensions) {
      if (process.platform !== "win32" || asset.phpExtensions.some((name) => !/^[a-z]+$/.test(name)))
        throw new Error("invalid native PHP extension configuration");
      writeFileSync(
        join(content, "php.ini"),
        [
          `extension_dir="${join(directory, "ext").replaceAll("\\", "/")}"`,
          ...asset.phpExtensions.map((name) => `extension=${name}`),
          "",
        ].join("\n"),
      );
    }
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
      execute("make", [`-j${String(cpuBudget())}`], { cwd: build });
      execute("make", ["install-strip", `DESTDIR=${image}`], { cwd: build });
      content = join(image, directory);
    }
    if (!existsSync(resolve(content, asset.bin))) throw new Error("tool archive is missing its executable directory");
    writeFileSync(join(content, ".workbench-artifact"), `${asset.sha256}\n`);
    try {
      renameSync(content, directory);
    } catch (error) {
      if (!existsSync(receipt) || readFileSync(receipt, "utf8").trim() !== asset.sha256) throw error;
      if (asset.filter) await verifyFilteredInstallation(directory, { ...asset, filter: asset.filter });
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
