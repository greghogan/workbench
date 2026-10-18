import { isRecord, isStringArray, required, records, strings, capturedText } from "./values.mjs";
import type { SpawnSyncOptions } from "node:child_process";
interface GuixBootstrap {
  schema: number;
  channels: string[];
  sha256: string;
  profiles: { path: string; aliases: string[] }[];
}
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { guixChannelFile } from "./managed-contract.mjs";

import type { BinaryLike } from "crypto";

const digest = (value: BinaryLike) => createHash("sha256").update(value).digest("hex");
const storeProfile = /^\/gnu\/store\/[0-9a-df-np-sv-z]{32}-profile$/;
const aliasName = /^[a-z2-7]{52}$/;
const helper = join(dirname(fileURLToPath(import.meta.url)), "ci-guix-bootstrap.scm");

function assertGuixBootstrap(value: unknown, channels: string[]): asserts value is GuixBootstrap {
  if (
    !isRecord(value) ||
    value.schema !== 1 ||
    JSON.stringify(value.channels) !== JSON.stringify(channels) ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Array.isArray(value.profiles) ||
    !value.profiles.length ||
    value.profiles.some(
      (entry) =>
        !isRecord(entry) ||
        typeof entry.path !== "string" ||
        !storeProfile.test(entry.path) ||
        !Array.isArray(entry.aliases) ||
        !entry.aliases.length ||
        entry.aliases.some((name: string) => !aliasName.test(name)),
    )
  )
    throw new Error("invalid Guix bootstrap cache or mismatched channel declarations");
  const aliases = records(value.profiles, "Invalid Guix profiles").flatMap((entry) =>
    strings(entry.aliases, "Invalid Guix aliases"),
  );
  if (new Set(aliases).size !== aliases.length) throw new Error("duplicate Guix bootstrap cache alias");
}

export function validateGuixBootstrap(value: unknown, channels: string[]): GuixBootstrap {
  assertGuixBootstrap(value, channels);
  return value;
}

