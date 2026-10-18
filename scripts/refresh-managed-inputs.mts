import { required, record, records, string, strings, stringRecord } from "./values.mjs";
import type { ManagedSource } from "./managed-source-contract.mjs";
import { readNpmLock } from "./managed-check-inputs.mjs";
interface NpmManifest {
  name?: string;
  version?: string;
  deprecated?: unknown;
  _npmUser?: unknown;
  dist?: {
    integrity?: string;
    tarball?: string;
    attestations?: { url?: string; provenance?: unknown };
    revisions?: unknown;
  };
}
interface NpmMetadata {
  name: string;
  time: Record<string, string>;
  modified?: string;
  "dist-tags"?: Record<string, string>;
  versions: Record<string, NpmManifest>;
}
import { managedDeclaration } from "./managed-source-contract.mjs";
import { replaceManagedFiles } from "./managed-files.mjs";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { brotliCompressSync, constants } from "node:zlib";
import { pnpmPackages, pnpmIdentity } from "./pnpm-lock.mjs";
import type { PathOrFileDescriptor } from "fs";

const json = (path: PathOrFileDescriptor): unknown => JSON.parse(readFileSync(path, "utf8"));

async function registryJSON(url: string, limit = 2 * 1024 ** 2) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${String(response.status)}`);
  const chunks = [];
  let length = 0;
  for await (const bytes of required(response.body, "Missing registry response body")) {
    length += bytes.length;
    if (length > limit) throw new Error(`${url}: metadata exceeds its size limit`);
    chunks.push(Buffer.from(bytes));
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return value;
}

function npmManifest(value: unknown): NpmManifest {
  const entry = record(value, "Invalid npm manifest");
  for (const name of ["name", "version"])
    if (entry[name] !== undefined) string(entry[name], "Invalid npm manifest field");
  if (entry.dist !== undefined) {
    const dist = record(entry.dist, "Invalid npm distribution");
    for (const name of ["integrity", "tarball"])
      if (dist[name] !== undefined) string(dist[name], "Invalid npm distribution field");
    if (dist.attestations !== undefined) {
      const attestations = record(dist.attestations, "Invalid npm attestations");
      if (attestations.url !== undefined) string(attestations.url, "Invalid npm attestation URL");
    }
  }
  // Optional fields above are checked; historical metadata not used by this adapter remains intact.
  return entry;
}

function npmMetadata(value: unknown): NpmMetadata {
  const entry = record(value, "Invalid npm registry metadata");
  return {
    name: string(entry.name, "Missing registry package name"),
    time: stringRecord(entry.time, "Invalid publication times"),
    versions: Object.fromEntries(
      Object.entries(record(entry.versions, "Missing package versions")).map(([version, manifest]) => [
        version,
        npmManifest(manifest),
      ]),
    ),
    ...(entry.modified === undefined ? {} : { modified: string(entry.modified, "Invalid registry modification time") }),
    ...(entry["dist-tags"] === undefined
      ? {}
      : { "dist-tags": stringRecord(entry["dist-tags"], "Invalid npm dist tags") }),
  };
}

// Frozen installs read full manifests only for locked versions. pnpm's trust-history walk reads publication
// times, dist.attestations, and _npmUser (trustedPublisher and approver). Keep every historical version.
// Reference: pnpm v12.11.2, crates/resolving-npm-resolver/src/{trust_checks,create_npm_resolution_verifier/metadata_projection}.rs.
export function npmRegistrySnapshot(directory: string, metadata: Record<string, NpmMetadata>) {
  const document = { packages: pnpmPackages(readFileSync(join(directory, "pnpm-lock.yaml"), "utf8")) };
  const locked = new Map<string, Map<string, string | undefined>>();
  for (const [key, entry] of Object.entries(readNpmLock(document).packages ?? {})) {
    const { name, version } = pnpmIdentity(key);
    const versions = locked.get(name) ?? new Map<string, string | undefined>();
    versions.set(version, entry.resolution?.integrity);
    locked.set(name, versions);
  }
  const packages: Record<string, NpmMetadata> = {};
  for (const [name, lockedVersions] of [...locked].sort(([left], [right]) => left.localeCompare(right))) {
    const value = metadata[name];
    if (value?.name !== name || !Object.hasOwn(value, "versions") || !Object.hasOwn(value, "time"))
      throw new Error(`Incomplete registry metadata: ${name}`);
    for (const [version, integrity] of lockedVersions) {
      if (value.versions[version]?.dist?.integrity !== integrity)
        throw new Error(`Registry metadata does not match locked integrity: ${name}@${version}`);
    }
    packages[name] = {
      name,
      time: value.time,
      ...(value.modified === undefined ? {} : { modified: value.modified }),
      ...(value["dist-tags"] === undefined ? {} : { "dist-tags": value["dist-tags"] }),
      versions: Object.fromEntries(
        Object.entries(value.versions).map(([version, manifest]) => [
          version,
          lockedVersions.has(version)
            ? manifest
            : {
                name,
                version,
                deprecated: manifest.deprecated,
                _npmUser: manifest._npmUser,
                dist: {
                  ...(manifest.dist?.tarball === undefined ? {} : { tarball: manifest.dist.tarball }),
                  ...(manifest.dist?.attestations === undefined ? {} : { attestations: manifest.dist.attestations }),
                  revisions: manifest.dist?.revisions,
                },
              },
        ]),
      ),
    };
  }
  return brotliCompressSync(Buffer.from(JSON.stringify(packages)), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 9 },
  });
}

/** Retain publication history and trust evidence without unrelated historical manifests and signatures. */
export async function refreshNpmRegistry(directory: string, cache = new Map<string, Promise<NpmMetadata>>()) {
  const names = [
    ...new Set(
      Object.keys(pnpmPackages(readFileSync(join(directory, "pnpm-lock.yaml"), "utf8"))).map(
        (key) => pnpmIdentity(key).name,
      ),
    ),
  ].sort();
  const metadata: Record<string, NpmMetadata> = {};
  for (let offset = 0; offset < names.length; offset += 8) {
    await Promise.all(
      names.slice(offset, offset + 8).map(async (name) => {
        if (!cache.has(name))
          cache.set(name, registryJSON(`https://registry.npmjs.org/${name}`, 64 * 1024 ** 2).then(npmMetadata));
        metadata[name] = await required(cache.get(name), `Missing registry request: ${name}`);
      }),
    );
  }
  return npmRegistrySnapshot(directory, metadata);
}

