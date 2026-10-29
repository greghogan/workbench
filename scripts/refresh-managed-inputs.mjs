// Generated from refresh-managed-inputs.mts; edit the TypeScript source.
import { required, record, records, string, strings, stringRecord } from "./values.mjs";
import { managedDeclaration } from "./managed-source-contract.mjs";
import { readNpmLock } from "./managed-check-inputs.mjs";
import { replaceManagedFiles } from "./managed-files.mjs";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { brotliCompressSync, constants } from "node:zlib";
import { pnpmPackages, pnpmIdentity } from "./pnpm-lock.mjs";
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
async function registryJSON(url, limit = 2 * 1024 ** 2) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(3e4) });
  if (!response.ok) throw new Error(`${url}: HTTP ${String(response.status)}`);
  const chunks = [];
  let length = 0;
  for await (const bytes of required(response.body, "Missing registry response body")) {
    length += bytes.length;
    if (length > limit) throw new Error(`${url}: metadata exceeds its size limit`);
    chunks.push(Buffer.from(bytes));
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return value;
}
function npmManifest(value) {
  const entry = record(value, "Invalid npm manifest");
  for (const name of ["name", "version"])
    if (entry[name] !== void 0) string(entry[name], "Invalid npm manifest field");
  if (entry.dist !== void 0) {
    const dist = record(entry.dist, "Invalid npm distribution");
    for (const name of ["integrity", "tarball"])
      if (dist[name] !== void 0) string(dist[name], "Invalid npm distribution field");
    if (dist.attestations !== void 0) {
      const attestations = record(dist.attestations, "Invalid npm attestations");
      if (attestations.url !== void 0) string(attestations.url, "Invalid npm attestation URL");
    }
  }
  return entry;
}
function npmMetadata(value) {
  const entry = record(value, "Invalid npm registry metadata");
  return {
    name: string(entry.name, "Missing registry package name"),
    time: stringRecord(entry.time, "Invalid publication times"),
    versions: Object.fromEntries(
      Object.entries(record(entry.versions, "Missing package versions")).map(([version, manifest]) => [
        version,
        npmManifest(manifest)
      ])
    ),
    ...entry.modified === void 0 ? {} : { modified: string(entry.modified, "Invalid registry modification time") },
    ...entry["dist-tags"] === void 0 ? {} : { "dist-tags": stringRecord(entry["dist-tags"], "Invalid npm dist tags") }
  };
}
function npmRegistrySnapshot(directory, metadata) {
  const document = { packages: pnpmPackages(readFileSync(join(directory, "pnpm-lock.yaml"), "utf8")) };
  const locked = /* @__PURE__ */ new Map();
  for (const [key, entry] of Object.entries(readNpmLock(document).packages ?? {})) {
    const { name, version } = pnpmIdentity(key);
    const versions = locked.get(name) ?? /* @__PURE__ */ new Map();
    versions.set(version, entry.resolution?.integrity);
    locked.set(name, versions);
  }
  const packages = {};
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
      ...value.modified === void 0 ? {} : { modified: value.modified },
      ...value["dist-tags"] === void 0 ? {} : { "dist-tags": value["dist-tags"] },
      versions: Object.fromEntries(
        Object.entries(value.versions).map(([version, manifest]) => [
          version,
          lockedVersions.has(version) ? manifest : {
            name,
            version,
            deprecated: manifest.deprecated,
            _npmUser: manifest._npmUser,
            dist: {
              ...manifest.dist?.tarball === void 0 ? {} : { tarball: manifest.dist.tarball },
              ...manifest.dist?.attestations === void 0 ? {} : { attestations: manifest.dist.attestations },
              revisions: manifest.dist?.revisions
            }
          }
        ])
      )
    };
  }
  return brotliCompressSync(Buffer.from(JSON.stringify(packages)), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 9 }
  });
}
async function refreshNpmRegistry(directory, cache = /* @__PURE__ */ new Map()) {
  const names = [
    ...new Set(
      Object.keys(pnpmPackages(readFileSync(join(directory, "pnpm-lock.yaml"), "utf8"))).map(
        (key) => pnpmIdentity(key).name
      )
    )
  ].sort();
  const metadata = {};
  for (let offset = 0; offset < names.length; offset += 8) {
    await Promise.all(
      names.slice(offset, offset + 8).map(async (name) => {
        if (!cache.has(name))
          cache.set(name, registryJSON(`https://registry.npmjs.org/${name}`, 64 * 1024 ** 2).then(npmMetadata));
        metadata[name] = await required(cache.get(name), `Missing registry request: ${name}`);
      })
    );
  }
  return npmRegistrySnapshot(directory, metadata);
}
async function refreshManagedBootstrap(distribution) {
  const source = join(distribution, "scripts/package-manager");
  const packageJSON = json(join(source, "package.json"));
  const lock = record(json(join(source, "package-lock.json")), "Invalid bootstrap lock");
  const proofs = [];
  const { verifyAttestation } = await import(pathToFileURL(join(distribution, "src/attestation-verification.ts")).href);
  const roots = readFileSync(join(distribution, "scripts/keys/sigstore-trusted-root.jsonl"), "utf8");
  for (const [path, raw] of Object.entries(record(lock.packages, "Missing bootstrap packages"))) {
    if (!path) continue;
    const entry = record(raw, "Invalid bootstrap package");
    if (entry.os !== void 0 && !strings(entry.os, "Invalid bootstrap OS list").includes("linux") || entry.cpu !== void 0 && !strings(entry.cpu, "Invalid bootstrap CPU list").some((arch) => ["x64", "arm64"].includes(arch)) || entry.libc !== void 0 && !strings(entry.libc, "Invalid bootstrap libc list").includes("glibc"))
      continue;
    const name = path.replace(/^node_modules\//, "");
    const version = string(entry.version, "Missing bootstrap version"), integrity = string(entry.integrity, "Missing bootstrap integrity"), resolved = string(entry.resolved, "Missing bootstrap URL");
    const metadata = npmManifest(await registryJSON(`https://registry.npmjs.org/${name}/${version}`));
    if (metadata.dist?.integrity !== integrity || metadata.dist.tarball !== resolved)
      throw new Error(`Registry metadata does not match the locked bootstrap: ${name}`);
    const endpoint = new URL(required(metadata.dist.attestations?.url, "Missing registry attestation URL"));
    if (endpoint.origin !== "https://registry.npmjs.org" || !endpoint.pathname.startsWith("/-/npm/v1/attestations/"))
      throw new Error(`Missing expected bootstrap provenance: ${name}`);
    const attestations = record(await registryJSON(endpoint.href), "Invalid registry attestations");
    const provenance = records(attestations.attestations, "Missing attestation records").find(
      (entry2) => entry2.predicateType === "https://slsa.dev/provenance/v1"
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
      bundle: provenance.bundle
    };
    verifyAttestation(
      JSON.stringify(proof.bundle),
      Buffer.from(integrity.slice(7), "base64").toString("hex"),
      {
        signer,
        subject,
        roots
      },
      "sha512"
    );
    proofs.push(proof);
  }
  return { schema_version: 1, package_json: packageJSON, package_lock: lock, proofs };
}
async function refreshPythonBuildInputs(directory) {
  const { parse } = await import("smol-toml");
  const pyproject = parse(readFileSync(join(directory, "pyproject.toml"), "utf8"));
  const inputs = [];
  for (const requirement of strings(
    record(pyproject["build-system"], "Missing Python build system").requires,
    "Invalid Python build requirements"
  )) {
    const previous = inputs.length;
    const match = /^([A-Za-z0-9._-]+)==([A-Za-z0-9.+_-]+)$/.exec(requirement);
    if (!match) throw new Error(`Managed build requirements need exact pins: ${requirement}`);
    const metadata = record(
      await registryJSON(`https://pypi.org/pypi/${String(match[1])}/${String(match[2])}/json`),
      "Invalid PyPI metadata"
    );
    for (const raw of records(metadata.urls, "Missing PyPI files")) {
      const file = {
        filename: string(raw.filename, "Missing PyPI filename"),
        url: string(raw.url, "Missing PyPI URL"),
        digests: { sha256: string(record(raw.digests, "Missing PyPI digests").sha256, "Missing PyPI SHA-256") }
      };
      if (!file.filename.endsWith("-any.whl")) continue;
      if (!/^[a-f0-9]{64}$/.test(file.digests.sha256)) throw new Error("PyPI build input has no strong integrity");
      inputs.push({
        url: file.url,
        hash: `sha256-${Buffer.from(file.digests.sha256, "hex").toString("base64")}`,
        destination: `python/${file.filename}`
      });
    }
    if (inputs.length === previous) throw new Error(`No portable declared wheel for build requirement: ${requirement}`);
  }
  return {
    schema_version: 1,
    source_hashes: {
      "pyproject.toml": createHash("sha256").update(readFileSync(join(directory, "pyproject.toml"))).digest("hex")
    },
    inputs
  };
}
function refreshGoInputs(directory, command = ["go"]) {
  const stage = mkdtempSync(join(tmpdir(), "workbench-go-inputs-"));
  const sums = new Map(
    readFileSync(join(directory, "go.sum"), "utf8").trim().split("\n").map((line) => {
      const [name, version, hash] = line.split(" ");
      return [`${String(name)}@${String(version)}`, hash];
    })
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
        env
      }
    );
    execFileSync(required(command[0], "Missing Go executable"), [...command.slice(1), "mod", "verify"], {
      cwd: stage,
      stdio: "inherit",
      env
    });
    const inputs = [];
    const documents = output.slice(output.indexOf("{")).trim().split(/(?<=\})\s*(?=\{)/).map((value) => record(JSON.parse(value), "Invalid Go download record"));
    for (const entry of documents) {
      const path = string(entry.Path, "Missing Go module path"), version = string(entry.Version, "Missing Go module version");
      if (entry.Error) throw new Error(`Go could not acquire a locked module: ${path}`);
      const sum = sums.get(`${path}@${version}`), modSum = sums.get(`${path}@${version}/go.mod`);
      if (!sum && !modSum) continue;
      if (sum && sum !== entry.Sum || modSum && modSum !== entry.GoModSum)
        throw new Error(`Go did not verify the locked module: ${path}`);
      for (const artifact of [...sum ? [entry.Zip] : [], entry.GoMod, entry.Info]) {
        const path2 = string(artifact, "Missing Go artifact path");
        const relative = path2.replaceAll("\\", "/").split("/cache/download/")[1];
        if (!relative) throw new Error("Go returned an unsupported proxy artifact location");
        inputs.push({
          url: `https://proxy.golang.org/${relative}`,
          hash: `sha256-${createHash("sha256").update(readFileSync(path2)).digest("base64")}`,
          destination: `go/${relative}`
        });
      }
    }
    return {
      schema_version: 1,
      source_hashes: Object.fromEntries(
        ["go.mod", "go.sum"].map((file) => [
          file,
          createHash("sha256").update(readFileSync(join(directory, file))).digest("hex")
        ])
      ),
      inputs
    };
  } finally {
    if (!process.env.GOMODCACHE)
      execFileSync(required(command[0], "Missing Go executable"), [...command.slice(1), "clean", "-modcache"], {
        cwd: stage,
        env,
        stdio: "inherit"
      });
    rmSync(stage, { recursive: true, force: true });
  }
}
async function refreshComposerBootstrap(directory, distribution) {
  const version = readFileSync(join(directory, ".composer-version"), "utf8").trim();
  const inventory = record(json(join(distribution, "scripts/native-assets.json")), "Invalid native assets");
  const selected = record(
    record(record(inventory.composer, "Missing Composer inventory")[version], "Missing Composer version")["linux-x64"],
    "Missing Composer asset"
  );
  const asset = {
    url: string(selected.url, "Invalid Composer URL"),
    sha256: string(selected.sha256, "Invalid Composer digest"),
    signature: {
      url: string(record(selected.signature, "Missing Composer signature").url, "Missing Composer signature URL")
    }
  };
  const response = await fetch(asset.signature.url, { signal: AbortSignal.timeout(3e4) });
  if (!response.ok) throw new Error(`Composer signature: HTTP ${String(response.status)}`);
  const signature = Buffer.from(await response.arrayBuffer());
  if (signature.length > 64 * 1024) throw new Error("Composer signature exceeds its size limit");
  return {
    schema_version: 1,
    source_hashes: {
      ".composer-version": createHash("sha256").update(readFileSync(join(directory, ".composer-version"))).digest("hex")
    },
    inputs: [
      {
        url: asset.url,
        hash: `sha256-${Buffer.from(asset.sha256, "hex").toString("base64")}`,
        destination: "bootstrap/composer.phar"
      },
      {
        url: asset.signature.url,
        hash: `sha256-${createHash("sha256").update(signature).digest("base64")}`,
        destination: "bootstrap/composer.phar.asc"
      }
    ]
  };
}
async function collectManagedRefresh(root, acquire = {}) {
  const projects = (await import("smol-toml")).parse(readFileSync(join(root, "workbench/projects.toml"), "utf8"));
  const files = [];
  const outputJSON = (path, value) => files.push([path, `${JSON.stringify(value, null, 2)}
`]);
  let bootstrap;
  const registry = /* @__PURE__ */ new Map();
  for (const path of [
    ...new Set(
      records(projects.language_root, "Missing language roots").map(
        (entry) => string(entry.path, "Missing language root path")
      )
    )
  ]) {
    const directory = join(root, path);
    const extras = [];
    if (existsSync(join(directory, "pnpm-lock.yaml"))) {
      bootstrap ??= await (acquire.bootstrap ?? refreshManagedBootstrap)(root);
      outputJSON(join(directory, "managed-bootstrap.json"), bootstrap);
      files.push([
        join(directory, "managed-registry.json.br"),
        await (acquire.registry ?? refreshNpmRegistry)(directory, registry)
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
            "GOROOT"
          ],
          { cwd: root, encoding: "utf8" }
        ).trim().split(/\r?\n/).at(-1);
        result = refreshGoInputs(directory, [
          join(required(goroot, "Missing Go root"), "bin", process.platform === "win32" ? "go.exe" : "go")
        ]);
      }
      extras.push(result);
    }
    if (existsSync(join(directory, ".composer-version")))
      extras.push(await (acquire.composer ?? refreshComposerBootstrap)(directory, root));
    if (extras.length) {
      const hashes = /* @__PURE__ */ Object.create(null);
      const inputs = /* @__PURE__ */ new Map();
      for (const extra of extras) {
        const declaration = managedDeclaration(extra);
        for (const [file, hash] of Object.entries(declaration.source_hashes)) {
          if (hashes[file] !== void 0 && hashes[file] !== hash)
            throw new Error(`Conflicting supplemental source identity: ${file}`);
          hashes[file] = hash;
        }
        for (const input of declaration.inputs) {
          const previous = inputs.get(input.destination);
          if (previous && (previous.url !== input.url || previous.hash !== input.hash || JSON.stringify([...previous.platforms ?? []].sort()) !== JSON.stringify([...input.platforms ?? []].sort())))
            throw new Error(`Conflicting supplemental artifact: ${input.destination}`);
          inputs.set(input.destination, input);
        }
      }
      outputJSON(
        join(directory, "managed-extra-inputs.json"),
        managedDeclaration({ schema_version: 1, source_hashes: hashes, inputs: [...inputs.values()] })
      );
    }
  }
  return files;
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename)
  replaceManagedFiles(await collectManagedRefresh(resolve(import.meta.dirname, "..")));
