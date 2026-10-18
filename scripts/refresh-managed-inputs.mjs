// Generated from refresh-managed-inputs.mts; edit the TypeScript source.
import { required, record, records, string, strings, stringRecord } from "./values.mjs";
import { readNpmLock } from "./managed-check-inputs.mjs";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInJlZnJlc2gtbWFuYWdlZC1pbnB1dHMubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHJlcXVpcmVkLCByZWNvcmQsIHJlY29yZHMsIHN0cmluZywgc3RyaW5ncywgc3RyaW5nUmVjb3JkIH0gZnJvbSBcIi4vdmFsdWVzLm1qc1wiO1xuaW1wb3J0IHR5cGUgeyBNYW5hZ2VkU291cmNlIH0gZnJvbSBcIi4vbWFuYWdlZC1zb3VyY2UtY29udHJhY3QubWpzXCI7XG5pbXBvcnQgeyByZWFkTnBtTG9jayB9IGZyb20gXCIuL21hbmFnZWQtY2hlY2staW5wdXRzLm1qc1wiO1xuaW50ZXJmYWNlIE5wbU1hbmlmZXN0IHtcbiAgbmFtZT86IHN0cmluZztcbiAgdmVyc2lvbj86IHN0cmluZztcbiAgZGVwcmVjYXRlZD86IHVua25vd247XG4gIF9ucG1Vc2VyPzogdW5rbm93bjtcbiAgZGlzdD86IHtcbiAgICBpbnRlZ3JpdHk/OiBzdHJpbmc7XG4gICAgdGFyYmFsbD86IHN0cmluZztcbiAgICBhdHRlc3RhdGlvbnM/OiB7IHVybD86IHN0cmluZzsgcHJvdmVuYW5jZT86IHVua25vd24gfTtcbiAgICByZXZpc2lvbnM/OiB1bmtub3duO1xuICB9O1xufVxuaW50ZXJmYWNlIE5wbU1ldGFkYXRhIHtcbiAgbmFtZTogc3RyaW5nO1xuICB0aW1lOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICBtb2RpZmllZD86IHN0cmluZztcbiAgXCJkaXN0LXRhZ3NcIj86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gIHZlcnNpb25zOiBSZWNvcmQ8c3RyaW5nLCBOcG1NYW5pZmVzdD47XG59XG5pbXBvcnQgeyBtYW5hZ2VkRGVjbGFyYXRpb24gfSBmcm9tIFwiLi9tYW5hZ2VkLXNvdXJjZS1jb250cmFjdC5tanNcIjtcbmltcG9ydCB7IHJlcGxhY2VNYW5hZ2VkRmlsZXMgfSBmcm9tIFwiLi9tYW5hZ2VkLWZpbGVzLm1qc1wiO1xuaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jLCBjb3B5RmlsZVN5bmMsIG1rZHRlbXBTeW5jLCBybVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IGV4ZWNGaWxlU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBicm90bGlDb21wcmVzc1N5bmMsIGNvbnN0YW50cyB9IGZyb20gXCJub2RlOnpsaWJcIjtcbmltcG9ydCB7IHBucG1QYWNrYWdlcywgcG5wbUlkZW50aXR5IH0gZnJvbSBcIi4vcG5wbS1sb2NrLm1qc1wiO1xuaW1wb3J0IHR5cGUgeyBQYXRoT3JGaWxlRGVzY3JpcHRvciB9IGZyb20gXCJmc1wiO1xuXG5jb25zdCBqc29uID0gKHBhdGg6IFBhdGhPckZpbGVEZXNjcmlwdG9yKTogdW5rbm93biA9PiBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpO1xuXG5hc3luYyBmdW5jdGlvbiByZWdpc3RyeUpTT04odXJsOiBzdHJpbmcsIGxpbWl0ID0gMiAqIDEwMjQgKiogMikge1xuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKHVybCwgeyByZWRpcmVjdDogXCJlcnJvclwiLCBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoMzBfMDAwKSB9KTtcbiAgaWYgKCFyZXNwb25zZS5vaykgdGhyb3cgbmV3IEVycm9yKGAke3VybH06IEhUVFAgJHtTdHJpbmcocmVzcG9uc2Uuc3RhdHVzKX1gKTtcbiAgY29uc3QgY2h1bmtzID0gW107XG4gIGxldCBsZW5ndGggPSAwO1xuICBmb3IgYXdhaXQgKGNvbnN0IGJ5dGVzIG9mIHJlcXVpcmVkKHJlc3BvbnNlLmJvZHksIFwiTWlzc2luZyByZWdpc3RyeSByZXNwb25zZSBib2R5XCIpKSB7XG4gICAgbGVuZ3RoICs9IGJ5dGVzLmxlbmd0aDtcbiAgICBpZiAobGVuZ3RoID4gbGltaXQpIHRocm93IG5ldyBFcnJvcihgJHt1cmx9OiBtZXRhZGF0YSBleGNlZWRzIGl0cyBzaXplIGxpbWl0YCk7XG4gICAgY2h1bmtzLnB1c2goQnVmZmVyLmZyb20oYnl0ZXMpKTtcbiAgfVxuICBjb25zdCB2YWx1ZTogdW5rbm93biA9IEpTT04ucGFyc2UoQnVmZmVyLmNvbmNhdChjaHVua3MpLnRvU3RyaW5nKFwidXRmOFwiKSk7XG4gIHJldHVybiB2YWx1ZTtcbn1cblxuZnVuY3Rpb24gbnBtTWFuaWZlc3QodmFsdWU6IHVua25vd24pOiBOcG1NYW5pZmVzdCB7XG4gIGNvbnN0IGVudHJ5ID0gcmVjb3JkKHZhbHVlLCBcIkludmFsaWQgbnBtIG1hbmlmZXN0XCIpO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgW1wibmFtZVwiLCBcInZlcnNpb25cIl0pXG4gICAgaWYgKGVudHJ5W25hbWVdICE9PSB1bmRlZmluZWQpIHN0cmluZyhlbnRyeVtuYW1lXSwgXCJJbnZhbGlkIG5wbSBtYW5pZmVzdCBmaWVsZFwiKTtcbiAgaWYgKGVudHJ5LmRpc3QgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IGRpc3QgPSByZWNvcmQoZW50cnkuZGlzdCwgXCJJbnZhbGlkIG5wbSBkaXN0cmlidXRpb25cIik7XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIFtcImludGVncml0eVwiLCBcInRhcmJhbGxcIl0pXG4gICAgICBpZiAoZGlzdFtuYW1lXSAhPT0gdW5kZWZpbmVkKSBzdHJpbmcoZGlzdFtuYW1lXSwgXCJJbnZhbGlkIG5wbSBkaXN0cmlidXRpb24gZmllbGRcIik7XG4gICAgaWYgKGRpc3QuYXR0ZXN0YXRpb25zICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IGF0dGVzdGF0aW9ucyA9IHJlY29yZChkaXN0LmF0dGVzdGF0aW9ucywgXCJJbnZhbGlkIG5wbSBhdHRlc3RhdGlvbnNcIik7XG4gICAgICBpZiAoYXR0ZXN0YXRpb25zLnVybCAhPT0gdW5kZWZpbmVkKSBzdHJpbmcoYXR0ZXN0YXRpb25zLnVybCwgXCJJbnZhbGlkIG5wbSBhdHRlc3RhdGlvbiBVUkxcIik7XG4gICAgfVxuICB9XG4gIC8vIE9wdGlvbmFsIGZpZWxkcyBhYm92ZSBhcmUgY2hlY2tlZDsgaGlzdG9yaWNhbCBtZXRhZGF0YSBub3QgdXNlZCBieSB0aGlzIGFkYXB0ZXIgcmVtYWlucyBpbnRhY3QuXG4gIHJldHVybiBlbnRyeTtcbn1cblxuZnVuY3Rpb24gbnBtTWV0YWRhdGEodmFsdWU6IHVua25vd24pOiBOcG1NZXRhZGF0YSB7XG4gIGNvbnN0IGVudHJ5ID0gcmVjb3JkKHZhbHVlLCBcIkludmFsaWQgbnBtIHJlZ2lzdHJ5IG1ldGFkYXRhXCIpO1xuICByZXR1cm4ge1xuICAgIG5hbWU6IHN0cmluZyhlbnRyeS5uYW1lLCBcIk1pc3NpbmcgcmVnaXN0cnkgcGFja2FnZSBuYW1lXCIpLFxuICAgIHRpbWU6IHN0cmluZ1JlY29yZChlbnRyeS50aW1lLCBcIkludmFsaWQgcHVibGljYXRpb24gdGltZXNcIiksXG4gICAgdmVyc2lvbnM6IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgIE9iamVjdC5lbnRyaWVzKHJlY29yZChlbnRyeS52ZXJzaW9ucywgXCJNaXNzaW5nIHBhY2thZ2UgdmVyc2lvbnNcIikpLm1hcCgoW3ZlcnNpb24sIG1hbmlmZXN0XSkgPT4gW1xuICAgICAgICB2ZXJzaW9uLFxuICAgICAgICBucG1NYW5pZmVzdChtYW5pZmVzdCksXG4gICAgICBdKSxcbiAgICApLFxuICAgIC4uLihlbnRyeS5tb2RpZmllZCA9PT0gdW5kZWZpbmVkID8ge30gOiB7IG1vZGlmaWVkOiBzdHJpbmcoZW50cnkubW9kaWZpZWQsIFwiSW52YWxpZCByZWdpc3RyeSBtb2RpZmljYXRpb24gdGltZVwiKSB9KSxcbiAgICAuLi4oZW50cnlbXCJkaXN0LXRhZ3NcIl0gPT09IHVuZGVmaW5lZFxuICAgICAgPyB7fVxuICAgICAgOiB7IFwiZGlzdC10YWdzXCI6IHN0cmluZ1JlY29yZChlbnRyeVtcImRpc3QtdGFnc1wiXSwgXCJJbnZhbGlkIG5wbSBkaXN0IHRhZ3NcIikgfSksXG4gIH07XG59XG5cbi8vIEZyb3plbiBpbnN0YWxscyByZWFkIGZ1bGwgbWFuaWZlc3RzIG9ubHkgZm9yIGxvY2tlZCB2ZXJzaW9ucy4gcG5wbSdzIHRydXN0LWhpc3Rvcnkgd2FsayByZWFkcyBwdWJsaWNhdGlvblxuLy8gdGltZXMsIGRpc3QuYXR0ZXN0YXRpb25zLCBhbmQgX25wbVVzZXIgKHRydXN0ZWRQdWJsaXNoZXIgYW5kIGFwcHJvdmVyKS4gS2VlcCBldmVyeSBoaXN0b3JpY2FsIHZlcnNpb24uXG4vLyBSZWZlcmVuY2U6IHBucG0gdjEyLjExLjIsIGNyYXRlcy9yZXNvbHZpbmctbnBtLXJlc29sdmVyL3NyYy97dHJ1c3RfY2hlY2tzLGNyZWF0ZV9ucG1fcmVzb2x1dGlvbl92ZXJpZmllci9tZXRhZGF0YV9wcm9qZWN0aW9ufS5ycy5cbmV4cG9ydCBmdW5jdGlvbiBucG1SZWdpc3RyeVNuYXBzaG90KGRpcmVjdG9yeTogc3RyaW5nLCBtZXRhZGF0YTogUmVjb3JkPHN0cmluZywgTnBtTWV0YWRhdGE+KSB7XG4gIGNvbnN0IGRvY3VtZW50ID0geyBwYWNrYWdlczogcG5wbVBhY2thZ2VzKHJlYWRGaWxlU3luYyhqb2luKGRpcmVjdG9yeSwgXCJwbnBtLWxvY2sueWFtbFwiKSwgXCJ1dGY4XCIpKSB9O1xuICBjb25zdCBsb2NrZWQgPSBuZXcgTWFwPHN0cmluZywgTWFwPHN0cmluZywgc3RyaW5nIHwgdW5kZWZpbmVkPj4oKTtcbiAgZm9yIChjb25zdCBba2V5LCBlbnRyeV0gb2YgT2JqZWN0LmVudHJpZXMocmVhZE5wbUxvY2soZG9jdW1lbnQpLnBhY2thZ2VzID8/IHt9KSkge1xuICAgIGNvbnN0IHsgbmFtZSwgdmVyc2lvbiB9ID0gcG5wbUlkZW50aXR5KGtleSk7XG4gICAgY29uc3QgdmVyc2lvbnMgPSBsb2NrZWQuZ2V0KG5hbWUpID8/IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmcgfCB1bmRlZmluZWQ+KCk7XG4gICAgdmVyc2lvbnMuc2V0KHZlcnNpb24sIGVudHJ5LnJlc29sdXRpb24/LmludGVncml0eSk7XG4gICAgbG9ja2VkLnNldChuYW1lLCB2ZXJzaW9ucyk7XG4gIH1cbiAgY29uc3QgcGFja2FnZXM6IFJlY29yZDxzdHJpbmcsIE5wbU1ldGFkYXRhPiA9IHt9O1xuICBmb3IgKGNvbnN0IFtuYW1lLCBsb2NrZWRWZXJzaW9uc10gb2YgWy4uLmxvY2tlZF0uc29ydCgoW2xlZnRdLCBbcmlnaHRdKSA9PiBsZWZ0LmxvY2FsZUNvbXBhcmUocmlnaHQpKSkge1xuICAgIGNvbnN0IHZhbHVlID0gbWV0YWRhdGFbbmFtZV07XG4gICAgaWYgKHZhbHVlPy5uYW1lICE9PSBuYW1lIHx8ICFPYmplY3QuaGFzT3duKHZhbHVlLCBcInZlcnNpb25zXCIpIHx8ICFPYmplY3QuaGFzT3duKHZhbHVlLCBcInRpbWVcIikpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEluY29tcGxldGUgcmVnaXN0cnkgbWV0YWRhdGE6ICR7bmFtZX1gKTtcbiAgICBmb3IgKGNvbnN0IFt2ZXJzaW9uLCBpbnRlZ3JpdHldIG9mIGxvY2tlZFZlcnNpb25zKSB7XG4gICAgICBpZiAodmFsdWUudmVyc2lvbnNbdmVyc2lvbl0/LmRpc3Q/LmludGVncml0eSAhPT0gaW50ZWdyaXR5KVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFJlZ2lzdHJ5IG1ldGFkYXRhIGRvZXMgbm90IG1hdGNoIGxvY2tlZCBpbnRlZ3JpdHk6ICR7bmFtZX1AJHt2ZXJzaW9ufWApO1xuICAgIH1cbiAgICBwYWNrYWdlc1tuYW1lXSA9IHtcbiAgICAgIG5hbWUsXG4gICAgICB0aW1lOiB2YWx1ZS50aW1lLFxuICAgICAgLi4uKHZhbHVlLm1vZGlmaWVkID09PSB1bmRlZmluZWQgPyB7fSA6IHsgbW9kaWZpZWQ6IHZhbHVlLm1vZGlmaWVkIH0pLFxuICAgICAgLi4uKHZhbHVlW1wiZGlzdC10YWdzXCJdID09PSB1bmRlZmluZWQgPyB7fSA6IHsgXCJkaXN0LXRhZ3NcIjogdmFsdWVbXCJkaXN0LXRhZ3NcIl0gfSksXG4gICAgICB2ZXJzaW9uczogT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgICBPYmplY3QuZW50cmllcyh2YWx1ZS52ZXJzaW9ucykubWFwKChbdmVyc2lvbiwgbWFuaWZlc3RdKSA9PiBbXG4gICAgICAgICAgdmVyc2lvbixcbiAgICAgICAgICBsb2NrZWRWZXJzaW9ucy5oYXModmVyc2lvbilcbiAgICAgICAgICAgID8gbWFuaWZlc3RcbiAgICAgICAgICAgIDoge1xuICAgICAgICAgICAgICAgIG5hbWUsXG4gICAgICAgICAgICAgICAgdmVyc2lvbixcbiAgICAgICAgICAgICAgICBkZXByZWNhdGVkOiBtYW5pZmVzdC5kZXByZWNhdGVkLFxuICAgICAgICAgICAgICAgIF9ucG1Vc2VyOiBtYW5pZmVzdC5fbnBtVXNlcixcbiAgICAgICAgICAgICAgICBkaXN0OiB7XG4gICAgICAgICAgICAgICAgICAuLi4obWFuaWZlc3QuZGlzdD8udGFyYmFsbCA9PT0gdW5kZWZpbmVkID8ge30gOiB7IHRhcmJhbGw6IG1hbmlmZXN0LmRpc3QudGFyYmFsbCB9KSxcbiAgICAgICAgICAgICAgICAgIC4uLihtYW5pZmVzdC5kaXN0Py5hdHRlc3RhdGlvbnMgPT09IHVuZGVmaW5lZCA/IHt9IDogeyBhdHRlc3RhdGlvbnM6IG1hbmlmZXN0LmRpc3QuYXR0ZXN0YXRpb25zIH0pLFxuICAgICAgICAgICAgICAgICAgcmV2aXNpb25zOiBtYW5pZmVzdC5kaXN0Py5yZXZpc2lvbnMsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgXSksXG4gICAgICApLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIGJyb3RsaUNvbXByZXNzU3luYyhCdWZmZXIuZnJvbShKU09OLnN0cmluZ2lmeShwYWNrYWdlcykpLCB7XG4gICAgcGFyYW1zOiB7IFtjb25zdGFudHMuQlJPVExJX1BBUkFNX1FVQUxJVFldOiA5IH0sXG4gIH0pO1xufVxuXG4vKiogUmV0YWluIHB1YmxpY2F0aW9uIGhpc3RvcnkgYW5kIHRydXN0IGV2aWRlbmNlIHdpdGhvdXQgdW5yZWxhdGVkIGhpc3RvcmljYWwgbWFuaWZlc3RzIGFuZCBzaWduYXR1cmVzLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlZnJlc2hOcG1SZWdpc3RyeShkaXJlY3Rvcnk6IHN0cmluZywgY2FjaGUgPSBuZXcgTWFwPHN0cmluZywgUHJvbWlzZTxOcG1NZXRhZGF0YT4+KCkpIHtcbiAgY29uc3QgbmFtZXMgPSBbXG4gICAgLi4ubmV3IFNldChcbiAgICAgIE9iamVjdC5rZXlzKHBucG1QYWNrYWdlcyhyZWFkRmlsZVN5bmMoam9pbihkaXJlY3RvcnksIFwicG5wbS1sb2NrLnlhbWxcIiksIFwidXRmOFwiKSkpLm1hcChcbiAgICAgICAgKGtleSkgPT4gcG5wbUlkZW50aXR5KGtleSkubmFtZSxcbiAgICAgICksXG4gICAgKSxcbiAgXS5zb3J0KCk7XG4gIGNvbnN0IG1ldGFkYXRhOiBSZWNvcmQ8c3RyaW5nLCBOcG1NZXRhZGF0YT4gPSB7fTtcbiAgZm9yIChsZXQgb2Zmc2V0ID0gMDsgb2Zmc2V0IDwgbmFtZXMubGVuZ3RoOyBvZmZzZXQgKz0gOCkge1xuICAgIGF3YWl0IFByb21pc2UuYWxsKFxuICAgICAgbmFtZXMuc2xpY2Uob2Zmc2V0LCBvZmZzZXQgKyA4KS5tYXAoYXN5bmMgKG5hbWUpID0+IHtcbiAgICAgICAgaWYgKCFjYWNoZS5oYXMobmFtZSkpXG4gICAgICAgICAgY2FjaGUuc2V0KG5hbWUsIHJlZ2lzdHJ5SlNPTihgaHR0cHM6Ly9yZWdpc3RyeS5ucG1qcy5vcmcvJHtuYW1lfWAsIDY0ICogMTAyNCAqKiAyKS50aGVuKG5wbU1ldGFkYXRhKSk7XG4gICAgICAgIG1ldGFkYXRhW25hbWVdID0gYXdhaXQgcmVxdWlyZWQoY2FjaGUuZ2V0KG5hbWUpLCBgTWlzc2luZyByZWdpc3RyeSByZXF1ZXN0OiAke25hbWV9YCk7XG4gICAgICB9KSxcbiAgICApO1xuICB9XG4gIHJldHVybiBucG1SZWdpc3RyeVNuYXBzaG90KGRpcmVjdG9yeSwgbWV0YWRhdGEpO1xufVxuXG4vKiogUmVmcmVzaCBwcm9vZiBtYXRlcmlhbCBmb3IgdGhlIGFscmVhZHkgbG9ja2VkIG1hbmFnZXI7IHRoaXMgbmV2ZXIgcmVzb2x2ZXMgYSBuZXcgdmVyc2lvbi4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWZyZXNoTWFuYWdlZEJvb3RzdHJhcChkaXN0cmlidXRpb246IHN0cmluZykge1xuICBjb25zdCBzb3VyY2UgPSBqb2luKGRpc3RyaWJ1dGlvbiwgXCJzY3JpcHRzL3BhY2thZ2UtbWFuYWdlclwiKTtcbiAgY29uc3QgcGFja2FnZUpTT04gPSBqc29uKGpvaW4oc291cmNlLCBcInBhY2thZ2UuanNvblwiKSk7XG4gIGNvbnN0IGxvY2sgPSByZWNvcmQoanNvbihqb2luKHNvdXJjZSwgXCJwYWNrYWdlLWxvY2suanNvblwiKSksIFwiSW52YWxpZCBib290c3RyYXAgbG9ja1wiKTtcbiAgY29uc3QgcHJvb2ZzID0gW107XG4gIGNvbnN0IHsgdmVyaWZ5QXR0ZXN0YXRpb24gfSA9IChhd2FpdCBpbXBvcnQoXG4gICAgcGF0aFRvRmlsZVVSTChqb2luKGRpc3RyaWJ1dGlvbiwgXCJzcmMvYXR0ZXN0YXRpb24tdmVyaWZpY2F0aW9uLnRzXCIpKS5ocmVmXG4gICkpIGFzIHR5cGVvZiBpbXBvcnQoXCIuLi9zcmMvYXR0ZXN0YXRpb24tdmVyaWZpY2F0aW9uLmpzXCIpO1xuICBjb25zdCByb290cyA9IHJlYWRGaWxlU3luYyhqb2luKGRpc3RyaWJ1dGlvbiwgXCJzY3JpcHRzL2tleXMvc2lnc3RvcmUtdHJ1c3RlZC1yb290Lmpzb25sXCIpLCBcInV0ZjhcIik7XG4gIGZvciAoY29uc3QgW3BhdGgsIHJhd10gb2YgT2JqZWN0LmVudHJpZXMocmVjb3JkKGxvY2sucGFja2FnZXMsIFwiTWlzc2luZyBib290c3RyYXAgcGFja2FnZXNcIikpKSB7XG4gICAgaWYgKCFwYXRoKSBjb250aW51ZTtcbiAgICBjb25zdCBlbnRyeSA9IHJlY29yZChyYXcsIFwiSW52YWxpZCBib290c3RyYXAgcGFja2FnZVwiKTtcbiAgICBpZiAoXG4gICAgICAoZW50cnkub3MgIT09IHVuZGVmaW5lZCAmJiAhc3RyaW5ncyhlbnRyeS5vcywgXCJJbnZhbGlkIGJvb3RzdHJhcCBPUyBsaXN0XCIpLmluY2x1ZGVzKFwibGludXhcIikpIHx8XG4gICAgICAoZW50cnkuY3B1ICE9PSB1bmRlZmluZWQgJiZcbiAgICAgICAgIXN0cmluZ3MoZW50cnkuY3B1LCBcIkludmFsaWQgYm9vdHN0cmFwIENQVSBsaXN0XCIpLnNvbWUoKGFyY2gpID0+IFtcIng2NFwiLCBcImFybTY0XCJdLmluY2x1ZGVzKGFyY2gpKSkgfHxcbiAgICAgIChlbnRyeS5saWJjICE9PSB1bmRlZmluZWQgJiYgIXN0cmluZ3MoZW50cnkubGliYywgXCJJbnZhbGlkIGJvb3RzdHJhcCBsaWJjIGxpc3RcIikuaW5jbHVkZXMoXCJnbGliY1wiKSlcbiAgICApXG4gICAgICBjb250aW51ZTtcbiAgICBjb25zdCBuYW1lID0gcGF0aC5yZXBsYWNlKC9ebm9kZV9tb2R1bGVzXFwvLywgXCJcIik7XG4gICAgY29uc3QgdmVyc2lvbiA9IHN0cmluZyhlbnRyeS52ZXJzaW9uLCBcIk1pc3NpbmcgYm9vdHN0cmFwIHZlcnNpb25cIiksXG4gICAgICBpbnRlZ3JpdHkgPSBzdHJpbmcoZW50cnkuaW50ZWdyaXR5LCBcIk1pc3NpbmcgYm9vdHN0cmFwIGludGVncml0eVwiKSxcbiAgICAgIHJlc29sdmVkID0gc3RyaW5nKGVudHJ5LnJlc29sdmVkLCBcIk1pc3NpbmcgYm9vdHN0cmFwIFVSTFwiKTtcbiAgICBjb25zdCBtZXRhZGF0YSA9IG5wbU1hbmlmZXN0KGF3YWl0IHJlZ2lzdHJ5SlNPTihgaHR0cHM6Ly9yZWdpc3RyeS5ucG1qcy5vcmcvJHtuYW1lfS8ke3ZlcnNpb259YCkpO1xuICAgIGlmIChtZXRhZGF0YS5kaXN0Py5pbnRlZ3JpdHkgIT09IGludGVncml0eSB8fCBtZXRhZGF0YS5kaXN0LnRhcmJhbGwgIT09IHJlc29sdmVkKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWdpc3RyeSBtZXRhZGF0YSBkb2VzIG5vdCBtYXRjaCB0aGUgbG9ja2VkIGJvb3RzdHJhcDogJHtuYW1lfWApO1xuICAgIGNvbnN0IGVuZHBvaW50ID0gbmV3IFVSTChyZXF1aXJlZChtZXRhZGF0YS5kaXN0LmF0dGVzdGF0aW9ucz8udXJsLCBcIk1pc3NpbmcgcmVnaXN0cnkgYXR0ZXN0YXRpb24gVVJMXCIpKTtcbiAgICBpZiAoZW5kcG9pbnQub3JpZ2luICE9PSBcImh0dHBzOi8vcmVnaXN0cnkubnBtanMub3JnXCIgfHwgIWVuZHBvaW50LnBhdGhuYW1lLnN0YXJ0c1dpdGgoXCIvLS9ucG0vdjEvYXR0ZXN0YXRpb25zL1wiKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgTWlzc2luZyBleHBlY3RlZCBib290c3RyYXAgcHJvdmVuYW5jZTogJHtuYW1lfWApO1xuICAgIGNvbnN0IGF0dGVzdGF0aW9ucyA9IHJlY29yZChhd2FpdCByZWdpc3RyeUpTT04oZW5kcG9pbnQuaHJlZiksIFwiSW52YWxpZCByZWdpc3RyeSBhdHRlc3RhdGlvbnNcIik7XG4gICAgY29uc3QgcHJvdmVuYW5jZSA9IHJlY29yZHMoYXR0ZXN0YXRpb25zLmF0dGVzdGF0aW9ucywgXCJNaXNzaW5nIGF0dGVzdGF0aW9uIHJlY29yZHNcIikuZmluZChcbiAgICAgIChlbnRyeSkgPT4gZW50cnkucHJlZGljYXRlVHlwZSA9PT0gXCJodHRwczovL3Nsc2EuZGV2L3Byb3ZlbmFuY2UvdjFcIixcbiAgICApO1xuICAgIGlmICghcHJvdmVuYW5jZT8uYnVuZGxlKSB0aHJvdyBuZXcgRXJyb3IoYE1pc3NpbmcgYm9vdHN0cmFwIFNMU0EgcHJvdmVuYW5jZTogJHtuYW1lfWApO1xuICAgIGNvbnN0IHNpZ25lciA9IGBodHRwczovL2dpdGh1Yi5jb20vcG5wbS9wbnBtLy5naXRodWIvd29ya2Zsb3dzL3JlbGVhc2UueW1sQHJlZnMvdGFncy92JHt2ZXJzaW9ufWA7XG4gICAgY29uc3Qgc3ViamVjdCA9IGBwa2c6bnBtLyR7bmFtZS5yZXBsYWNlKFwiQFwiLCBcIiU0MFwiKX1AJHt2ZXJzaW9ufWA7XG4gICAgY29uc3QgcHJvb2YgPSB7XG4gICAgICBuYW1lLFxuICAgICAgdmVyc2lvbixcbiAgICAgIGludGVncml0eSxcbiAgICAgIHNpZ25lcixcbiAgICAgIHN1YmplY3QsXG4gICAgICBidW5kbGU6IHByb3ZlbmFuY2UuYnVuZGxlLFxuICAgIH07XG4gICAgdmVyaWZ5QXR0ZXN0YXRpb24oXG4gICAgICBKU09OLnN0cmluZ2lmeShwcm9vZi5idW5kbGUpLFxuICAgICAgQnVmZmVyLmZyb20oaW50ZWdyaXR5LnNsaWNlKDcpLCBcImJhc2U2NFwiKS50b1N0cmluZyhcImhleFwiKSxcbiAgICAgIHtcbiAgICAgICAgc2lnbmVyLFxuICAgICAgICBzdWJqZWN0LFxuICAgICAgICByb290cyxcbiAgICAgIH0sXG4gICAgICBcInNoYTUxMlwiLFxuICAgICk7XG4gICAgcHJvb2ZzLnB1c2gocHJvb2YpO1xuICB9XG4gIHJldHVybiB7IHNjaGVtYV92ZXJzaW9uOiAxLCBwYWNrYWdlX2pzb246IHBhY2thZ2VKU09OLCBwYWNrYWdlX2xvY2s6IGxvY2ssIHByb29mcyB9O1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVmcmVzaFB5dGhvbkJ1aWxkSW5wdXRzKGRpcmVjdG9yeTogc3RyaW5nKSB7XG4gIGNvbnN0IHsgcGFyc2UgfSA9IGF3YWl0IGltcG9ydChcInNtb2wtdG9tbFwiKTtcbiAgY29uc3QgcHlwcm9qZWN0ID0gcGFyc2UocmVhZEZpbGVTeW5jKGpvaW4oZGlyZWN0b3J5LCBcInB5cHJvamVjdC50b21sXCIpLCBcInV0ZjhcIikpO1xuICBjb25zdCBpbnB1dHMgPSBbXTtcbiAgZm9yIChjb25zdCByZXF1aXJlbWVudCBvZiBzdHJpbmdzKFxuICAgIHJlY29yZChweXByb2plY3RbXCJidWlsZC1zeXN0ZW1cIl0sIFwiTWlzc2luZyBQeXRob24gYnVpbGQgc3lzdGVtXCIpLnJlcXVpcmVzLFxuICAgIFwiSW52YWxpZCBQeXRob24gYnVpbGQgcmVxdWlyZW1lbnRzXCIsXG4gICkpIHtcbiAgICBjb25zdCBwcmV2aW91cyA9IGlucHV0cy5sZW5ndGg7XG4gICAgY29uc3QgbWF0Y2ggPSAvXihbQS1aYS16MC05Ll8tXSspPT0oW0EtWmEtejAtOS4rXy1dKykkLy5leGVjKHJlcXVpcmVtZW50KTtcbiAgICBpZiAoIW1hdGNoKSB0aHJvdyBuZXcgRXJyb3IoYE1hbmFnZWQgYnVpbGQgcmVxdWlyZW1lbnRzIG5lZWQgZXhhY3QgcGluczogJHtyZXF1aXJlbWVudH1gKTtcbiAgICBjb25zdCBtZXRhZGF0YSA9IHJlY29yZChcbiAgICAgIGF3YWl0IHJlZ2lzdHJ5SlNPTihgaHR0cHM6Ly9weXBpLm9yZy9weXBpLyR7U3RyaW5nKG1hdGNoWzFdKX0vJHtTdHJpbmcobWF0Y2hbMl0pfS9qc29uYCksXG4gICAgICBcIkludmFsaWQgUHlQSSBtZXRhZGF0YVwiLFxuICAgICk7XG4gICAgZm9yIChjb25zdCByYXcgb2YgcmVjb3JkcyhtZXRhZGF0YS51cmxzLCBcIk1pc3NpbmcgUHlQSSBmaWxlc1wiKSkge1xuICAgICAgY29uc3QgZmlsZSA9IHtcbiAgICAgICAgZmlsZW5hbWU6IHN0cmluZyhyYXcuZmlsZW5hbWUsIFwiTWlzc2luZyBQeVBJIGZpbGVuYW1lXCIpLFxuICAgICAgICB1cmw6IHN0cmluZyhyYXcudXJsLCBcIk1pc3NpbmcgUHlQSSBVUkxcIiksXG4gICAgICAgIGRpZ2VzdHM6IHsgc2hhMjU2OiBzdHJpbmcocmVjb3JkKHJhdy5kaWdlc3RzLCBcIk1pc3NpbmcgUHlQSSBkaWdlc3RzXCIpLnNoYTI1NiwgXCJNaXNzaW5nIFB5UEkgU0hBLTI1NlwiKSB9LFxuICAgICAgfTtcbiAgICAgIGlmICghZmlsZS5maWxlbmFtZS5lbmRzV2l0aChcIi1hbnkud2hsXCIpKSBjb250aW51ZTtcbiAgICAgIGlmICghL15bYS1mMC05XXs2NH0kLy50ZXN0KGZpbGUuZGlnZXN0cy5zaGEyNTYpKSB0aHJvdyBuZXcgRXJyb3IoXCJQeVBJIGJ1aWxkIGlucHV0IGhhcyBubyBzdHJvbmcgaW50ZWdyaXR5XCIpO1xuICAgICAgaW5wdXRzLnB1c2goe1xuICAgICAgICB1cmw6IGZpbGUudXJsLFxuICAgICAgICBoYXNoOiBgc2hhMjU2LSR7QnVmZmVyLmZyb20oZmlsZS5kaWdlc3RzLnNoYTI1NiwgXCJoZXhcIikudG9TdHJpbmcoXCJiYXNlNjRcIil9YCxcbiAgICAgICAgZGVzdGluYXRpb246IGBweXRob24vJHtmaWxlLmZpbGVuYW1lfWAsXG4gICAgICB9KTtcbiAgICB9XG4gICAgaWYgKGlucHV0cy5sZW5ndGggPT09IHByZXZpb3VzKSB0aHJvdyBuZXcgRXJyb3IoYE5vIHBvcnRhYmxlIGRlY2xhcmVkIHdoZWVsIGZvciBidWlsZCByZXF1aXJlbWVudDogJHtyZXF1aXJlbWVudH1gKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIHNjaGVtYV92ZXJzaW9uOiAxLFxuICAgIHNvdXJjZV9oYXNoZXM6IHtcbiAgICAgIFwicHlwcm9qZWN0LnRvbWxcIjogY3JlYXRlSGFzaChcInNoYTI1NlwiKVxuICAgICAgICAudXBkYXRlKHJlYWRGaWxlU3luYyhqb2luKGRpcmVjdG9yeSwgXCJweXByb2plY3QudG9tbFwiKSkpXG4gICAgICAgIC5kaWdlc3QoXCJoZXhcIiksXG4gICAgfSxcbiAgICBpbnB1dHMsXG4gIH07XG59XG5cbi8qKiBHbyBhdXRoZW50aWNhdGVzIG1vZHVsZSBjb250ZW50IGFnYWluc3QgZ28uc3VtOyByZWNvcmQgdGhlIGNvcnJlc3BvbmRpbmcgaW1tdXRhYmxlIHByb3h5IGZpbGVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZnJlc2hHb0lucHV0cyhkaXJlY3Rvcnk6IHN0cmluZywgY29tbWFuZCA9IFtcImdvXCJdKSB7XG4gIGNvbnN0IHN0YWdlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJ3b3JrYmVuY2gtZ28taW5wdXRzLVwiKSk7XG4gIGNvbnN0IHN1bXMgPSBuZXcgTWFwKFxuICAgIHJlYWRGaWxlU3luYyhqb2luKGRpcmVjdG9yeSwgXCJnby5zdW1cIiksIFwidXRmOFwiKVxuICAgICAgLnRyaW0oKVxuICAgICAgLnNwbGl0KFwiXFxuXCIpXG4gICAgICAubWFwKChsaW5lKSA9PiB7XG4gICAgICAgIGNvbnN0IFtuYW1lLCB2ZXJzaW9uLCBoYXNoXSA9IGxpbmUuc3BsaXQoXCIgXCIpO1xuICAgICAgICByZXR1cm4gW2Ake1N0cmluZyhuYW1lKX1AJHtTdHJpbmcodmVyc2lvbil9YCwgaGFzaF07XG4gICAgICB9KSxcbiAgKTtcbiAgY29uc3QgZW52ID0geyAuLi5wcm9jZXNzLmVudiwgR09NT0RDQUNIRTogcHJvY2Vzcy5lbnYuR09NT0RDQUNIRSA/PyBqb2luKHN0YWdlLCBcIm1vZHVsZXNcIikgfTtcbiAgdHJ5IHtcbiAgICBmb3IgKGNvbnN0IGZpbGUgb2YgW1wiZ28ubW9kXCIsIFwiZ28uc3VtXCJdKSBjb3B5RmlsZVN5bmMoam9pbihkaXJlY3RvcnksIGZpbGUpLCBqb2luKHN0YWdlLCBmaWxlKSk7XG4gICAgY29uc3Qgb3V0cHV0ID0gZXhlY0ZpbGVTeW5jKFxuICAgICAgcmVxdWlyZWQoY29tbWFuZFswXSwgXCJNaXNzaW5nIEdvIGV4ZWN1dGFibGVcIiksXG4gICAgICBbLi4uY29tbWFuZC5zbGljZSgxKSwgXCJtb2RcIiwgXCJkb3dubG9hZFwiLCBcIi1qc29uXCIsIFwiYWxsXCJdLFxuICAgICAge1xuICAgICAgICBjd2Q6IHN0YWdlLFxuICAgICAgICBlbmNvZGluZzogXCJ1dGY4XCIsXG4gICAgICAgIGVudixcbiAgICAgIH0sXG4gICAgKTtcbiAgICBleGVjRmlsZVN5bmMocmVxdWlyZWQoY29tbWFuZFswXSwgXCJNaXNzaW5nIEdvIGV4ZWN1dGFibGVcIiksIFsuLi5jb21tYW5kLnNsaWNlKDEpLCBcIm1vZFwiLCBcInZlcmlmeVwiXSwge1xuICAgICAgY3dkOiBzdGFnZSxcbiAgICAgIHN0ZGlvOiBcImluaGVyaXRcIixcbiAgICAgIGVudixcbiAgICB9KTtcbiAgICBjb25zdCBpbnB1dHMgPSBbXTtcbiAgICBjb25zdCBkb2N1bWVudHMgPSBvdXRwdXRcbiAgICAgIC5zbGljZShvdXRwdXQuaW5kZXhPZihcIntcIikpXG4gICAgICAudHJpbSgpXG4gICAgICAuc3BsaXQoLyg/PD1cXH0pXFxzKig/PVxceykvKVxuICAgICAgLm1hcCgodmFsdWUpID0+IHJlY29yZChKU09OLnBhcnNlKHZhbHVlKSwgXCJJbnZhbGlkIEdvIGRvd25sb2FkIHJlY29yZFwiKSk7XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBkb2N1bWVudHMpIHtcbiAgICAgIGNvbnN0IHBhdGggPSBzdHJpbmcoZW50cnkuUGF0aCwgXCJNaXNzaW5nIEdvIG1vZHVsZSBwYXRoXCIpLFxuICAgICAgICB2ZXJzaW9uID0gc3RyaW5nKGVudHJ5LlZlcnNpb24sIFwiTWlzc2luZyBHbyBtb2R1bGUgdmVyc2lvblwiKTtcbiAgICAgIGlmIChlbnRyeS5FcnJvcikgdGhyb3cgbmV3IEVycm9yKGBHbyBjb3VsZCBub3QgYWNxdWlyZSBhIGxvY2tlZCBtb2R1bGU6ICR7cGF0aH1gKTtcbiAgICAgIGNvbnN0IHN1bSA9IHN1bXMuZ2V0KGAke3BhdGh9QCR7dmVyc2lvbn1gKSxcbiAgICAgICAgbW9kU3VtID0gc3Vtcy5nZXQoYCR7cGF0aH1AJHt2ZXJzaW9ufS9nby5tb2RgKTtcbiAgICAgIGlmICghc3VtICYmICFtb2RTdW0pIGNvbnRpbnVlO1xuICAgICAgaWYgKChzdW0gJiYgc3VtICE9PSBlbnRyeS5TdW0pIHx8IChtb2RTdW0gJiYgbW9kU3VtICE9PSBlbnRyeS5Hb01vZFN1bSkpXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgR28gZGlkIG5vdCB2ZXJpZnkgdGhlIGxvY2tlZCBtb2R1bGU6ICR7cGF0aH1gKTtcbiAgICAgIGZvciAoY29uc3QgYXJ0aWZhY3Qgb2YgWy4uLihzdW0gPyBbZW50cnkuWmlwXSA6IFtdKSwgZW50cnkuR29Nb2QsIGVudHJ5LkluZm9dKSB7XG4gICAgICAgIGNvbnN0IHBhdGggPSBzdHJpbmcoYXJ0aWZhY3QsIFwiTWlzc2luZyBHbyBhcnRpZmFjdCBwYXRoXCIpO1xuICAgICAgICBjb25zdCByZWxhdGl2ZSA9IHBhdGgucmVwbGFjZUFsbChcIlxcXFxcIiwgXCIvXCIpLnNwbGl0KFwiL2NhY2hlL2Rvd25sb2FkL1wiKVsxXTtcbiAgICAgICAgaWYgKCFyZWxhdGl2ZSkgdGhyb3cgbmV3IEVycm9yKFwiR28gcmV0dXJuZWQgYW4gdW5zdXBwb3J0ZWQgcHJveHkgYXJ0aWZhY3QgbG9jYXRpb25cIik7XG4gICAgICAgIGlucHV0cy5wdXNoKHtcbiAgICAgICAgICB1cmw6IGBodHRwczovL3Byb3h5LmdvbGFuZy5vcmcvJHtyZWxhdGl2ZX1gLFxuICAgICAgICAgIGhhc2g6IGBzaGEyNTYtJHtjcmVhdGVIYXNoKFwic2hhMjU2XCIpLnVwZGF0ZShyZWFkRmlsZVN5bmMocGF0aCkpLmRpZ2VzdChcImJhc2U2NFwiKX1gLFxuICAgICAgICAgIGRlc3RpbmF0aW9uOiBgZ28vJHtyZWxhdGl2ZX1gLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIHNjaGVtYV92ZXJzaW9uOiAxLFxuICAgICAgc291cmNlX2hhc2hlczogT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgICBbXCJnby5tb2RcIiwgXCJnby5zdW1cIl0ubWFwKChmaWxlKSA9PiBbXG4gICAgICAgICAgZmlsZSxcbiAgICAgICAgICBjcmVhdGVIYXNoKFwic2hhMjU2XCIpXG4gICAgICAgICAgICAudXBkYXRlKHJlYWRGaWxlU3luYyhqb2luKGRpcmVjdG9yeSwgZmlsZSkpKVxuICAgICAgICAgICAgLmRpZ2VzdChcImhleFwiKSxcbiAgICAgICAgXSksXG4gICAgICApLFxuICAgICAgaW5wdXRzLFxuICAgIH07XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKCFwcm9jZXNzLmVudi5HT01PRENBQ0hFKVxuICAgICAgZXhlY0ZpbGVTeW5jKHJlcXVpcmVkKGNvbW1hbmRbMF0sIFwiTWlzc2luZyBHbyBleGVjdXRhYmxlXCIpLCBbLi4uY29tbWFuZC5zbGljZSgxKSwgXCJjbGVhblwiLCBcIi1tb2RjYWNoZVwiXSwge1xuICAgICAgICBjd2Q6IHN0YWdlLFxuICAgICAgICBlbnYsXG4gICAgICAgIHN0ZGlvOiBcImluaGVyaXRcIixcbiAgICAgIH0pO1xuICAgIHJtU3luYyhzdGFnZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWZyZXNoQ29tcG9zZXJCb290c3RyYXAoZGlyZWN0b3J5OiBzdHJpbmcsIGRpc3RyaWJ1dGlvbjogc3RyaW5nKSB7XG4gIGNvbnN0IHZlcnNpb24gPSByZWFkRmlsZVN5bmMoam9pbihkaXJlY3RvcnksIFwiLmNvbXBvc2VyLXZlcnNpb25cIiksIFwidXRmOFwiKS50cmltKCk7XG4gIGNvbnN0IGludmVudG9yeSA9IHJlY29yZChqc29uKGpvaW4oZGlzdHJpYnV0aW9uLCBcInNjcmlwdHMvbmF0aXZlLWFzc2V0cy5qc29uXCIpKSwgXCJJbnZhbGlkIG5hdGl2ZSBhc3NldHNcIik7XG4gIGNvbnN0IHNlbGVjdGVkID0gcmVjb3JkKFxuICAgIHJlY29yZChyZWNvcmQoaW52ZW50b3J5LmNvbXBvc2VyLCBcIk1pc3NpbmcgQ29tcG9zZXIgaW52ZW50b3J5XCIpW3ZlcnNpb25dLCBcIk1pc3NpbmcgQ29tcG9zZXIgdmVyc2lvblwiKVtcImxpbnV4LXg2NFwiXSxcbiAgICBcIk1pc3NpbmcgQ29tcG9zZXIgYXNzZXRcIixcbiAgKTtcbiAgY29uc3QgYXNzZXQgPSB7XG4gICAgdXJsOiBzdHJpbmcoc2VsZWN0ZWQudXJsLCBcIkludmFsaWQgQ29tcG9zZXIgVVJMXCIpLFxuICAgIHNoYTI1Njogc3RyaW5nKHNlbGVjdGVkLnNoYTI1NiwgXCJJbnZhbGlkIENvbXBvc2VyIGRpZ2VzdFwiKSxcbiAgICBzaWduYXR1cmU6IHtcbiAgICAgIHVybDogc3RyaW5nKHJlY29yZChzZWxlY3RlZC5zaWduYXR1cmUsIFwiTWlzc2luZyBDb21wb3NlciBzaWduYXR1cmVcIikudXJsLCBcIk1pc3NpbmcgQ29tcG9zZXIgc2lnbmF0dXJlIFVSTFwiKSxcbiAgICB9LFxuICB9O1xuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGFzc2V0LnNpZ25hdHVyZS51cmwsIHsgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDMwXzAwMCkgfSk7XG4gIGlmICghcmVzcG9uc2Uub2spIHRocm93IG5ldyBFcnJvcihgQ29tcG9zZXIgc2lnbmF0dXJlOiBIVFRQICR7U3RyaW5nKHJlc3BvbnNlLnN0YXR1cyl9YCk7XG4gIGNvbnN0IHNpZ25hdHVyZSA9IEJ1ZmZlci5mcm9tKGF3YWl0IHJlc3BvbnNlLmFycmF5QnVmZmVyKCkpO1xuICBpZiAoc2lnbmF0dXJlLmxlbmd0aCA+IDY0ICogMTAyNCkgdGhyb3cgbmV3IEVycm9yKFwiQ29tcG9zZXIgc2lnbmF0dXJlIGV4Y2VlZHMgaXRzIHNpemUgbGltaXRcIik7XG4gIHJldHVybiB7XG4gICAgc2NoZW1hX3ZlcnNpb246IDEsXG4gICAgc291cmNlX2hhc2hlczoge1xuICAgICAgXCIuY29tcG9zZXItdmVyc2lvblwiOiBjcmVhdGVIYXNoKFwic2hhMjU2XCIpXG4gICAgICAgIC51cGRhdGUocmVhZEZpbGVTeW5jKGpvaW4oZGlyZWN0b3J5LCBcIi5jb21wb3Nlci12ZXJzaW9uXCIpKSlcbiAgICAgICAgLmRpZ2VzdChcImhleFwiKSxcbiAgICB9LFxuICAgIGlucHV0czogW1xuICAgICAge1xuICAgICAgICB1cmw6IGFzc2V0LnVybCxcbiAgICAgICAgaGFzaDogYHNoYTI1Ni0ke0J1ZmZlci5mcm9tKGFzc2V0LnNoYTI1NiwgXCJoZXhcIikudG9TdHJpbmcoXCJiYXNlNjRcIil9YCxcbiAgICAgICAgZGVzdGluYXRpb246IFwiYm9vdHN0cmFwL2NvbXBvc2VyLnBoYXJcIixcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIHVybDogYXNzZXQuc2lnbmF0dXJlLnVybCxcbiAgICAgICAgaGFzaDogYHNoYTI1Ni0ke2NyZWF0ZUhhc2goXCJzaGEyNTZcIikudXBkYXRlKHNpZ25hdHVyZSkuZGlnZXN0KFwiYmFzZTY0XCIpfWAsXG4gICAgICAgIGRlc3RpbmF0aW9uOiBcImJvb3RzdHJhcC9jb21wb3Nlci5waGFyLmFzY1wiLFxuICAgICAgfSxcbiAgICBdLFxuICB9O1xufVxuXG4vKiogQ29sbGVjdCBldmVyeSByZXF1ZXN0ZWQgb3V0cHV0IGJlZm9yZSB0aGUgQ0xJIHJlcGxhY2VzIGFueSBwcm9qZWN0IGZpbGUuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY29sbGVjdE1hbmFnZWRSZWZyZXNoKFxuICByb290OiBzdHJpbmcsXG4gIGFjcXVpcmU6IHtcbiAgICBib290c3RyYXA/OiAocm9vdDogc3RyaW5nKSA9PiBQcm9taXNlPHVua25vd24+O1xuICAgIHJlZ2lzdHJ5PzogdHlwZW9mIHJlZnJlc2hOcG1SZWdpc3RyeTtcbiAgICBweXRob24/OiAoZGlyZWN0b3J5OiBzdHJpbmcpID0+IHVua25vd247XG4gICAgZ28/OiAocm9vdDogc3RyaW5nKSA9PiB1bmtub3duO1xuICAgIGNvbXBvc2VyPzogKGRpcmVjdG9yeTogc3RyaW5nLCBkaXN0cmlidXRpb246IHN0cmluZykgPT4gdW5rbm93bjtcbiAgfSA9IHt9LFxuKSB7XG4gIGNvbnN0IHByb2plY3RzID0gKGF3YWl0IGltcG9ydChcInNtb2wtdG9tbFwiKSkucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgXCJ3b3JrYmVuY2gvcHJvamVjdHMudG9tbFwiKSwgXCJ1dGY4XCIpKTtcbiAgY29uc3QgZmlsZXM6IFtzdHJpbmcsIHN0cmluZyB8IFVpbnQ4QXJyYXldW10gPSBbXTtcbiAgY29uc3Qgb3V0cHV0SlNPTiA9IChwYXRoOiBzdHJpbmcsIHZhbHVlOiB1bmtub3duKSA9PiBmaWxlcy5wdXNoKFtwYXRoLCBgJHtKU09OLnN0cmluZ2lmeSh2YWx1ZSwgbnVsbCwgMil9XFxuYF0pO1xuICBsZXQgYm9vdHN0cmFwO1xuICBjb25zdCByZWdpc3RyeSA9IG5ldyBNYXA8c3RyaW5nLCBQcm9taXNlPE5wbU1ldGFkYXRhPj4oKTtcbiAgZm9yIChjb25zdCBwYXRoIG9mIFtcbiAgICAuLi5uZXcgU2V0KFxuICAgICAgcmVjb3Jkcyhwcm9qZWN0cy5sYW5ndWFnZV9yb290LCBcIk1pc3NpbmcgbGFuZ3VhZ2Ugcm9vdHNcIikubWFwKChlbnRyeSkgPT5cbiAgICAgICAgc3RyaW5nKGVudHJ5LnBhdGgsIFwiTWlzc2luZyBsYW5ndWFnZSByb290IHBhdGhcIiksXG4gICAgICApLFxuICAgICksXG4gIF0pIHtcbiAgICBjb25zdCBkaXJlY3RvcnkgPSBqb2luKHJvb3QsIHBhdGgpO1xuICAgIGNvbnN0IGV4dHJhcyA9IFtdO1xuICAgIGlmIChleGlzdHNTeW5jKGpvaW4oZGlyZWN0b3J5LCBcInBucG0tbG9jay55YW1sXCIpKSkge1xuICAgICAgYm9vdHN0cmFwID8/PSBhd2FpdCAoYWNxdWlyZS5ib290c3RyYXAgPz8gcmVmcmVzaE1hbmFnZWRCb290c3RyYXApKHJvb3QpO1xuICAgICAgb3V0cHV0SlNPTihqb2luKGRpcmVjdG9yeSwgXCJtYW5hZ2VkLWJvb3RzdHJhcC5qc29uXCIpLCBib290c3RyYXApO1xuICAgICAgZmlsZXMucHVzaChbXG4gICAgICAgIGpvaW4oZGlyZWN0b3J5LCBcIm1hbmFnZWQtcmVnaXN0cnkuanNvbi5iclwiKSxcbiAgICAgICAgYXdhaXQgKGFjcXVpcmUucmVnaXN0cnkgPz8gcmVmcmVzaE5wbVJlZ2lzdHJ5KShkaXJlY3RvcnksIHJlZ2lzdHJ5KSxcbiAgICAgIF0pO1xuICAgIH1cbiAgICBpZiAoZXhpc3RzU3luYyhqb2luKGRpcmVjdG9yeSwgXCJ1di5sb2NrXCIpKSlcbiAgICAgIGV4dHJhcy5wdXNoKGF3YWl0IChhY3F1aXJlLnB5dGhvbiA/PyByZWZyZXNoUHl0aG9uQnVpbGRJbnB1dHMpKGRpcmVjdG9yeSkpO1xuICAgIGlmIChleGlzdHNTeW5jKGpvaW4oZGlyZWN0b3J5LCBcImdvLnN1bVwiKSkpIHtcbiAgICAgIGxldCByZXN1bHQ7XG4gICAgICBpZiAoYWNxdWlyZS5nbykgcmVzdWx0ID0gYXdhaXQgYWNxdWlyZS5nbyhkaXJlY3RvcnkpO1xuICAgICAgZWxzZSB7XG4gICAgICAgIGNvbnN0IGdvcm9vdCA9IGV4ZWNGaWxlU3luYyhcbiAgICAgICAgICBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgICAgIFtcbiAgICAgICAgICAgIGpvaW4ocm9vdCwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSxcbiAgICAgICAgICAgIFwic2hlbGxcIixcbiAgICAgICAgICAgIFwiLS1wcm9maWxlXCIsXG4gICAgICAgICAgICBcIm5hdGl2ZVwiLFxuICAgICAgICAgICAgXCItLXBhdGhcIixcbiAgICAgICAgICAgIHBhdGgsXG4gICAgICAgICAgICBcIi0tXCIsXG4gICAgICAgICAgICBcImdvXCIsXG4gICAgICAgICAgICBcImVudlwiLFxuICAgICAgICAgICAgXCJHT1JPT1RcIixcbiAgICAgICAgICBdLFxuICAgICAgICAgIHsgY3dkOiByb290LCBlbmNvZGluZzogXCJ1dGY4XCIgfSxcbiAgICAgICAgKVxuICAgICAgICAgIC50cmltKClcbiAgICAgICAgICAuc3BsaXQoL1xccj9cXG4vKVxuICAgICAgICAgIC5hdCgtMSk7XG4gICAgICAgIHJlc3VsdCA9IHJlZnJlc2hHb0lucHV0cyhkaXJlY3RvcnksIFtcbiAgICAgICAgICBqb2luKHJlcXVpcmVkKGdvcm9vdCwgXCJNaXNzaW5nIEdvIHJvb3RcIiksIFwiYmluXCIsIHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiA/IFwiZ28uZXhlXCIgOiBcImdvXCIpLFxuICAgICAgICBdKTtcbiAgICAgIH1cbiAgICAgIGV4dHJhcy5wdXNoKHJlc3VsdCk7XG4gICAgfVxuICAgIGlmIChleGlzdHNTeW5jKGpvaW4oZGlyZWN0b3J5LCBcIi5jb21wb3Nlci12ZXJzaW9uXCIpKSlcbiAgICAgIGV4dHJhcy5wdXNoKGF3YWl0IChhY3F1aXJlLmNvbXBvc2VyID8/IHJlZnJlc2hDb21wb3NlckJvb3RzdHJhcCkoZGlyZWN0b3J5LCByb290KSk7XG4gICAgaWYgKGV4dHJhcy5sZW5ndGgpIHtcbiAgICAgIGNvbnN0IGhhc2hlczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IE9iamVjdC5jcmVhdGUobnVsbCkgYXMgUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgICAgIGNvbnN0IGlucHV0cyA9IG5ldyBNYXA8c3RyaW5nLCBNYW5hZ2VkU291cmNlPigpO1xuICAgICAgZm9yIChjb25zdCBleHRyYSBvZiBleHRyYXMpIHtcbiAgICAgICAgY29uc3QgZGVjbGFyYXRpb24gPSBtYW5hZ2VkRGVjbGFyYXRpb24oZXh0cmEpO1xuICAgICAgICBmb3IgKGNvbnN0IFtmaWxlLCBoYXNoXSBvZiBPYmplY3QuZW50cmllcyhkZWNsYXJhdGlvbi5zb3VyY2VfaGFzaGVzKSkge1xuICAgICAgICAgIGlmIChoYXNoZXNbZmlsZV0gIT09IHVuZGVmaW5lZCAmJiBoYXNoZXNbZmlsZV0gIT09IGhhc2gpXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbmZsaWN0aW5nIHN1cHBsZW1lbnRhbCBzb3VyY2UgaWRlbnRpdHk6ICR7ZmlsZX1gKTtcbiAgICAgICAgICBoYXNoZXNbZmlsZV0gPSBoYXNoO1xuICAgICAgICB9XG4gICAgICAgIGZvciAoY29uc3QgaW5wdXQgb2YgZGVjbGFyYXRpb24uaW5wdXRzKSB7XG4gICAgICAgICAgY29uc3QgcHJldmlvdXMgPSBpbnB1dHMuZ2V0KGlucHV0LmRlc3RpbmF0aW9uKTtcbiAgICAgICAgICBpZiAoXG4gICAgICAgICAgICBwcmV2aW91cyAmJlxuICAgICAgICAgICAgKHByZXZpb3VzLnVybCAhPT0gaW5wdXQudXJsIHx8XG4gICAgICAgICAgICAgIHByZXZpb3VzLmhhc2ggIT09IGlucHV0Lmhhc2ggfHxcbiAgICAgICAgICAgICAgSlNPTi5zdHJpbmdpZnkoWy4uLihwcmV2aW91cy5wbGF0Zm9ybXMgPz8gW10pXS5zb3J0KCkpICE9PVxuICAgICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KFsuLi4oaW5wdXQucGxhdGZvcm1zID8/IFtdKV0uc29ydCgpKSlcbiAgICAgICAgICApXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbmZsaWN0aW5nIHN1cHBsZW1lbnRhbCBhcnRpZmFjdDogJHtpbnB1dC5kZXN0aW5hdGlvbn1gKTtcbiAgICAgICAgICBpbnB1dHMuc2V0KGlucHV0LmRlc3RpbmF0aW9uLCBpbnB1dCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIG91dHB1dEpTT04oXG4gICAgICAgIGpvaW4oZGlyZWN0b3J5LCBcIm1hbmFnZWQtZXh0cmEtaW5wdXRzLmpzb25cIiksXG4gICAgICAgIG1hbmFnZWREZWNsYXJhdGlvbih7IHNjaGVtYV92ZXJzaW9uOiAxLCBzb3VyY2VfaGFzaGVzOiBoYXNoZXMsIGlucHV0czogWy4uLmlucHV0cy52YWx1ZXMoKV0gfSksXG4gICAgICApO1xuICAgIH1cbiAgfVxuICByZXR1cm4gZmlsZXM7XG59XG5cbmlmIChwcm9jZXNzLmFyZ3ZbMV0gJiYgcmVzb2x2ZShwcm9jZXNzLmFyZ3ZbMV0pID09PSBpbXBvcnQubWV0YS5maWxlbmFtZSlcbiAgcmVwbGFjZU1hbmFnZWRGaWxlcyhhd2FpdCBjb2xsZWN0TWFuYWdlZFJlZnJlc2gocmVzb2x2ZShpbXBvcnQubWV0YS5kaXJuYW1lLCBcIi4uXCIpKSk7XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLFVBQVUsUUFBUSxTQUFTLFFBQVEsU0FBUyxvQkFBb0I7QUFFekUsU0FBUyxtQkFBbUI7QUFvQjVCLFNBQVMsMEJBQTBCO0FBQ25DLFNBQVMsMkJBQTJCO0FBQ3BDLFNBQVMs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QUE2QyxJQUFJLEVBQUU7QUFDckUsaUJBQU8sSUFBSSxJQUFJO0FBQUEsUUFDakI7QUFDQSxtQkFBVyxTQUFTLFlBQVksUUFBUTtBQUN0QyxnQkFBTSxXQUFXLE9BQU8sSUFBSSxNQUFNLFdBQVc7QUFDN0MsY0FDRSxhQUNDLFNBQVMsUUFBUSxNQUFNLE9BQ3RCLFNBQVMsU0FBUyxNQUFNLFFBQ3hCLEtBQUssVUFBVSxDQUFDLEdBQUksU0FBUyxhQUFhLENBQUMsQ0FBRSxFQUFFLEtBQUssQ0FBQyxNQUNuRCxLQUFLLFVBQVUsQ0FBQyxHQUFJLE1BQU0sYUFBYSxDQUFDLENBQUUsRUFBRSxLQUFLLENBQUM7QUFFdEQsa0JBQU0sSUFBSSxNQUFNLHNDQUFzQyxNQUFNLFdBQVcsRUFBRTtBQUMzRSxpQkFBTyxJQUFJLE1BQU0sYUFBYSxLQUFLO0FBQUEsUUFDckM7QUFBQSxNQUNGO0FBQ0E7QUFBQSxRQUNFLEtBQUssV0FBVywyQkFBMkI7QUFBQSxRQUMzQyxtQkFBbUIsRUFBRSxnQkFBZ0IsR0FBRyxlQUFlLFFBQVEsUUFBUSxDQUFDLEdBQUcsT0FBTyxPQUFPLENBQUMsRUFBRSxDQUFDO0FBQUEsTUFDL0Y7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUNBLFNBQU87QUFDVDtBQUVBLElBQUksUUFBUSxLQUFLLENBQUMsS0FBSyxRQUFRLFFBQVEsS0FBSyxDQUFDLENBQUMsTUFBTSxZQUFZO0FBQzlELHNCQUFvQixNQUFNLHNCQUFzQixRQUFRLFlBQVksU0FBUyxJQUFJLENBQUMsQ0FBQzsiLCJuYW1lcyI6WyJlbnRyeSIsInBhdGgiXSwiZmlsZSI6InNjcmlwdHMvcmVmcmVzaC1tYW5hZ2VkLWlucHV0cy5tanMifQ==