/** Refresh proof material for the already locked manager; this never resolves a new version. */
export async function refreshManagedBootstrap(distribution: string) {
  const source = join(distribution, "scripts/package-manager");
  const packageJSON = json(join(source, "package.json"));
  const lock = record(json(join(source, "package-lock.json")), "Invalid bootstrap lock");
  const proofs = [];
  const { verifyAttestation } = (await import(
    pathToFileURL(join(distribution, "src/attestation-verification.ts")).href
  )) as typeof import("../src/attestation-verification.js");
  const roots = readFileSync(join(distribution, "scripts/keys/sigstore-trusted-root.jsonl"), "utf8");
  for (const [path, raw] of Object.entries(record(lock.packages, "Missing bootstrap packages"))) {
    if (!path) continue;
    const entry = record(raw, "Invalid bootstrap package");
    if (
      (entry.os !== undefined && !strings(entry.os, "Invalid bootstrap OS list").includes("linux")) ||
      (entry.cpu !== undefined &&
        !strings(entry.cpu, "Invalid bootstrap CPU list").some((arch) => ["x64", "arm64"].includes(arch))) ||
      (entry.libc !== undefined && !strings(entry.libc, "Invalid bootstrap libc list").includes("glibc"))
    )
      continue;
    const name = path.replace(/^node_modules\//, "");
    const version = string(entry.version, "Missing bootstrap version"),
      integrity = string(entry.integrity, "Missing bootstrap integrity"),
      resolved = string(entry.resolved, "Missing bootstrap URL");
    const metadata = npmManifest(await registryJSON(`https://registry.npmjs.org/${name}/${version}`));
    if (metadata.dist?.integrity !== integrity || metadata.dist.tarball !== resolved)
      throw new Error(`Registry metadata does not match the locked bootstrap: ${name}`);
    const endpoint = new URL(required(metadata.dist.attestations?.url, "Missing registry attestation URL"));
    if (endpoint.origin !== "https://registry.npmjs.org" || !endpoint.pathname.startsWith("/-/npm/v1/attestations/"))
      throw new Error(`Missing expected bootstrap provenance: ${name}`);
    const attestations = record(await registryJSON(endpoint.href), "Invalid registry attestations");
    const provenance = records(attestations.attestations, "Missing attestation records").find(
      (entry) => entry.predicateType === "https://slsa.dev/provenance/v1",
    );
    if (!provenance?.bundle) throw new Error(`Missing bootstrap SLSA provenance: ${name}`);
    const signer = `https://github.com/pnpm/pnpm/.github/workflows/release.yml@refs/tags/v${version}`;
    const subject = `pkg:npm/${name.replace("@", "%40")}@${version}`;
    const proof = {
      name,
      version,
      integrity,
      signer,
      subject,
      bundle: provenance.bundle,
    };
    verifyAttestation(
      JSON.stringify(proof.bundle),
      Buffer.from(integrity.slice(7), "base64").toString("hex"),
      {
        signer,
        subject,
        roots,
      },
      "sha512",
    );
    proofs.push(proof);
  }
  return { schema_version: 1, package_json: packageJSON, package_lock: lock, proofs };
}

export async function refreshPythonBuildInputs(directory: string) {
  const { parse } = await import("smol-toml");
  const pyproject = parse(readFileSync(join(directory, "pyproject.toml"), "utf8"));
  const inputs = [];
  for (const requirement of strings(
    record(pyproject["build-system"], "Missing Python build system").requires,
    "Invalid Python build requirements",
  )) {
    const previous = inputs.length;
    const match = /^([A-Za-z0-9._-]+)==([A-Za-z0-9.+_-]+)$/.exec(requirement);
    if (!match) throw new Error(`Managed build requirements need exact pins: ${requirement}`);
    const metadata = record(
      await registryJSON(`https://pypi.org/pypi/${String(match[1])}/${String(match[2])}/json`),
      "Invalid PyPI metadata",
    );
    for (const raw of records(metadata.urls, "Missing PyPI files")) {
      const file = {
        filename: string(raw.filename, "Missing PyPI filename"),
        url: string(raw.url, "Missing PyPI URL"),
        digests: { sha256: string(record(raw.digests, "Missing PyPI digests").sha256, "Missing PyPI SHA-256") },
      };
      if (!file.filename.endsWith("-any.whl")) continue;
      if (!/^[a-f0-9]{64}$/.test(file.digests.sha256)) throw new Error("PyPI build input has no strong integrity");
      inputs.push({
        url: file.url,
        hash: `sha256-${Buffer.from(file.digests.sha256, "hex").toString("base64")}`,
        destination: `python/${file.filename}`,
      });
    }
    if (inputs.length === previous) throw new Error(`No portable declared wheel for build requirement: ${requirement}`);
  }
  return {
    schema_version: 1,
    source_hashes: {
      "pyproject.toml": createHash("sha256")
        .update(readFileSync(join(directory, "pyproject.toml")))
        .digest("hex"),
    },
    inputs,
  };
}

/** Go authenticates module content against go.sum; record the corresponding immutable proxy files. */
export function refreshGoInputs(directory: string, command = ["go"]) {
  const stage = mkdtempSync(join(tmpdir(), "workbench-go-inputs-"));
  const sums = new Map(
    readFileSync(join(directory, "go.sum"), "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const [name, version, hash] = line.split(" ");
        return [`${String(name)}@${String(version)}`, hash];
      }),
  );
  const env = { ...process.env, GOMODCACHE: process.env.GOMODCACHE ?? join(stage, "modules") };
  try {
    for (const file of ["go.mod", "go.sum"]) copyFileSync(join(directory, file), join(stage, file));
    const output = execFileSync(
      required(command[0], "Missing Go executable"),
      [...command.slice(1), "mod", "download", "-json", "all"],
      {
        cwd: stage,
        encoding: "utf8",
        env,
      },
    );
    execFileSync(required(command[0], "Missing Go executable"), [...command.slice(1), "mod", "verify"], {
      cwd: stage,
      stdio: "inherit",
      env,
    });
    const inputs = [];
    const documents = output
      .slice(output.indexOf("{"))
      .trim()
      .split(/(?<=\})\s*(?=\{)/)
      .map((value) => record(JSON.parse(value), "Invalid Go download record"));
    for (const entry of documents) {
      const path = string(entry.Path, "Missing Go module path"),
        version = string(entry.Version, "Missing Go module version");
      if (entry.Error) throw new Error(`Go could not acquire a locked module: ${path}`);
      const sum = sums.get(`${path}@${version}`),
        modSum = sums.get(`${path}@${version}/go.mod`);
      if (!sum && !modSum) continue;
      if ((sum && sum !== entry.Sum) || (modSum && modSum !== entry.GoModSum))
        throw new Error(`Go did not verify the locked module: ${path}`);
      for (const artifact of [...(sum ? [entry.Zip] : []), entry.GoMod, entry.Info]) {
        const path = string(artifact, "Missing Go artifact path");
        const relative = path.replaceAll("\\", "/").split("/cache/download/")[1];
        if (!relative) throw new Error("Go returned an unsupported proxy artifact location");
        inputs.push({
          url: `https://proxy.golang.org/${relative}`,
          hash: `sha256-${createHash("sha256").update(readFileSync(path)).digest("base64")}`,
          destination: `go/${relative}`,
        });
      }
    }
    return {
      schema_version: 1,
      source_hashes: Object.fromEntries(
        ["go.mod", "go.sum"].map((file) => [
          file,
          createHash("sha256")
            .update(readFileSync(join(directory, file)))
            .digest("hex"),
        ]),
      ),
      inputs,
    };
  } finally {
    if (!process.env.GOMODCACHE)
      execFileSync(required(command[0], "Missing Go executable"), [...command.slice(1), "clean", "-modcache"], {
        cwd: stage,
        env,
        stdio: "inherit",
      });
    rmSync(stage, { recursive: true, force: true });
  }
}