export {
  collectManagedRefresh,
  npmRegistrySnapshot,
  refreshComposerBootstrap,
  refreshGoInputs,
  refreshManagedBootstrap,
  refreshNpmRegistry,
  refreshPythonBuildInputs
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInJlZnJlc2gtbWFuYWdlZC1pbnB1dHMubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHJlcXVpcmVkLCByZWNvcmQsIHJlY29yZHMsIHN0cmluZywgc3RyaW5ncywgc3RyaW5nUmVjb3JkIH0gZnJvbSBcIi4vdmFsdWVzLm1qc1wiO1xuaW1wb3J0IHsgdHlwZSBNYW5hZ2VkU291cmNlLCBtYW5hZ2VkRGVjbGFyYXRpb24gfSBmcm9tIFwiLi9tYW5hZ2VkLXNvdXJjZS1jb250cmFjdC5tanNcIjtcbmltcG9ydCB7IHJlYWROcG1Mb2NrIH0gZnJvbSBcIi4vbWFuYWdlZC1jaGVjay1pbnB1dHMubWpzXCI7XG5pbnRlcmZhY2UgTnBtTWFuaWZlc3Qge1xuICBuYW1lPzogc3RyaW5nO1xuICB2ZXJzaW9uPzogc3RyaW5nO1xuICBkZXByZWNhdGVkPzogdW5rbm93bjtcbiAgX25wbVVzZXI/OiB1bmtub3duO1xuICBkaXN0Pzoge1xuICAgIGludGVncml0eT86IHN0cmluZztcbiAgICB0YXJiYWxsPzogc3RyaW5nO1xuICAgIGF0dGVzdGF0aW9ucz86IHsgdXJsPzogc3RyaW5nOyBwcm92ZW5hbmNlPzogdW5rbm93biB9O1xuICAgIHJldmlzaW9ucz86IHVua25vd247XG4gIH07XG59XG5pbnRlcmZhY2UgTnBtTWV0YWRhdGEge1xuICBuYW1lOiBzdHJpbmc7XG4gIHRpbWU6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gIG1vZGlmaWVkPzogc3RyaW5nO1xuICBcImRpc3QtdGFnc1wiPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgdmVyc2lvbnM6IFJlY29yZDxzdHJpbmcsIE5wbU1hbmlmZXN0Pjtcbn1cblxuaW1wb3J0IHsgcmVwbGFjZU1hbmFnZWRGaWxlcyB9IGZyb20gXCIuL21hbmFnZWQtZmlsZXMubWpzXCI7XG5pbXBvcnQgeyBjcmVhdGVIYXNoIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMsIGNvcHlGaWxlU3luYywgbWtkdGVtcFN5bmMsIHJtU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgcGF0aFRvRmlsZVVSTCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgZXhlY0ZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGJyb3RsaUNvbXByZXNzU3luYywgY29uc3RhbnRzIH0gZnJvbSBcIm5vZGU6emxpYlwiO1xuaW1wb3J0IHsgcG5wbVBhY2thZ2VzLCBwbnBtSWRlbnRpdHkgfSBmcm9tIFwiLi9wbnBtLWxvY2subWpzXCI7XG5pbXBvcnQgdHlwZSB7IFBhdGhPckZpbGVEZXNjcmlwdG9yIH0gZnJvbSBcImZzXCI7XG5cbmNvbnN0IGpzb24gPSAocGF0aDogUGF0aE9yRmlsZURlc2NyaXB0b3IpOiB1bmtub3duID0+IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSk7XG5cbmFzeW5jIGZ1bmN0aW9uIHJlZ2lzdHJ5SlNPTih1cmw6IHN0cmluZywgbGltaXQgPSAyICogMTAyNCAqKiAyKSB7XG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2godXJsLCB7IHJlZGlyZWN0OiBcImVycm9yXCIsIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgzMF8wMDApIH0pO1xuICBpZiAoIXJlc3BvbnNlLm9rKSB0aHJvdyBuZXcgRXJyb3IoYCR7dXJsfTogSFRUUCAke1N0cmluZyhyZXNwb25zZS5zdGF0dXMpfWApO1xuICBjb25zdCBjaHVua3MgPSBbXTtcbiAgbGV0IGxlbmd0aCA9IDA7XG4gIGZvciBhd2FpdCAoY29uc3QgYnl0ZXMgb2YgcmVxdWlyZWQocmVzcG9uc2UuYm9keSwgXCJNaXNzaW5nIHJlZ2lzdHJ5IHJlc3BvbnNlIGJvZHlcIikpIHtcbiAgICBsZW5ndGggKz0gYnl0ZXMubGVuZ3RoO1xuICAgIGlmIChsZW5ndGggPiBsaW1pdCkgdGhyb3cgbmV3IEVycm9yKGAke3VybH06IG1ldGFkYXRhIGV4Y2VlZHMgaXRzIHNpemUgbGltaXRgKTtcbiAgICBjaHVua3MucHVzaChCdWZmZXIuZnJvbShieXRlcykpO1xuICB9XG4gIGNvbnN0IHZhbHVlOiB1bmtub3duID0gSlNPTi5wYXJzZShCdWZmZXIuY29uY2F0KGNodW5rcykudG9TdHJpbmcoXCJ1dGY4XCIpKTtcbiAgcmV0dXJuIHZhbHVlO1xufVxuXG5mdW5jdGlvbiBucG1NYW5pZmVzdCh2YWx1ZTogdW5rbm93bik6IE5wbU1hbmlmZXN0IHtcbiAgY29uc3QgZW50cnkgPSByZWNvcmQodmFsdWUsIFwiSW52YWxpZCBucG0gbWFuaWZlc3RcIik7XG4gIGZvciAoY29uc3QgbmFtZSBvZiBbXCJuYW1lXCIsIFwidmVyc2lvblwiXSlcbiAgICBpZiAoZW50cnlbbmFtZV0gIT09IHVuZGVmaW5lZCkgc3RyaW5nKGVudHJ5W25hbWVdLCBcIkludmFsaWQgbnBtIG1hbmlmZXN0IGZpZWxkXCIpO1xuICBpZiAoZW50cnkuZGlzdCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgZGlzdCA9IHJlY29yZChlbnRyeS5kaXN0LCBcIkludmFsaWQgbnBtIGRpc3RyaWJ1dGlvblwiKTtcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgW1wiaW50ZWdyaXR5XCIsIFwidGFyYmFsbFwiXSlcbiAgICAgIGlmIChkaXN0W25hbWVdICE9PSB1bmRlZmluZWQpIHN0cmluZyhkaXN0W25hbWVdLCBcIkludmFsaWQgbnBtIGRpc3RyaWJ1dGlvbiBmaWVsZFwiKTtcbiAgICBpZiAoZGlzdC5hdHRlc3RhdGlvbnMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgYXR0ZXN0YXRpb25zID0gcmVjb3JkKGRpc3QuYXR0ZXN0YXRpb25zLCBcIkludmFsaWQgbnBtIGF0dGVzdGF0aW9uc1wiKTtcbiAgICAgIGlmIChhdHRlc3RhdGlvbnMudXJsICE9PSB1bmRlZmluZWQpIHN0cmluZyhhdHRlc3RhdGlvbnMudXJsLCBcIkludmFsaWQgbnBtIGF0dGVzdGF0aW9uIFVSTFwiKTtcbiAgICB9XG4gIH1cbiAgLy8gT3B0aW9uYWwgZmllbGRzIGFib3ZlIGFyZSBjaGVja2VkOyBoaXN0b3JpY2FsIG1ldGFkYXRhIG5vdCB1c2VkIGJ5IHRoaXMgYWRhcHRlciByZW1haW5zIGludGFjdC5cbiAgcmV0dXJuIGVudHJ5O1xufVxuXG5mdW5jdGlvbiBucG1NZXRhZGF0YSh2YWx1ZTogdW5rbm93bik6IE5wbU1ldGFkYXRhIHtcbiAgY29uc3QgZW50cnkgPSByZWNvcmQodmFsdWUsIFwiSW52YWxpZCBucG0gcmVnaXN0cnkgbWV0YWRhdGFcIik7XG4gIHJldHVybiB7XG4gICAgbmFtZTogc3RyaW5nKGVudHJ5Lm5hbWUsIFwiTWlzc2luZyByZWdpc3RyeSBwYWNrYWdlIG5hbWVcIiksXG4gICAgdGltZTogc3RyaW5nUmVjb3JkKGVudHJ5LnRpbWUsIFwiSW52YWxpZCBwdWJsaWNhdGlvbiB0aW1lc1wiKSxcbiAgICB2ZXJzaW9uczogT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgT2JqZWN0LmVudHJpZXMocmVjb3JkKGVudHJ5LnZlcnNpb25zLCBcIk1pc3NpbmcgcGFja2FnZSB2ZXJzaW9uc1wiKSkubWFwKChbdmVyc2lvbiwgbWFuaWZlc3RdKSA9PiBbXG4gICAgICAgIHZlcnNpb24sXG4gICAgICAgIG5wbU1hbmlmZXN0KG1hbmlmZXN0KSxcbiAgICAgIF0pLFxuICAgICksXG4gICAgLi4uKGVudHJ5Lm1vZGlmaWVkID09PSB1bmRlZmluZWQgPyB7fSA6IHsgbW9kaWZpZWQ6IHN0cmluZyhlbnRyeS5tb2RpZmllZCwgXCJJbnZhbGlkIHJlZ2lzdHJ5IG1vZGlmaWNhdGlvbiB0aW1lXCIpIH0pLFxuICAgIC4uLihlbnRyeVtcImRpc3QtdGFnc1wiXSA9PT0gdW5kZWZpbmVkXG4gICAgICA/IHt9XG4gICAgICA6IHsgXCJkaXN0LXRhZ3NcIjogc3RyaW5nUmVjb3JkKGVudHJ5W1wiZGlzdC10YWdzXCJdLCBcIkludmFsaWQgbnBtIGRpc3QgdGFnc1wiKSB9KSxcbiAgfTtcbn1cblxuLy8gRnJvemVuIGluc3RhbGxzIHJlYWQgZnVsbCBtYW5pZmVzdHMgb25seSBmb3IgbG9ja2VkIHZlcnNpb25zLiBwbnBtJ3MgdHJ1c3QtaGlzdG9yeSB3YWxrIHJlYWRzIHB1YmxpY2F0aW9uXG4vLyB0aW1lcywgZGlzdC5hdHRlc3RhdGlvbnMsIGFuZCBfbnBtVXNlciAodHJ1c3RlZFB1Ymxpc2hlciBhbmQgYXBwcm92ZXIpLiBLZWVwIGV2ZXJ5IGhpc3RvcmljYWwgdmVyc2lvbi5cbi8vIFJlZmVyZW5jZTogcG5wbSB2MTIuMTEuMiwgY3JhdGVzL3Jlc29sdmluZy1ucG0tcmVzb2x2ZXIvc3JjL3t0cnVzdF9jaGVja3MsY3JlYXRlX25wbV9yZXNvbHV0aW9uX3ZlcmlmaWVyL21ldGFkYXRhX3Byb2plY3Rpb259LnJzLlxuZXhwb3J0IGZ1bmN0aW9uIG5wbVJlZ2lzdHJ5U25hcHNob3QoZGlyZWN0b3J5OiBzdHJpbmcsIG1ldGFkYXRhOiBSZWNvcmQ8c3RyaW5nLCBOcG1NZXRhZGF0YT4pIHtcbiAgY29uc3QgZG9jdW1lbnQgPSB7IHBhY2thZ2VzOiBwbnBtUGFja2FnZXMocmVhZEZpbGVTeW5jKGpvaW4oZGlyZWN0b3J5LCBcInBucG0tbG9jay55YW1sXCIpLCBcInV0ZjhcIikpIH07XG4gIGNvbnN0IGxvY2tlZCA9IG5ldyBNYXA8c3RyaW5nLCBNYXA8c3RyaW5nLCBzdHJpbmcgfCB1bmRlZmluZWQ+PigpO1xuICBmb3IgKGNvbnN0IFtrZXksIGVudHJ5XSBvZiBPYmplY3QuZW50cmllcyhyZWFkTnBtTG9jayhkb2N1bWVudCkucGFja2FnZXMgPz8ge30pKSB7XG4gICAgY29uc3QgeyBuYW1lLCB2ZXJzaW9uIH0gPSBwbnBtSWRlbnRpdHkoa2V5KTtcbiAgICBjb25zdCB2ZXJzaW9ucyA9IGxvY2tlZC5nZXQobmFtZSkgPz8gbmV3IE1hcDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD4oKTtcbiAgICB2ZXJzaW9ucy5zZXQodmVyc2lvbiwgZW50cnkucmVzb2x1dGlvbj8uaW50ZWdyaXR5KTtcbiAgICBsb2NrZWQuc2V0KG5hbWUsIHZlcnNpb25zKTtcbiAgfVxuICBjb25zdCBwYWNrYWdlczogUmVjb3JkPHN0cmluZywgTnBtTWV0YWRhdGE+ID0ge307XG4gIGZvciAoY29uc3QgW25hbWUsIGxvY2tlZFZlcnNpb25zXSBvZiBbLi4ubG9ja2VkXS5zb3J0KChbbGVmdF0sIFtyaWdodF0pID0+IGxlZnQubG9jYWxlQ29tcGFyZShyaWdodCkpKSB7XG4gICAgY29uc3QgdmFsdWUgPSBtZXRhZGF0YVtuYW1lXTtcbiAgICBpZiAodmFsdWU/Lm5hbWUgIT09IG5hbWUgfHwgIU9iamVjdC5oYXNPd24odmFsdWUsIFwidmVyc2lvbnNcIikgfHwgIU9iamVjdC5oYXNPd24odmFsdWUsIFwidGltZVwiKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgSW5jb21wbGV0ZSByZWdpc3RyeSBtZXRhZGF0YTogJHtuYW1lfWApO1xuICAgIGZvciAoY29uc3QgW3ZlcnNpb24sIGludGVncml0eV0gb2YgbG9ja2VkVmVyc2lvbnMpIHtcbiAgICAgIGlmICh2YWx1ZS52ZXJzaW9uc1t2ZXJzaW9uXT8uZGlzdD8uaW50ZWdyaXR5ICE9PSBpbnRlZ3JpdHkpXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVnaXN0cnkgbWV0YWRhdGEgZG9lcyBub3QgbWF0Y2ggbG9ja2VkIGludGVncml0eTogJHtuYW1lfUAke3ZlcnNpb259YCk7XG4gICAgfVxuICAgIHBhY2thZ2VzW25hbWVdID0ge1xuICAgICAgbmFtZSxcbiAgICAgIHRpbWU6IHZhbHVlLnRpbWUsXG4gICAgICAuLi4odmFsdWUubW9kaWZpZWQgPT09IHVuZGVmaW5lZCA/IHt9IDogeyBtb2RpZmllZDogdmFsdWUubW9kaWZpZWQgfSksXG4gICAgICAuLi4odmFsdWVbXCJkaXN0LXRhZ3NcIl0gPT09IHVuZGVmaW5lZCA/IHt9IDogeyBcImRpc3QtdGFnc1wiOiB2YWx1ZVtcImRpc3QtdGFnc1wiXSB9KSxcbiAgICAgIHZlcnNpb25zOiBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgICAgIE9iamVjdC5lbnRyaWVzKHZhbHVlLnZlcnNpb25zKS5tYXAoKFt2ZXJzaW9uLCBtYW5pZmVzdF0pID0+IFtcbiAgICAgICAgICB2ZXJzaW9uLFxuICAgICAgICAgIGxvY2tlZFZlcnNpb25zLmhhcyh2ZXJzaW9uKVxuICAgICAgICAgICAgPyBtYW5pZmVzdFxuICAgICAgICAgICAgOiB7XG4gICAgICAgICAgICAgICAgbmFtZSxcbiAgICAgICAgICAgICAgICB2ZXJzaW9uLFxuICAgICAgICAgICAgICAgIGRlcHJlY2F0ZWQ6IG1hbmlmZXN0LmRlcHJlY2F0ZWQsXG4gICAgICAgICAgICAgICAgX25wbVVzZXI6IG1hbmlmZXN0Ll9ucG1Vc2VyLFxuICAgICAgICAgICAgICAgIGRpc3Q6IHtcbiAgICAgICAgICAgICAgICAgIC4uLihtYW5pZmVzdC5kaXN0Py50YXJiYWxsID09PSB1bmRlZmluZWQgPyB7fSA6IHsgdGFyYmFsbDogbWFuaWZlc3QuZGlzdC50YXJiYWxsIH0pLFxuICAgICAgICAgICAgICAgICAgLi4uKG1hbmlmZXN0LmRpc3Q/LmF0dGVzdGF0aW9ucyA9PT0gdW5kZWZpbmVkID8ge30gOiB7IGF0dGVzdGF0aW9uczogbWFuaWZlc3QuZGlzdC5hdHRlc3RhdGlvbnMgfSksXG4gICAgICAgICAgICAgICAgICByZXZpc2lvbnM6IG1hbmlmZXN0LmRpc3Q/LnJldmlzaW9ucyxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB9LFxuICAgICAgICBdKSxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuICByZXR1cm4gYnJvdGxpQ29tcHJlc3NTeW5jKEJ1ZmZlci5mcm9tKEpTT04uc3RyaW5naWZ5KHBhY2thZ2VzKSksIHtcbiAgICBwYXJhbXM6IHsgW2NvbnN0YW50cy5CUk9UTElfUEFSQU1fUVVBTElUWV06IDkgfSxcbiAgfSk7XG59XG5cbi8qKiBSZXRhaW4gcHVibGljYXRpb24gaGlzdG9yeSBhbmQgdHJ1c3QgZXZpZGVuY2Ugd2l0aG91dCB1bnJlbGF0ZWQgaGlzdG9yaWNhbCBtYW5pZmVzdHMgYW5kIHNpZ25hdHVyZXMuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVmcmVzaE5wbVJlZ2lzdHJ5KGRpcmVjdG9yeTogc3RyaW5nLCBjYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBQcm9taXNlPE5wbU1ldGFkYXRhPj4oKSkge1xuICBjb25zdCBuYW1lcyA9IFtcbiAgICAuLi5uZXcgU2V0KFxuICAgICAgT2JqZWN0LmtleXMocG5wbVBhY2thZ2VzKHJlYWRGaWxlU3luYyhqb2luKGRpcmVjdG9yeSwgXCJwbnBtLWxvY2sueWFtbFwiKSwgXCJ1dGY4XCIpKSkubWFwKFxuICAgICAgICAoa2V5KSA9PiBwbnBtSWRlbnRpdHkoa2V5KS5uYW1lLFxuICAgICAgKSxcbiAgICApLFxuICBdLnNvcnQoKTtcbiAgY29uc3QgbWV0YWRhdGE6IFJlY29yZDxzdHJpbmcsIE5wbU1ldGFkYXRhPiA9IHt9O1xuICBmb3IgKGxldCBvZmZzZXQgPSAwOyBvZmZzZXQgPCBuYW1lcy5sZW5ndGg7IG9mZnNldCArPSA4KSB7XG4gICAgYXdhaXQgUHJvbWlzZS5hbGwoXG4gICAgICBuYW1lcy5zbGljZShvZmZzZXQsIG9mZnNldCArIDgpLm1hcChhc3luYyAobmFtZSkgPT4ge1xuICAgICAgICBpZiAoIWNhY2hlLmhhcyhuYW1lKSlcbiAgICAgICAgICBjYWNoZS5zZXQobmFtZSwgcmVnaXN0cnlKU09OKGBodHRwczovL3JlZ2lzdHJ5Lm5wbWpzLm9yZy8ke25hbWV9YCwgNjQgKiAxMDI0ICoqIDIpLnRoZW4obnBtTWV0YWRhdGEpKTtcbiAgICAgICAgbWV0YWRhdGFbbmFtZV0gPSBhd2FpdCByZXF1aXJlZChjYWNoZS5nZXQobmFtZSksIGBNaXNzaW5nIHJlZ2lzdHJ5IHJlcXVlc3Q6ICR7bmFtZX1gKTtcbiAgICAgIH0pLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIG5wbVJlZ2lzdHJ5U25hcHNob3QoZGlyZWN0b3J5LCBtZXRhZGF0YSk7XG59XG5cbi8qKiBSZWZyZXNoIHByb29mIG1hdGVyaWFsIGZvciB0aGUgYWxyZWFkeSBsb2NrZWQgbWFuYWdlcjsgdGhpcyBuZXZlciByZXNvbHZlcyBhIG5ldyB2ZXJzaW9uLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlZnJlc2hNYW5hZ2VkQm9vdHN0cmFwKGRpc3RyaWJ1dGlvbjogc3RyaW5nKSB7XG4gIGNvbnN0IHNvdXJjZSA9IGpvaW4oZGlzdHJpYnV0aW9uLCBcInNjcmlwdHMvcGFja2FnZS1tYW5hZ2VyXCIpO1xuICBjb25zdCBwYWNrYWdlSlNPTiA9IGpzb24oam9pbihzb3VyY2UsIFwicGFja2FnZS5qc29uXCIpKTtcbiAgY29uc3QgbG9jayA9IHJlY29yZChqc29uKGpvaW4oc291cmNlLCBcInBhY2thZ2UtbG9jay5qc29uXCIpKSwgXCJJbnZhbGlkIGJvb3RzdHJhcCBsb2NrXCIpO1xuICBjb25zdCBwcm9vZnMgPSBbXTtcbiAgY29uc3QgeyB2ZXJpZnlBdHRlc3RhdGlvbiB9ID0gKGF3YWl0IGltcG9ydChcbiAgICBwYXRoVG9GaWxlVVJMKGpvaW4oZGlzdHJpYnV0aW9uLCBcInNyYy9hdHRlc3RhdGlvbi12ZXJpZmljYXRpb24udHNcIikpLmhyZWZcbiAgKSkgYXMgdHlwZW9mIGltcG9ydChcIi4uL3NyYy9hdHRlc3RhdGlvbi12ZXJpZmljYXRpb24uanNcIik7XG4gIGNvbnN0IHJvb3RzID0gcmVhZEZpbGVTeW5jKGpvaW4oZGlzdHJpYnV0aW9uLCBcInNjcmlwdHMva2V5cy9zaWdzdG9yZS10cnVzdGVkLXJvb3QuanNvbmxcIiksIFwidXRmOFwiKTtcbiAgZm9yIChjb25zdCBbcGF0aCwgcmF3XSBvZiBPYmplY3QuZW50cmllcyhyZWNvcmQobG9jay5wYWNrYWdlcywgXCJNaXNzaW5nIGJvb3RzdHJhcCBwYWNrYWdlc1wiKSkpIHtcbiAgICBpZiAoIXBhdGgpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGVudHJ5ID0gcmVjb3JkKHJhdywgXCJJbnZhbGlkIGJvb3RzdHJhcCBwYWNrYWdlXCIpO1xuICAgIGlmIChcbiAgICAgIChlbnRyeS5vcyAhPT0gdW5kZWZpbmVkICYmICFzdHJpbmdzKGVudHJ5Lm9zLCBcIkludmFsaWQgYm9vdHN0cmFwIE9TIGxpc3RcIikuaW5jbHVkZXMoXCJsaW51eFwiKSkgfHxcbiAgICAgIChlbnRyeS5jcHUgIT09IHVuZGVmaW5lZCAmJlxuICAgICAgICAhc3RyaW5ncyhlbnRyeS5jcHUsIFwiSW52YWxpZCBib290c3RyYXAgQ1BVIGxpc3RcIikuc29tZSgoYXJjaCkgPT4gW1wieDY0XCIsIFwiYXJtNjRcIl0uaW5jbHVkZXMoYXJjaCkpKSB8fFxuICAgICAgKGVudHJ5LmxpYmMgIT09IHVuZGVmaW5lZCAmJiAhc3RyaW5ncyhlbnRyeS5saWJjLCBcIkludmFsaWQgYm9vdHN0cmFwIGxpYmMgbGlzdFwiKS5pbmNsdWRlcyhcImdsaWJjXCIpKVxuICAgIClcbiAgICAgIGNvbnRpbnVlO1xuICAgIGNvbnN0IG5hbWUgPSBwYXRoLnJlcGxhY2UoL15ub2RlX21vZHVsZXNcXC8vLCBcIlwiKTtcbiAgICBjb25zdCB2ZXJzaW9uID0gc3RyaW5nKGVudHJ5LnZlcnNpb24sIFwiTWlzc2luZyBib290c3RyYXAgdmVyc2lvblwiKSxcbiAgICAgIGludGVncml0eSA9IHN0cmluZyhlbnRyeS5pbnRlZ3JpdHksIFwiTWlzc2luZyBib290c3RyYXAgaW50ZWdyaXR5XCIpLFxuICAgICAgcmVzb2x2ZWQgPSBzdHJpbmcoZW50cnkucmVzb2x2ZWQsIFwiTWlzc2luZyBib290c3RyYXAgVVJMXCIpO1xuICAgIGNvbnN0IG1ldGFkYXRhID0gbnBtTWFuaWZlc3QoYXdhaXQgcmVnaXN0cnlKU09OKGBodHRwczovL3JlZ2lzdHJ5Lm5wbWpzLm9yZy8ke25hbWV9LyR7dmVyc2lvbn1gKSk7XG4gICAgaWYgKG1ldGFkYXRhLmRpc3Q/LmludGVncml0eSAhPT0gaW50ZWdyaXR5IHx8IG1ldGFkYXRhLmRpc3QudGFyYmFsbCAhPT0gcmVzb2x2ZWQpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFJlZ2lzdHJ5IG1ldGFkYXRhIGRvZXMgbm90IG1hdGNoIHRoZSBsb2NrZWQgYm9vdHN0cmFwOiAke25hbWV9YCk7XG4gICAgY29uc3QgZW5kcG9pbnQgPSBuZXcgVVJMKHJlcXVpcmVkKG1ldGFkYXRhLmRpc3QuYXR0ZXN0YXRpb25zPy51cmwsIFwiTWlzc2luZyByZWdpc3RyeSBhdHRlc3RhdGlvbiBVUkxcIikpO1xuICAgIGlmIChlbmRwb2ludC5vcmlnaW4gIT09IFwiaHR0cHM6Ly9yZWdpc3RyeS5ucG1qcy5vcmdcIiB8fCAhZW5kcG9pbnQucGF0aG5hbWUuc3RhcnRzV2l0aChcIi8tL25wbS92MS9hdHRlc3RhdGlvbnMvXCIpKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBNaXNzaW5nIGV4cGVjdGVkIGJvb3RzdHJhcCBwcm92ZW5hbmNlOiAke25hbWV9YCk7XG4gICAgY29uc3QgYXR0ZXN0YXRpb25zID0gcmVjb3JkKGF3YWl0IHJlZ2lzdHJ5SlNPTihlbmRwb2ludC5ocmVmKSwgXCJJbnZhbGlkIHJlZ2lzdHJ5IGF0dGVzdGF0aW9uc1wiKTtcbiAgICBjb25zdCBwcm92ZW5hbmNlID0gcmVjb3JkcyhhdHRlc3RhdGlvbnMuYXR0ZXN0YXRpb25zLCBcIk1pc3NpbmcgYXR0ZXN0YXRpb24gcmVjb3Jkc1wiKS5maW5kKFxuICAgICAgKGVudHJ5KSA9PiBlbnRyeS5wcmVkaWNhdGVUeXBlID09PSBcImh0dHBzOi8vc2xzYS5kZXYvcHJvdmVuYW5jZS92MVwiLFxuICAgICk7XG4gICAgaWYgKCFwcm92ZW5hbmNlPy5idW5kbGUpIHRocm93IG5ldyBFcnJvcihgTWlzc2luZyBib290c3RyYXAgU0xTQSBwcm92ZW5hbmNlOiAke25hbWV9YCk7XG4gICAgY29uc3Qgc2lnbmVyID0gYGh0dHBzOi8vZ2l0aHViLmNvbS9wbnBtL3BucG0vLmdpdGh1Yi93b3JrZmxvd3MvcmVsZWFzZS55bWxAcmVmcy90YWdzL3Yke3ZlcnNpb259YDtcbiAgICBjb25zdCBzdWJqZWN0ID0gYHBrZzpucG0vJHtuYW1lLnJlcGxhY2UoXCJAXCIsIFwiJTQwXCIpfUAke3ZlcnNpb259YDtcbiAgICBjb25zdCBwcm9vZiA9IHtcbiAgICAgIG5hbWUsXG4gICAgICB2ZXJzaW9uLFxuICAgICAgaW50ZWdyaXR5LFxuICAgICAgc2lnbmVyLFxuICAgICAgc3ViamVjdCxcbiAgICAgIGJ1bmRsZTogcHJvdmVuYW5jZS5idW5kbGUsXG4gICAgfTtcbiAgICB2ZXJpZnlBdHRlc3RhdGlvbihcbiAgICAgIEpTT04uc3RyaW5naWZ5KHByb29mLmJ1bmRsZSksXG4gICAgICBCdWZmZXIuZnJvbShpbnRlZ3JpdHkuc2xpY2UoNyksIFwiYmFzZTY0XCIpLnRvU3RyaW5nKFwiaGV4XCIpLFxuICAgICAge1xuICAgICAgICBzaWduZXIsXG4gICAgICAgIHN1YmplY3QsXG4gICAgICAgIHJvb3RzLFxuICAgICAgfSxcbiAgICAgIFwic2hhNTEyXCIsXG4gICAgKTtcbiAgICBwcm9vZnMucHVzaChwcm9vZik7XG4gIH1cbiAgcmV0dXJuIHsgc2NoZW1hX3ZlcnNpb246IDEsIHBhY2thZ2VfanNvbjogcGFja2FnZUpTT04sIHBhY2thZ2VfbG9jazogbG9jaywgcHJvb2ZzIH07XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWZyZXNoUHl0aG9uQnVpbGRJbnB1dHMoZGlyZWN0b3J5OiBzdHJpbmcpIHtcbiAgY29uc3QgeyBwYXJzZSB9ID0gYXdhaXQgaW1wb3J0KFwic21vbC10b21sXCIpO1xuICBjb25zdCBweXByb2plY3QgPSBwYXJzZShyZWFkRmlsZVN5bmMoam9pbihkaXJlY3RvcnksIFwicHlwcm9qZWN0LnRvbWxcIiksIFwidXRmOFwiKSk7XG4gIGNvbnN0IGlucHV0cyA9IFtdO1xuICBmb3IgKGNvbnN0IHJlcXVpcmVtZW50IG9mIHN0cmluZ3MoXG4gICAgcmVjb3JkKHB5cHJvamVjdFtcImJ1aWxkLXN5c3RlbVwiXSwgXCJNaXNzaW5nIFB5dGhvbiBidWlsZCBzeXN0ZW1cIikucmVxdWlyZXMsXG4gICAgXCJJbnZhbGlkIFB5dGhvbiBidWlsZCByZXF1aXJlbWVudHNcIixcbiAgKSkge1xuICAgIGNvbnN0IHByZXZpb3VzID0gaW5wdXRzLmxlbmd0aDtcbiAgICBjb25zdCBtYXRjaCA9IC9eKFtBLVphLXowLTkuXy1dKyk9PShbQS1aYS16MC05LitfLV0rKSQvLmV4ZWMocmVxdWlyZW1lbnQpO1xuICAgIGlmICghbWF0Y2gpIHRocm93IG5ldyBFcnJvcihgTWFuYWdlZCBidWlsZCByZXF1aXJlbWVudHMgbmVlZCBleGFjdCBwaW5zOiAke3JlcXVpcmVtZW50fWApO1xuICAgIGNvbnN0IG1ldGFkYXRhID0gcmVjb3JkKFxuICAgICAgYXdhaXQgcmVnaXN0cnlKU09OKGBodHRwczovL3B5cGkub3JnL3B5cGkvJHtTdHJpbmcobWF0Y2hbMV0pfS8ke1N0cmluZyhtYXRjaFsyXSl9L2pzb25gKSxcbiAgICAgIFwiSW52YWxpZCBQeVBJIG1ldGFkYXRhXCIsXG4gICAgKTtcbiAgICBmb3IgKGNvbnN0IHJhdyBvZiByZWNvcmRzKG1ldGFkYXRhLnVybHMsIFwiTWlzc2luZyBQeVBJIGZpbGVzXCIpKSB7XG4gICAgICBjb25zdCBmaWxlID0ge1xuICAgICAgICBmaWxlbmFtZTogc3RyaW5nKHJhdy5maWxlbmFtZSwgXCJNaXNzaW5nIFB5UEkgZmlsZW5hbWVcIiksXG4gICAgICAgIHVybDogc3RyaW5nKHJhdy51cmwsIFwiTWlzc2luZyBQeVBJIFVSTFwiKSxcbiAgICAgICAgZGlnZXN0czogeyBzaGEyNTY6IHN0cmluZyhyZWNvcmQocmF3LmRpZ2VzdHMsIFwiTWlzc2luZyBQeVBJIGRpZ2VzdHNcIikuc2hhMjU2LCBcIk1pc3NpbmcgUHlQSSBTSEEtMjU2XCIpIH0sXG4gICAgICB9O1xuICAgICAgaWYgKCFmaWxlLmZpbGVuYW1lLmVuZHNXaXRoKFwiLWFueS53aGxcIikpIGNvbnRpbnVlO1xuICAgICAgaWYgKCEvXlthLWYwLTldezY0fSQvLnRlc3QoZmlsZS5kaWdlc3RzLnNoYTI1NikpIHRocm93IG5ldyBFcnJvcihcIlB5UEkgYnVpbGQgaW5wdXQgaGFzIG5vIHN0cm9uZyBpbnRlZ3JpdHlcIik7XG4gICAgICBpbnB1dHMucHVzaCh7XG4gICAgICAgIHVybDogZmlsZS51cmwsXG4gICAgICAgIGhhc2g6IGBzaGEyNTYtJHtCdWZmZXIuZnJvbShmaWxlLmRpZ2VzdHMuc2hhMjU2LCBcImhleFwiKS50b1N0cmluZyhcImJhc2U2NFwiKX1gLFxuICAgICAgICBkZXN0aW5hdGlvbjogYHB5dGhvbi8ke2ZpbGUuZmlsZW5hbWV9YCxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBpZiAoaW5wdXRzLmxlbmd0aCA9PT0gcHJldmlvdXMpIHRocm93IG5ldyBFcnJvcihgTm8gcG9ydGFibGUgZGVjbGFyZWQgd2hlZWwgZm9yIGJ1aWxkIHJlcXVpcmVtZW50OiAke3JlcXVpcmVtZW50fWApO1xuICB9XG4gIHJldHVybiB7XG4gICAgc2NoZW1hX3ZlcnNpb246IDEsXG4gICAgc291cmNlX2hhc2hlczoge1xuICAgICAgXCJweXByb2plY3QudG9tbFwiOiBjcmVhdGVIYXNoKFwic2hhMjU2XCIpXG4gICAgICAgIC51cGRhdGUocmVhZEZpbGVTeW5jKGpvaW4oZGlyZWN0b3J5LCBcInB5cHJvamVjdC50b21sXCIpKSlcbiAgICAgICAgLmRpZ2VzdChcImhleFwiKSxcbiAgICB9LFxuICAgIGlucHV0cyxcbiAgfTtcbn1cblxuLyoqIEdvIGF1dGhlbnRpY2F0ZXMgbW9kdWxlIGNvbnRlbnQgYWdhaW5zdCBnby5zdW07IHJlY29yZCB0aGUgY29ycmVzcG9uZGluZyBpbW11dGFibGUgcHJveHkgZmlsZXMuICovXG5leHBvcnQgZnVuY3Rpb24gcmVmcmVzaEdvSW5wdXRzKGRpcmVjdG9yeTogc3RyaW5nLCBjb21tYW5kID0gW1wiZ29cIl0pIHtcbiAgY29uc3Qgc3RhZ2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcIndvcmtiZW5jaC1nby1pbnB1dHMtXCIpKTtcbiAgY29uc3Qgc3VtcyA9IG5ldyBNYXAoXG4gICAgcmVhZEZpbGVTeW5jKGpvaW4oZGlyZWN0b3J5LCBcImdvLnN1bVwiKSwgXCJ1dGY4XCIpXG4gICAgICAudHJpbSgpXG4gICAgICAuc3BsaXQoXCJcXG5cIilcbiAgICAgIC5tYXAoKGxpbmUpID0+IHtcbiAgICAgICAgY29uc3QgW25hbWUsIHZlcnNpb24sIGhhc2hdID0gbGluZS5zcGxpdChcIiBcIik7XG4gICAgICAgIHJldHVybiBbYCR7U3RyaW5nKG5hbWUpfUAke1N0cmluZyh2ZXJzaW9uKX1gLCBoYXNoXTtcbiAgICAgIH0pLFxuICApO1xuICBjb25zdCBlbnYgPSB7IC4uLnByb2Nlc3MuZW52LCBHT01PRENBQ0hFOiBwcm9jZXNzLmVudi5HT01PRENBQ0hFID8/IGpvaW4oc3RhZ2UsIFwibW9kdWxlc1wiKSB9O1xuICB0cnkge1xuICAgIGZvciAoY29uc3QgZmlsZSBvZiBbXCJnby5tb2RcIiwgXCJnby5zdW1cIl0pIGNvcHlGaWxlU3luYyhqb2luKGRpcmVjdG9yeSwgZmlsZSksIGpvaW4oc3RhZ2UsIGZpbGUpKTtcbiAgICBjb25zdCBvdXRwdXQgPSBleGVjRmlsZVN5bmMoXG4gICAgICByZXF1aXJlZChjb21tYW5kWzBdLCBcIk1pc3NpbmcgR28gZXhlY3V0YWJsZVwiKSxcbiAgICAgIFsuLi5jb21tYW5kLnNsaWNlKDEpLCBcIm1vZFwiLCBcImRvd25sb2FkXCIsIFwiLWpzb25cIiwgXCJhbGxcIl0sXG4gICAgICB7XG4gICAgICAgIGN3ZDogc3RhZ2UsXG4gICAgICAgIGVuY29kaW5nOiBcInV0ZjhcIixcbiAgICAgICAgZW52LFxuICAgICAgfSxcbiAgICApO1xuICAgIGV4ZWNGaWxlU3luYyhyZXF1aXJlZChjb21tYW5kWzBdLCBcIk1pc3NpbmcgR28gZXhlY3V0YWJsZVwiKSwgWy4uLmNvbW1hbmQuc2xpY2UoMSksIFwibW9kXCIsIFwidmVyaWZ5XCJdLCB7XG4gICAgICBjd2Q6IHN0YWdlLFxuICAgICAgc3RkaW86IFwiaW5oZXJpdFwiLFxuICAgICAgZW52LFxuICAgIH0pO1xuICAgIGNvbnN0IGlucHV0cyA9IFtdO1xuICAgIGNvbnN0IGRvY3VtZW50cyA9IG91dHB1dFxuICAgICAgLnNsaWNlKG91dHB1dC5pbmRleE9mKFwie1wiKSlcbiAgICAgIC50cmltKClcbiAgICAgIC5zcGxpdCgvKD88PVxcfSlcXHMqKD89XFx7KS8pXG4gICAgICAubWFwKCh2YWx1ZSkgPT4gcmVjb3JkKEpTT04ucGFyc2UodmFsdWUpLCBcIkludmFsaWQgR28gZG93bmxvYWQgcmVjb3JkXCIpKTtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGRvY3VtZW50cykge1xuICAgICAgY29uc3QgcGF0aCA9IHN0cmluZyhlbnRyeS5QYXRoLCBcIk1pc3NpbmcgR28gbW9kdWxlIHBhdGhcIiksXG4gICAgICAgIHZlcnNpb24gPSBzdHJpbmcoZW50cnkuVmVyc2lvbiwgXCJNaXNzaW5nIEdvIG1vZHVsZSB2ZXJzaW9uXCIpO1xuICAgICAgaWYgKGVudHJ5LkVycm9yKSB0aHJvdyBuZXcgRXJyb3IoYEdvIGNvdWxkIG5vdCBhY3F1aXJlIGEgbG9ja2VkIG1vZHVsZTogJHtwYXRofWApO1xuICAgICAgY29uc3Qgc3VtID0gc3Vtcy5nZXQoYCR7cGF0aH1AJHt2ZXJzaW9ufWApLFxuICAgICAgICBtb2RTdW0gPSBzdW1zLmdldChgJHtwYXRofUAke3ZlcnNpb259L2dvLm1vZGApO1xuICAgICAgaWYgKCFzdW0gJiYgIW1vZFN1bSkgY29udGludWU7XG4gICAgICBpZiAoKHN1bSAmJiBzdW0gIT09IGVudHJ5LlN1bSkgfHwgKG1vZFN1bSAmJiBtb2RTdW0gIT09IGVudHJ5LkdvTW9kU3VtKSlcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBHbyBkaWQgbm90IHZlcmlmeSB0aGUgbG9ja2VkIG1vZHVsZTogJHtwYXRofWApO1xuICAgICAgZm9yIChjb25zdCBhcnRpZmFjdCBvZiBbLi4uKHN1bSA/IFtlbnRyeS5aaXBdIDogW10pLCBlbnRyeS5Hb01vZCwgZW50cnkuSW5mb10pIHtcbiAgICAgICAgY29uc3QgcGF0aCA9IHN0cmluZyhhcnRpZmFjdCwgXCJNaXNzaW5nIEdvIGFydGlmYWN0IHBhdGhcIik7XG4gICAgICAgIGNvbnN0IHJlbGF0aXZlID0gcGF0aC5yZXBsYWNlQWxsKFwiXFxcXFwiLCBcIi9cIikuc3BsaXQoXCIvY2FjaGUvZG93bmxvYWQvXCIpWzFdO1xuICAgICAgICBpZiAoIXJlbGF0aXZlKSB0aHJvdyBuZXcgRXJyb3IoXCJHbyByZXR1cm5lZCBhbiB1bnN1cHBvcnRlZCBwcm94eSBhcnRpZmFjdCBsb2NhdGlvblwiKTtcbiAgICAgICAgaW5wdXRzLnB1c2goe1xuICAgICAgICAgIHVybDogYGh0dHBzOi8vcHJveHkuZ29sYW5nLm9yZy8ke3JlbGF0aXZlfWAsXG4gICAgICAgICAgaGFzaDogYHNoYTI1Ni0ke2NyZWF0ZUhhc2goXCJzaGEyNTZcIikudXBkYXRlKHJlYWRGaWxlU3luYyhwYXRoKSkuZGlnZXN0KFwiYmFzZTY0XCIpfWAsXG4gICAgICAgICAgZGVzdGluYXRpb246IGBnby8ke3JlbGF0aXZlfWAsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgc2NoZW1hX3ZlcnNpb246IDEsXG4gICAgICBzb3VyY2VfaGFzaGVzOiBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgICAgIFtcImdvLm1vZFwiLCBcImdvLnN1bVwiXS5tYXAoKGZpbGUpID0+IFtcbiAgICAgICAgICBmaWxlLFxuICAgICAgICAgIGNyZWF0ZUhhc2goXCJzaGEyNTZcIilcbiAgICAgICAgICAgIC51cGRhdGUocmVhZEZpbGVTeW5jKGpvaW4oZGlyZWN0b3J5LCBmaWxlKSkpXG4gICAgICAgICAgICAuZGlnZXN0KFwiaGV4XCIpLFxuICAgICAgICBdKSxcbiAgICAgICksXG4gICAgICBpbnB1dHMsXG4gICAgfTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAoIXByb2Nlc3MuZW52LkdPTU9EQ0FDSEUpXG4gICAgICBleGVjRmlsZVN5bmMocmVxdWlyZWQoY29tbWFuZFswXSwgXCJNaXNzaW5nIEdvIGV4ZWN1dGFibGVcIiksIFsuLi5jb21tYW5kLnNsaWNlKDEpLCBcImNsZWFuXCIsIFwiLW1vZGNhY2hlXCJdLCB7XG4gICAgICAgIGN3ZDogc3RhZ2UsXG4gICAgICAgIGVudixcbiAgICAgICAgc3RkaW86IFwiaW5oZXJpdFwiLFxuICAgICAgfSk7XG4gICAgcm1TeW5jKHN0YWdlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlZnJlc2hDb21wb3NlckJvb3RzdHJhcChkaXJlY3Rvcnk6IHN0cmluZywgZGlzdHJpYnV0aW9uOiBzdHJpbmcpIHtcbiAgY29uc3QgdmVyc2lvbiA9IHJlYWRGaWxlU3luYyhqb2luKGRpcmVjdG9yeSwgXCIuY29tcG9zZXItdmVyc2lvblwiKSwgXCJ1dGY4XCIpLnRyaW0oKTtcbiAgY29uc3QgaW52ZW50b3J5ID0gcmVjb3JkKGpzb24oam9pbihkaXN0cmlidXRpb24sIFwic2NyaXB0cy9uYXRpdmUtYXNzZXRzLmpzb25cIikpLCBcIkludmFsaWQgbmF0aXZlIGFzc2V0c1wiKTtcbiAgY29uc3Qgc2VsZWN0ZWQgPSByZWNvcmQoXG4gICAgcmVjb3JkKHJlY29yZChpbnZlbnRvcnkuY29tcG9zZXIsIFwiTWlzc2luZyBDb21wb3NlciBpbnZlbnRvcnlcIilbdmVyc2lvbl0sIFwiTWlzc2luZyBDb21wb3NlciB2ZXJzaW9uXCIpW1wibGludXgteDY0XCJdLFxuICAgIFwiTWlzc2luZyBDb21wb3NlciBhc3NldFwiLFxuICApO1xuICBjb25zdCBhc3NldCA9IHtcbiAgICB1cmw6IHN0cmluZyhzZWxlY3RlZC51cmwsIFwiSW52YWxpZCBDb21wb3NlciBVUkxcIiksXG4gICAgc2hhMjU2OiBzdHJpbmcoc2VsZWN0ZWQuc2hhMjU2LCBcIkludmFsaWQgQ29tcG9zZXIgZGlnZXN0XCIpLFxuICAgIHNpZ25hdHVyZToge1xuICAgICAgdXJsOiBzdHJpbmcocmVjb3JkKHNlbGVjdGVkLnNpZ25hdHVyZSwgXCJNaXNzaW5nIENvbXBvc2VyIHNpZ25hdHVyZVwiKS51cmwsIFwiTWlzc2luZyBDb21wb3NlciBzaWduYXR1cmUgVVJMXCIpLFxuICAgIH0sXG4gIH07XG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYXNzZXQuc2lnbmF0dXJlLnVybCwgeyBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoMzBfMDAwKSB9KTtcbiAgaWYgKCFyZXNwb25zZS5vaykgdGhyb3cgbmV3IEVycm9yKGBDb21wb3NlciBzaWduYXR1cmU6IEhUVFAgJHtTdHJpbmcocmVzcG9uc2Uuc3RhdHVzKX1gKTtcbiAgY29uc3Qgc2lnbmF0dXJlID0gQnVmZmVyLmZyb20oYXdhaXQgcmVzcG9uc2UuYXJyYXlCdWZmZXIoKSk7XG4gIGlmIChzaWduYXR1cmUubGVuZ3RoID4gNjQgKiAxMDI0KSB0aHJvdyBuZXcgRXJyb3IoXCJDb21wb3NlciBzaWduYXR1cmUgZXhjZWVkcyBpdHMgc2l6ZSBsaW1pdFwiKTtcbiAgcmV0dXJuIHtcbiAgICBzY2hlbWFfdmVyc2lvbjogMSxcbiAgICBzb3VyY2VfaGFzaGVzOiB7XG4gICAgICBcIi5jb21wb3Nlci12ZXJzaW9uXCI6IGNyZWF0ZUhhc2goXCJzaGEyNTZcIilcbiAgICAgICAgLnVwZGF0ZShyZWFkRmlsZVN5bmMoam9pbihkaXJlY3RvcnksIFwiLmNvbXBvc2VyLXZlcnNpb25cIikpKVxuICAgICAgICAuZGlnZXN0KFwiaGV4XCIpLFxuICAgIH0sXG4gICAgaW5wdXRzOiBbXG4gICAgICB7XG4gICAgICAgIHVybDogYXNzZXQudXJsLFxuICAgICAgICBoYXNoOiBgc2hhMjU2LSR7QnVmZmVyLmZyb20oYXNzZXQuc2hhMjU2LCBcImhleFwiKS50b1N0cmluZyhcImJhc2U2NFwiKX1gLFxuICAgICAgICBkZXN0aW5hdGlvbjogXCJib290c3RyYXAvY29tcG9zZXIucGhhclwiLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgdXJsOiBhc3NldC5zaWduYXR1cmUudXJsLFxuICAgICAgICBoYXNoOiBgc2hhMjU2LSR7Y3JlYXRlSGFzaChcInNoYTI1NlwiKS51cGRhdGUoc2lnbmF0dXJlKS5kaWdlc3QoXCJiYXNlNjRcIil9YCxcbiAgICAgICAgZGVzdGluYXRpb246IFwiYm9vdHN0cmFwL2NvbXBvc2VyLnBoYXIuYXNjXCIsXG4gICAgICB9LFxuICAgIF0sXG4gIH07XG59XG5cbi8qKiBDb2xsZWN0IGV2ZXJ5IHJlcXVlc3RlZCBvdXRwdXQgYmVmb3JlIHRoZSBDTEkgcmVwbGFjZXMgYW55IHByb2plY3QgZmlsZS4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjb2xsZWN0TWFuYWdlZFJlZnJlc2goXG4gIHJvb3Q6IHN0cmluZyxcbiAgYWNxdWlyZToge1xuICAgIGJvb3RzdHJhcD86IChyb290OiBzdHJpbmcpID0+IFByb21pc2U8dW5rbm93bj47XG4gICAgcmVnaXN0cnk/OiB0eXBlb2YgcmVmcmVzaE5wbVJlZ2lzdHJ5O1xuICAgIHB5dGhvbj86IChkaXJlY3Rvcnk6IHN0cmluZykgPT4gdW5rbm93bjtcbiAgICBnbz86IChyb290OiBzdHJpbmcpID0+IHVua25vd247XG4gICAgY29tcG9zZXI/OiAoZGlyZWN0b3J5OiBzdHJpbmcsIGRpc3RyaWJ1dGlvbjogc3RyaW5nKSA9PiB1bmtub3duO1xuICB9ID0ge30sXG4pIHtcbiAgY29uc3QgcHJvamVjdHMgPSAoYXdhaXQgaW1wb3J0KFwic21vbC10b21sXCIpKS5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihyb290LCBcIndvcmtiZW5jaC9wcm9qZWN0cy50b21sXCIpLCBcInV0ZjhcIikpO1xuICBjb25zdCBmaWxlczogW3N0cmluZywgc3RyaW5nIHwgVWludDhBcnJheV1bXSA9IFtdO1xuICBjb25zdCBvdXRwdXRKU09OID0gKHBhdGg6IHN0cmluZywgdmFsdWU6IHVua25vd24pID0+IGZpbGVzLnB1c2goW3BhdGgsIGAke0pTT04uc3RyaW5naWZ5KHZhbHVlLCBudWxsLCAyKX1cXG5gXSk7XG4gIGxldCBib290c3RyYXA7XG4gIGNvbnN0IHJlZ2lzdHJ5ID0gbmV3IE1hcDxzdHJpbmcsIFByb21pc2U8TnBtTWV0YWRhdGE+PigpO1xuICBmb3IgKGNvbnN0IHBhdGggb2YgW1xuICAgIC4uLm5ldyBTZXQoXG4gICAgICByZWNvcmRzKHByb2plY3RzLmxhbmd1YWdlX3Jvb3QsIFwiTWlzc2luZyBsYW5ndWFnZSByb290c1wiKS5tYXAoKGVudHJ5KSA9PlxuICAgICAgICBzdHJpbmcoZW50cnkucGF0aCwgXCJNaXNzaW5nIGxhbmd1YWdlIHJvb3QgcGF0aFwiKSxcbiAgICAgICksXG4gICAgKSxcbiAgXSkge1xuICAgIGNvbnN0IGRpcmVjdG9yeSA9IGpvaW4ocm9vdCwgcGF0aCk7XG4gICAgY29uc3QgZXh0cmFzID0gW107XG4gICAgaWYgKGV4aXN0c1N5bmMoam9pbihkaXJlY3RvcnksIFwicG5wbS1sb2NrLnlhbWxcIikpKSB7XG4gICAgICBib290c3RyYXAgPz89IGF3YWl0IChhY3F1aXJlLmJvb3RzdHJhcCA/PyByZWZyZXNoTWFuYWdlZEJvb3RzdHJhcCkocm9vdCk7XG4gICAgICBvdXRwdXRKU09OKGpvaW4oZGlyZWN0b3J5LCBcIm1hbmFnZWQtYm9vdHN0cmFwLmpzb25cIiksIGJvb3RzdHJhcCk7XG4gICAgICBmaWxlcy5wdXNoKFtcbiAgICAgICAgam9pbihkaXJlY3RvcnksIFwibWFuYWdlZC1yZWdpc3RyeS5qc29uLmJyXCIpLFxuICAgICAgICBhd2FpdCAoYWNxdWlyZS5yZWdpc3RyeSA/PyByZWZyZXNoTnBtUmVnaXN0cnkpKGRpcmVjdG9yeSwgcmVnaXN0cnkpLFxuICAgICAgXSk7XG4gICAgfVxuICAgIGlmIChleGlzdHNTeW5jKGpvaW4oZGlyZWN0b3J5LCBcInV2LmxvY2tcIikpKVxuICAgICAgZXh0cmFzLnB1c2goYXdhaXQgKGFjcXVpcmUucHl0aG9uID8/IHJlZnJlc2hQeXRob25CdWlsZElucHV0cykoZGlyZWN0b3J5KSk7XG4gICAgaWYgKGV4aXN0c1N5bmMoam9pbihkaXJlY3RvcnksIFwiZ28uc3VtXCIpKSkge1xuICAgICAgbGV0IHJlc3VsdDtcbiAgICAgIGlmIChhY3F1aXJlLmdvKSByZXN1bHQgPSBhd2FpdCBhY3F1aXJlLmdvKGRpcmVjdG9yeSk7XG4gICAgICBlbHNlIHtcbiAgICAgICAgY29uc3QgZ29yb290ID0gZXhlY0ZpbGVTeW5jKFxuICAgICAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgICAgW1xuICAgICAgICAgICAgam9pbihyb290LCBcImJpbi93b3JrYmVuY2gubWpzXCIpLFxuICAgICAgICAgICAgXCJzaGVsbFwiLFxuICAgICAgICAgICAgXCItLXByb2ZpbGVcIixcbiAgICAgICAgICAgIFwibmF0aXZlXCIsXG4gICAgICAgICAgICBcIi0tcGF0aFwiLFxuICAgICAgICAgICAgcGF0aCxcbiAgICAgICAgICAgIFwiLS1cIixcbiAgICAgICAgICAgIFwiZ29cIixcbiAgICAgICAgICAgIFwiZW52XCIsXG4gICAgICAgICAgICBcIkdPUk9PVFwiLFxuICAgICAgICAgIF0sXG4gICAgICAgICAgeyBjd2Q6IHJvb3QsIGVuY29kaW5nOiBcInV0ZjhcIiB9LFxuICAgICAgICApXG4gICAgICAgICAgLnRyaW0oKVxuICAgICAgICAgIC5zcGxpdCgvXFxyP1xcbi8pXG4gICAgICAgICAgLmF0KC0xKTtcbiAgICAgICAgcmVzdWx0ID0gcmVmcmVzaEdvSW5wdXRzKGRpcmVjdG9yeSwgW1xuICAgICAgICAgIGpvaW4ocmVxdWlyZWQoZ29yb290LCBcIk1pc3NpbmcgR28gcm9vdFwiKSwgXCJiaW5cIiwgcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gXCJnby5leGVcIiA6IFwiZ29cIiksXG4gICAgICAgIF0pO1xuICAgICAgfVxuICAgICAgZXh0cmFzLnB1c2gocmVzdWx0KTtcbiAgICB9XG4gICAgaWYgKGV4aXN0c1N5bmMoam9pbihkaXJlY3RvcnksIFwiLmNvbXBvc2VyLXZlcnNpb25cIikpKVxuICAgICAgZXh0cmFzLnB1c2goYXdhaXQgKGFjcXVpcmUuY29tcG9zZXIgPz8gcmVmcmVzaENvbXBvc2VyQm9vdHN0cmFwKShkaXJlY3RvcnksIHJvb3QpKTtcbiAgICBpZiAoZXh0cmFzLmxlbmd0aCkge1xuICAgICAgY29uc3QgaGFzaGVzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0gT2JqZWN0LmNyZWF0ZShudWxsKSBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICAgICAgY29uc3QgaW5wdXRzID0gbmV3IE1hcDxzdHJpbmcsIE1hbmFnZWRTb3VyY2U+KCk7XG4gICAgICBmb3IgKGNvbnN0IGV4dHJhIG9mIGV4dHJhcykge1xuICAgICAgICBjb25zdCBkZWNsYXJhdGlvbiA9IG1hbmFnZWREZWNsYXJhdGlvbihleHRyYSk7XG4gICAgICAgIGZvciAoY29uc3QgW2ZpbGUsIGhhc2hdIG9mIE9iamVjdC5lbnRyaWVzKGRlY2xhcmF0aW9uLnNvdXJjZV9oYXNoZXMpKSB7XG4gICAgICAgICAgaWYgKGhhc2hlc1tmaWxlXSAhPT0gdW5kZWZpbmVkICYmIGhhc2hlc1tmaWxlXSAhPT0gaGFzaClcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29uZmxpY3Rpbmcgc3VwcGxlbWVudGFsIHNvdXJjZSBpZGVudGl0eTogJHtmaWxlfWApO1xuICAgICAgICAgIGhhc2hlc1tmaWxlXSA9IGhhc2g7XG4gICAgICAgIH1cbiAgICAgICAgZm9yIChjb25zdCBpbnB1dCBvZiBkZWNsYXJhdGlvbi5pbnB1dHMpIHtcbiAgICAgICAgICBjb25zdCBwcmV2aW91cyA9IGlucHV0cy5nZXQoaW5wdXQuZGVzdGluYXRpb24pO1xuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgIHByZXZpb3VzICYmXG4gICAgICAgICAgICAocHJldmlvdXMudXJsICE9PSBpbnB1dC51cmwgfHxcbiAgICAgICAgICAgICAgcHJldmlvdXMuaGFzaCAhPT0gaW5wdXQuaGFzaCB8fFxuICAgICAgICAgICAgICBKU09OLnN0cmluZ2lmeShbLi4uKHByZXZpb3VzLnBsYXRmb3JtcyA/PyBbXSldLnNvcnQoKSkgIT09XG4gICAgICAgICAgICAgICAgSlNPTi5zdHJpbmdpZnkoWy4uLihpbnB1dC5wbGF0Zm9ybXMgPz8gW10pXS5zb3J0KCkpKVxuICAgICAgICAgIClcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29uZmxpY3Rpbmcgc3VwcGxlbWVudGFsIGFydGlmYWN0OiAke2lucHV0LmRlc3RpbmF0aW9ufWApO1xuICAgICAgICAgIGlucHV0cy5zZXQoaW5wdXQuZGVzdGluYXRpb24sIGlucHV0KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgb3V0cHV0SlNPTihcbiAgICAgICAgam9pbihkaXJlY3RvcnksIFwibWFuYWdlZC1leHRyYS1pbnB1dHMuanNvblwiKSxcbiAgICAgICAgbWFuYWdlZERlY2xhcmF0aW9uKHsgc2NoZW1hX3ZlcnNpb246IDEsIHNvdXJjZV9oYXNoZXM6IGhhc2hlcywgaW5wdXRzOiBbLi4uaW5wdXRzLnZhbHVlcygpXSB9KSxcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIHJldHVybiBmaWxlcztcbn1cblxuaWYgKHByb2Nlc3MuYXJndlsxXSAmJiByZXNvbHZlKHByb2Nlc3MuYXJndlsxXSkgPT09IGltcG9ydC5tZXRhLmZpbGVuYW1lKVxuICByZXBsYWNlTWFuYWdlZEZpbGVzKGF3YWl0IGNvbGxlY3RNYW5hZ2VkUmVmcmVzaChyZXNvbHZlKGltcG9ydC5tZXRhLmRpcm5hbWUsIFwiLi5cIikpKTtcbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsVUFBVSxRQUFRLFNBQVMsUUFBUSxTQUFTLG9CQUFvQjtBQUN6RSxTQUE2QiwwQkFBMEI7QUFDdkQsU0FBUyxtQkFBbUI7QUFxQjVCLFNBQVMsMkJBQTJCO0FBQ3BDLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsWUFBWSxjQUFjLGNBQWMsYUFBYSxjQUFjO0FBQzVF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QUFDQSxtQkFBVyxTQUFTLFlBQVksUUFBUTtBQUN0QyxnQkFBTSxXQUFXLE9BQU8sSUFBSSxNQUFNLFdBQVc7QUFDN0MsY0FDRSxhQUNDLFNBQVMsUUFBUSxNQUFNLE9BQ3RCLFNBQVMsU0FBUyxNQUFNLFFBQ3hCLEtBQUssVUFBVSxDQUFDLEdBQUksU0FBUyxhQUFhLENBQUMsQ0FBRSxFQUFFLEtBQUssQ0FBQyxNQUNuRCxLQUFLLFVBQVUsQ0FBQyxHQUFJLE1BQU0sYUFBYSxDQUFDLENBQUUsRUFBRSxLQUFLLENBQUM7QUFFdEQsa0JBQU0sSUFBSSxNQUFNLHNDQUFzQyxNQUFNLFdBQVcsRUFBRTtBQUMzRSxpQkFBTyxJQUFJLE1BQU0sYUFBYSxLQUFLO0FBQUEsUUFDckM7QUFBQSxNQUNGO0FBQ0E7QUFBQSxRQUNFLEtBQUssV0FBVywyQkFBMkI7QUFBQSxRQUMzQyxtQkFBbUIsRUFBRSxnQkFBZ0IsR0FBRyxlQUFlLFFBQVEsUUFBUSxDQUFDLEdBQUcsT0FBTyxPQUFPLENBQUMsRUFBRSxDQUFDO0FBQUEsTUFDL0Y7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUNBLFNBQU87QUFDVDtBQUVBLElBQUksUUFBUSxLQUFLLENBQUMsS0FBSyxRQUFRLFFBQVEsS0FBSyxDQUFDLENBQUMsTUFBTSxZQUFZO0FBQzlELHNCQUFvQixNQUFNLHNCQUFzQixRQUFRLFlBQVksU0FBUyxJQUFJLENBQUMsQ0FBQzsiLCJuYW1lcyI6WyJlbnRyeSIsInBhdGgiXSwiZmlsZSI6InNjcmlwdHMvcmVmcmVzaC1tYW5hZ2VkLWlucHV0cy5tanMifQ==