function run(command: string, args: string[], options: SpawnSyncOptions = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${String(result.error ?? result.status)}`);
  return capturedText(result.stdout).trim();
}

async function fileDigest(path: string) {
  const hash = createHash("sha256");
  for await (const data of createReadStream(path)) {
    const bytes: unknown = data;
    if (!Buffer.isBuffer(bytes)) throw new Error("Invalid Guix archive bytes");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

async function exportClosure(profiles: string[], path: string) {
  const hash = createHash("sha256");
  const child = spawn("guix", ["archive", "--export", "--recursive", ...profiles], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const completion = new Promise<void>((accept, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) accept();
      else reject(new Error(`Guix closure export failed: ${String(signal ?? code)}`));
    });
  });
  try {
    await Promise.all([
      completion,
      pipeline(
        child.stdout,
        new Transform({
          transform(data: Buffer, _encoding, callback) {
            hash.update(data);
            callback(null, data);
          },
        }),
        createWriteStream(path, { flags: "wx" }),
      ),
    ]);
  } catch (error) {
    child.kill();
    throw error;
  }
  return hash.digest("hex");
}

export async function prepareGuixBootstrap() {
  // Restored build outputs and their public signer are trusted through GitHub's
  // cache access rules. Never authorize such a key in an ordinary user's daemon.
  if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true")
    throw new Error("Guix bootstrap archive preparation requires an isolated Linux Actions runner");
  const roots: unknown = JSON.parse(process.env.CHECK_ROOTS ?? "[]");
  if (!isStringArray(roots) || !roots.length || roots.some((root) => typeof root !== "string" || !root))
    throw new Error("CHECK_ROOTS must list configured roots");
  const declarations = new Map<string, string>();
  for (const root of roots) {
    const path = guixChannelFile(process.cwd(), resolve(root));
    declarations.set(digest(readFileSync(path, "utf8").trim()), path);
  }
  const channels = [...declarations.keys()].sort();
  const directory = join(
    required(process.env.WORKBENCH_CACHE_HOME, "WORKBENCH_CACHE_HOME is required"),
    "guix-bootstrap",
  );
  const manifest = join(directory, "manifest.json");
  // Ask the installed bootstrap for its own layout: Guix versions place these
  // links either in the user cache or under the user's registered profiles.
  const inferiorDirectory = run("guix", ["repl", helper, "cache-directory"]);
  if (!inferiorDirectory.startsWith("/")) throw new Error("Guix returned an invalid inferior cache directory");
  mkdirSync(inferiorDirectory, { recursive: true });
  let restored: GuixBootstrap | undefined;
  if (existsSync(manifest)) {
    restored = validateGuixBootstrap(JSON.parse(readFileSync(manifest, "utf8")), channels);
    const archive = join(directory, "closure.nar");
    if ((await fileDigest(archive)) !== restored.sha256) throw new Error("Guix bootstrap archive checksum mismatch");
    // The archive's signatures remain mandatory. Only the public key is cached;
    // the producing runner's private signing key is never retained.
    run("sudo", ["guix", "archive", "--authorize"], {
      input: readFileSync(join(directory, "signing-key.pub")),
      stdio: ["pipe", "inherit", "inherit"],
    });
    const input = openSync(archive, "r");
    try {
      run("guix", ["archive", "--import"], { stdio: [input, "inherit", "inherit"] });
    } finally {
      closeSync(input);
    }
    for (const profile of restored.profiles) {
      for (const name of profile.aliases) {
        const alias = join(inferiorDirectory, name);
        if (existsSync(alias) || lstatSync(alias, { throwIfNoEntry: false })) {
          if (!lstatSync(alias).isSymbolicLink() || readlinkSync(alias) !== profile.path)
            throw new Error(`conflicting Guix bootstrap alias: ${alias}`);
        } else symlinkSync(profile.path, alias);
        run("guix", ["repl", helper, "register-root", alias]);
      }
    }
  } else if (existsSync(directory) && readdirSync(directory).length) {
    throw new Error("incomplete Guix bootstrap cache");
  }

  const cpus = process.env.WORKBENCH_JOB_CPUS ?? "4";
  if (!/^[1-9][0-9]*$/.test(cpus)) throw new Error("WORKBENCH_JOB_CPUS must be a positive integer");
  const profiles = [
    ...new Set(
      [...declarations.values()].map((path) => {
        const profile = realpathSync(run("guix", ["repl", helper, "profile", path, cpus]));
        if (!storeProfile.test(profile)) throw new Error(`Guix returned an invalid time-machine profile: ${profile}`);
        return profile;
      }),
    ),
  ];
  if (restored) {
    const restoredProfiles = restored.profiles;
    if (profiles.some((path) => !restoredProfiles.some((profile: { path: string }) => profile.path === path)))
      throw new Error("restored Guix bootstrap does not match the selected time-machine profiles");
    console.log(`Reused ${String(profiles.length)} authenticated pinned Guix bootstrap profile(s).`);
    return;
  }

  const entries = profiles.map((path) => ({
    path,
    aliases: readdirSync(inferiorDirectory).filter((name) => {
      const alias = join(inferiorDirectory, name);
      return aliasName.test(name) && lstatSync(alias).isSymbolicLink() && readlinkSync(alias) === path;
    }),
  }));
  if (!existsSync("/etc/guix/signing-key.pub"))
    run("sudo", ["guix", "archive", "--generate-key"], { stdio: "inherit" });
  const staging = `${directory}.staging-${randomUUID()}`;
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    const sha256 = await exportClosure(profiles, join(staging, "closure.nar"));
    copyFileSync("/etc/guix/signing-key.pub", join(staging, "signing-key.pub"));
    const value = validateGuixBootstrap({ schema: 1, channels, profiles: entries, sha256 }, channels);
    writeFileSync(join(staging, "manifest.json"), JSON.stringify(value, null, 2) + "\n");
    renameSync(staging, directory);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  console.log(
    `Retained ${String(profiles.length)} authenticated pinned Guix bootstrap profile(s) with their runtime closures.`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await prepareGuixBootstrap();