export async function refreshComposerBootstrap(directory: string, distribution: string) {
  const version = readFileSync(join(directory, ".composer-version"), "utf8").trim();
  const inventory = record(json(join(distribution, "scripts/native-assets.json")), "Invalid native assets");
  const selected = record(
    record(record(inventory.composer, "Missing Composer inventory")[version], "Missing Composer version")["linux-x64"],
    "Missing Composer asset",
  );
  const asset = {
    url: string(selected.url, "Invalid Composer URL"),
    sha256: string(selected.sha256, "Invalid Composer digest"),
    signature: {
      url: string(record(selected.signature, "Missing Composer signature").url, "Missing Composer signature URL"),
    },
  };
  const response = await fetch(asset.signature.url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Composer signature: HTTP ${String(response.status)}`);
  const signature = Buffer.from(await response.arrayBuffer());
  if (signature.length > 64 * 1024) throw new Error("Composer signature exceeds its size limit");
  return {
    schema_version: 1,
    source_hashes: {
      ".composer-version": createHash("sha256")
        .update(readFileSync(join(directory, ".composer-version")))
        .digest("hex"),
    },
    inputs: [
      {
        url: asset.url,
        hash: `sha256-${Buffer.from(asset.sha256, "hex").toString("base64")}`,
        destination: "bootstrap/composer.phar",
      },
      {
        url: asset.signature.url,
        hash: `sha256-${createHash("sha256").update(signature).digest("base64")}`,
        destination: "bootstrap/composer.phar.asc",
      },
    ],
  };
}

/** Collect every requested output before the CLI replaces any project file. */
export async function collectManagedRefresh(
  root: string,
  acquire: {
    bootstrap?: (root: string) => Promise<unknown>;
    registry?: typeof refreshNpmRegistry;
    python?: (directory: string) => unknown;
    go?: (root: string) => unknown;
    composer?: (directory: string, distribution: string) => unknown;
  } = {},
) {
  const projects = (await import("smol-toml")).parse(readFileSync(join(root, "workbench/projects.toml"), "utf8"));
  const files: [string, string | Uint8Array][] = [];
  const outputJSON = (path: string, value: unknown) => files.push([path, `${JSON.stringify(value, null, 2)}\n`]);
  let bootstrap;
  const registry = new Map<string, Promise<NpmMetadata>>();
  for (const path of [
    ...new Set(
      records(projects.language_root, "Missing language roots").map((entry) =>
        string(entry.path, "Missing language root path"),
      ),
    ),
  ]) {
    const directory = join(root, path);
    const extras = [];
    if (existsSync(join(directory, "pnpm-lock.yaml"))) {
      bootstrap ??= await (acquire.bootstrap ?? refreshManagedBootstrap)(root);
      outputJSON(join(directory, "managed-bootstrap.json"), bootstrap);
      files.push([
        join(directory, "managed-registry.json.br"),
        await (acquire.registry ?? refreshNpmRegistry)(directory, registry),
      ]);
    }
    if (existsSync(join(directory, "uv.lock")))
      extras.push(await (acquire.python ?? refreshPythonBuildInputs)(directory));
    if (existsSync(join(directory, "go.sum"))) {
      let result;
      if (acquire.go) result = await acquire.go(directory);
      else {
        const goroot = execFileSync(
          process.execPath,
          [
            join(root, "bin/workbench.mjs"),
            "shell",
            "--profile",
            "native",
            "--path",
            path,
            "--",
            "go",
            "env",
            "GOROOT",
          ],
          { cwd: root, encoding: "utf8" },
        )
          .trim()
          .split(/\r?\n/)
          .at(-1);
        result = refreshGoInputs(directory, [
          join(required(goroot, "Missing Go root"), "bin", process.platform === "win32" ? "go.exe" : "go"),
        ]);
      }
      extras.push(result);
    }
    if (existsSync(join(directory, ".composer-version")))
      extras.push(await (acquire.composer ?? refreshComposerBootstrap)(directory, root));
    if (extras.length) {
      const hashes: Record<string, string> = Object.create(null) as Record<string, string>;
      const inputs = new Map<string, ManagedSource>();
      for (const extra of extras) {
        const declaration = managedDeclaration(extra);
        for (const [file, hash] of Object.entries(declaration.source_hashes)) {
          if (hashes[file] !== undefined && hashes[file] !== hash)
            throw new Error(`Conflicting supplemental source identity: ${file}`);
          hashes[file] = hash;
        }
        for (const input of declaration.inputs) {
          const previous = inputs.get(input.destination);
          if (
            previous &&
            (previous.url !== input.url ||
              previous.hash !== input.hash ||
              JSON.stringify([...(previous.platforms ?? [])].sort()) !==
                JSON.stringify([...(input.platforms ?? [])].sort()))
          )
            throw new Error(`Conflicting supplemental artifact: ${input.destination}`);
          inputs.set(input.destination, input);
        }
      }
      outputJSON(
        join(directory, "managed-extra-inputs.json"),
        managedDeclaration({ schema_version: 1, source_hashes: hashes, inputs: [...inputs.values()] }),
      );
    }
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename)
  replaceManagedFiles(await collectManagedRefresh(resolve(import.meta.dirname, "..")));
