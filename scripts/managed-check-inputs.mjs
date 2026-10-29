// Generated from managed-check-inputs.mts; edit the TypeScript source.
import { required, record, records, string, strings, stringRecord } from "./values.mjs";
import { dependencyInputHash } from "./dependency-identity.mjs";
import { managedSource, managedDeclaration } from "./managed-source-contract.mjs";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseToml } from "./runtime-parsers.mjs";
import { pnpmPackages, pnpmIdentity } from "./pnpm-lock.mjs";
function packagePlatform(value) {
  return Object.fromEntries(
    ["os", "cpu", "libc"].flatMap(
      (key) => value[key] === void 0 ? [] : [[key, strings(value[key], "Invalid package platform")]]
    )
  );
}
function readNpmLock(value) {
  const document = record(value, "Invalid npm lock document");
  return {
    packages: Object.fromEntries(
      Object.entries(record(document.packages ?? {}, "Invalid npm lock packages")).map(([name, raw]) => {
        const entry = record(raw, "Invalid npm lock package");
        const resolution = entry.resolution === void 0 ? void 0 : record(entry.resolution, "Invalid package resolution");
        return [
          name,
          {
            ...packagePlatform(entry),
            ...resolution ? {
              resolution: {
                ...resolution.tarball === void 0 ? {} : { tarball: string(resolution.tarball, "Invalid package tarball") },
                ...resolution.integrity === void 0 ? {} : { integrity: string(resolution.integrity, "Invalid package integrity") }
              }
            } : {}
          }
        ];
      })
    )
  };
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sri = (hex) => `sha256-${Buffer.from(hex, "hex").toString("base64")}`;
const text = (root, name) => readFileSync(join(root, name), "utf8");
function artifact(url, hash, destination, platforms2) {
  return managedSource({ url, hash, destination, ...platforms2 ? { platforms: platforms2 } : {} });
}
function platforms(entry) {
  const accepts = (values, selected) => !values || !values.includes(`!${selected}`) && (!values.some((value) => !value.startsWith("!")) || values.includes(selected));
  return ["x64", "arm64"].filter((arch) => accepts(entry.os, "linux") && accepts(entry.cpu, arch) && accepts(entry.libc, "glibc")).map((arch) => `linux-${arch}`);
}
function npmCheckInputs(root) {
  const packages = readNpmLock({ packages: pnpmPackages(text(root, "pnpm-lock.yaml")) }).packages ?? {};
  return Object.entries(packages).flatMap(([key, entry]) => {
    const selected = platforms(entry);
    if (!selected.length) return [];
    const { name, version } = pnpmIdentity(key);
    if (!/^[A-Za-z0-9.+_-]+$/.test(version) || !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name))
      throw new Error(`Unsupported locked npm source: ${key}`);
    const url = entry.resolution?.tarball ?? `https://registry.npmjs.org/${name}/-/${String(name.split("/").at(-1))}-${version}.tgz`;
    return [artifact(url, entry.resolution?.integrity, `npm/${name.replaceAll("/", "-")}-${version}.tgz`, selected)];
  });
}
function mavenCheckInputs(root) {
  return text(root, ".mvn/checksums/checksums.sha256").trim().split("\n").map((line) => {
    const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9._+/-]+)$/.exec(line);
    if (!match) throw new Error("Invalid locked Maven checksum");
    return artifact(
      `https://maven-central.storage-download.googleapis.com/maven2/${String(match[2])}`,
      sri(required(match[1], "Missing Maven checksum")),
      `maven/${String(match[2])}`
    );
  });
}
function rubyCheckInputs(root) {
  const lock = text(root, "Gemfile.lock");
  const section = /(?:^|\n)CHECKSUMS\n([\s\S]*?)(?=\n[A-Z]|$)/.exec(lock)?.[1];
  if (!section) throw new Error("Managed gems require the lock's CHECKSUMS section");
  return [...section.matchAll(/^ {2}([A-Za-z0-9._-]+) \(([^)]+)\) sha256=([a-f0-9]{64})$/gm)].flatMap((match) => {
    const version = required(match[2], "Missing gem version"), platform = version.replace(/^[0-9]+(?:\.[0-9]+)*(?:\.pre\.[0-9]+)?/, "");
    const selected = !platform ? ["linux-x64", "linux-arm64"] : platform === "-x86_64-linux-gnu" ? ["linux-x64"] : platform === "-aarch64-linux-gnu" ? ["linux-arm64"] : [];
    if (!selected.length) return [];
    const name = `${String(match[1])}-${version}.gem`;
    return [
      artifact(
        `https://rubygems.org/downloads/${name}`,
        sri(required(match[3], "Missing gem checksum")),
        `gems/${name}`,
        selected
      )
    ];
  });
}
function cargoCheckInputs(root) {
  const lock = parseToml(text(root, "Cargo.lock"));
  return records(lock.package, "Invalid Cargo lock packages").filter((entry) => entry.source).map((entry) => {
    if (entry.source !== "registry+https://github.com/rust-lang/crates.io-index" || typeof entry.checksum !== "string" || !/^[a-f0-9]{64}$/.test(entry.checksum))
      throw new Error(`Unsupported locked Cargo source: ${String(entry.name)}`);
    const crate = string(entry.name, "Missing crate name"), version = string(entry.version, "Missing crate version");
    const name = `${crate}-${version}.crate`;
    return artifact(`https://static.crates.io/crates/${crate}/${name}`, sri(entry.checksum), `cargo/${name}`);
  });
}
function pythonCheckInputs(root) {
  const lock = parseToml(text(root, "uv.lock"));
  return records(lock.package, "Invalid Python lock packages").flatMap(
    (entry) => [
      ...entry.sdist === void 0 ? [] : [record(entry.sdist, "Invalid source distribution")],
      ...records(entry.wheels ?? [], "Invalid locked wheels")
    ].flatMap((value) => {
      const file = {
        url: string(value.url, "Invalid Python artifact URL"),
        hash: string(value.hash, "Invalid Python artifact hash")
      };
      const name = basename(new URL(file.url).pathname);
      const selected = !name.endsWith(".whl") || name.endsWith("-any.whl") ? ["linux-x64", "linux-arm64"] : ["x64", "arm64"].filter((arch) => new RegExp(`manylinux[^/]*${arch === "x64" ? "x86_64" : "aarch64"}`).test(name)).map((arch) => `linux-${arch}`);
      if (!selected.length) return [];
      if (!/^sha256:[a-f0-9]{64}$/.test(file.hash)) throw new Error(`Invalid locked Python integrity: ${name}`);
      return [artifact(file.url, sri(file.hash.slice(7)), `python/${name}`, selected)];
    })
  );
}
function composerCheckInputs(root) {
  return [".", "tools", "tools/compat"].flatMap((directory) => {
    const base = join(root, directory);
    if (!existsSync(join(base, "composer.lock"))) return [];
    const lock = record(JSON.parse(text(base, "composer.lock")), "Invalid Composer lock");
    const checksums = stringRecord(JSON.parse(text(base, ".composer/checksums.json")), "Invalid Composer checksums");
    return [
      ...records(lock.packages, "Invalid Composer packages"),
      ...records(lock["packages-dev"], "Invalid Composer dev packages")
    ].map((entry) => ({ entry, dist: record(entry.dist, "Missing Composer distribution") })).filter(({ dist }) => dist.type !== "path").map(({ entry, dist }) => ({
      name: string(entry.name, "Missing Composer package name"),
      version: string(entry.version, "Missing Composer package version"),
      dist
    })).map((entry) => {
      const reference = entry.dist.reference === void 0 || entry.dist.reference === null ? "" : string(entry.dist.reference, "Invalid distribution reference");
      const key = `${entry.name}@${entry.version}#${reference}`;
      const digest = checksums[key];
      if (!digest || !/^[a-f0-9]{64}$/.test(digest)) throw new Error(`Missing reviewed Composer integrity: ${key}`);
      return artifact(
        string(entry.dist.url, "Invalid Composer URL"),
        sri(digest),
        `composer/${directory === "." ? "application" : directory}/${entry.name}/${digest}.zip`
      );
    });
  });
}
function managedCheckInputs(root) {
  const inputs = [];
  const sourceHashes = {};
  for (const [file, generate, sources] of [
    [
      "pnpm-lock.yaml",
      npmCheckInputs,
      ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".pnpmfile.cjs", ".npmrc"]
    ],
    ["Cargo.lock", cargoCheckInputs, ["Cargo.toml", "Cargo.lock"]],
    ["uv.lock", pythonCheckInputs, ["pyproject.toml", "uv.lock"]],
    ["Gemfile.lock", rubyCheckInputs, ["Gemfile", "Gemfile.lock"]],
    [".mvn/checksums/checksums.sha256", mavenCheckInputs, ["pom.xml", ".mvn/checksums/checksums.sha256"]],
    [
      "composer.lock",
      composerCheckInputs,
      [
        "composer.json",
        "composer.lock",
        ".composer/checksums.json",
        "tools/composer.json",
        "tools/composer.lock",
        "tools/.composer/checksums.json",
        "tools/compat/composer.json",
        "tools/compat/composer.lock",
        "tools/compat/.composer/checksums.json"
      ]
    ]
  ]) {
    if (!existsSync(join(root, file))) continue;
    inputs.push(...generate(root));
    for (const source of sources)
      if (existsSync(join(root, source)))
        sourceHashes[source] = dependencyInputHash(source, readFileSync(join(root, source)));
  }
  const extraFile = join(root, "managed-extra-inputs.json");
  if (existsSync(extraFile)) {
    const extra = managedDeclaration(JSON.parse(readFileSync(extraFile, "utf8")));
    sourceHashes["managed-extra-inputs.json"] = sha256(readFileSync(extraFile));
    if (extra.schema_version !== 1) throw new Error("Unknown managed extra-input schema");
    for (const [file, expected] of Object.entries(extra.source_hashes)) {
      if (!file || file.startsWith("/") || file.includes("\\") || file.split("/").some((part) => !part || part === ".." || part === "."))
        throw new Error("Unsafe supplemental source path");
      if (dependencyInputHash(file, readFileSync(join(root, file))) !== expected)
        throw new Error(`${file}: refresh derived managed inputs`);
      sourceHashes[file] = expected;
    }
    inputs.push(...extra.inputs.map((entry) => artifact(entry.url, entry.hash, entry.destination, entry.platforms)));
  }
  const bootstrapFile = join(root, "managed-bootstrap.json");
  const registryFile = join(root, "managed-registry.json.br");
  const registry = existsSync(registryFile);
  if (registry) sourceHashes["managed-registry.json.br"] = sha256(readFileSync(registryFile));
  const bootstrap = existsSync(bootstrapFile) ? record(JSON.parse(readFileSync(bootstrapFile, "utf8")), "Invalid managed bootstrap") : void 0;
  if (bootstrap) {
    if (bootstrap.schema_version !== 1) throw new Error("Unknown managed bootstrap schema");
    sourceHashes["managed-bootstrap.json"] = sha256(readFileSync(bootstrapFile));
    for (const [path, entry] of Object.entries(
      record(record(bootstrap.package_lock, "Invalid bootstrap lock").packages, "Invalid bootstrap packages")
    )) {
      if (!path) continue;
      const value = record(entry, "Invalid bootstrap package");
      const selected = platforms(packagePlatform(value));
      if (selected.length)
        inputs.push(
          artifact(
            string(value.resolved, "Invalid bootstrap URL"),
            value.integrity,
            `bootstrap/${path.replaceAll("/", "-")}.tgz`,
            selected
          )
        );
    }
  }
  const destinations = /* @__PURE__ */ new Map();
  for (const entry of inputs) {
    const previous = destinations.get(entry.destination);
    if (previous && JSON.stringify(previous) !== JSON.stringify(entry))
      throw new Error(`Conflicting managed input: ${entry.destination}`);
    destinations.set(entry.destination, entry);
  }
  return managedDeclaration({
    schema_version: 1,
    source_hashes: Object.fromEntries(Object.entries(sourceHashes).sort()),
    ...bootstrap ? { bootstrap: true } : {},
    ...registry ? { registry: true } : {},
    inputs: [...destinations.values()].sort(
      (a, b) => a.destination < b.destination ? -1 : a.destination > b.destination ? 1 : 0
    )
  });
}
export {
  cargoCheckInputs,
  composerCheckInputs,
  managedCheckInputs,
  mavenCheckInputs,
  npmCheckInputs,
  pythonCheckInputs,
  readNpmLock,
  rubyCheckInputs
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1hbmFnZWQtY2hlY2staW5wdXRzLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyByZXF1aXJlZCwgcmVjb3JkLCByZWNvcmRzLCBzdHJpbmcsIHN0cmluZ3MsIHN0cmluZ1JlY29yZCB9IGZyb20gXCIuL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IGRlcGVuZGVuY3lJbnB1dEhhc2ggfSBmcm9tIFwiLi9kZXBlbmRlbmN5LWlkZW50aXR5Lm1qc1wiO1xuaW1wb3J0IHsgdHlwZSBNYW5hZ2VkU291cmNlLCBtYW5hZ2VkU291cmNlLCBtYW5hZ2VkRGVjbGFyYXRpb24gfSBmcm9tIFwiLi9tYW5hZ2VkLXNvdXJjZS1jb250cmFjdC5tanNcIjtcbmV4cG9ydCBpbnRlcmZhY2UgUGFja2FnZVBsYXRmb3JtIHtcbiAgb3M/OiBzdHJpbmdbXTtcbiAgY3B1Pzogc3RyaW5nW107XG4gIGxpYmM/OiBzdHJpbmdbXTtcbn1cbmV4cG9ydCBpbnRlcmZhY2UgTnBtTG9ja2VkUGFja2FnZSBleHRlbmRzIFBhY2thZ2VQbGF0Zm9ybSB7XG4gIHJlc29sdXRpb24/OiB7IHRhcmJhbGw/OiBzdHJpbmc7IGludGVncml0eT86IHN0cmluZyB9O1xufVxuZXhwb3J0IGludGVyZmFjZSBOcG1Mb2NrIHtcbiAgcGFja2FnZXM/OiBSZWNvcmQ8c3RyaW5nLCBOcG1Mb2NrZWRQYWNrYWdlPjtcbn1cbmV4cG9ydCBpbnRlcmZhY2UgQm9vdHN0cmFwUGFja2FnZSBleHRlbmRzIFBhY2thZ2VQbGF0Zm9ybSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgcmVzb2x2ZWQ6IHN0cmluZztcbiAgaW50ZWdyaXR5OiBzdHJpbmc7XG59XG5leHBvcnQgaW50ZXJmYWNlIE1hbmFnZWRCb290c3RyYXAge1xuICBzY2hlbWFfdmVyc2lvbjogbnVtYmVyO1xuICBwYWNrYWdlX2pzb246IHVua25vd247XG4gIHBhY2thZ2VfbG9jazogeyBwYWNrYWdlczogUmVjb3JkPHN0cmluZywgQm9vdHN0cmFwUGFja2FnZT4gfTtcbiAgcHJvb2ZzOiB1bmtub3duW107XG59XG5pbXBvcnQgdHlwZSB7IEJpbmFyeUxpa2UgfSBmcm9tIFwiY3J5cHRvXCI7XG5cbmltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHBhcnNlVG9tbCB9IGZyb20gXCIuL3J1bnRpbWUtcGFyc2Vycy5tanNcIjtcbmltcG9ydCB7IHBucG1QYWNrYWdlcywgcG5wbUlkZW50aXR5IH0gZnJvbSBcIi4vcG5wbS1sb2NrLm1qc1wiO1xuXG5mdW5jdGlvbiBwYWNrYWdlUGxhdGZvcm0odmFsdWU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUGFja2FnZVBsYXRmb3JtIHtcbiAgcmV0dXJuIE9iamVjdC5mcm9tRW50cmllcyhcbiAgICBbXCJvc1wiLCBcImNwdVwiLCBcImxpYmNcIl0uZmxhdE1hcCgoa2V5KSA9PlxuICAgICAgdmFsdWVba2V5XSA9PT0gdW5kZWZpbmVkID8gW10gOiBbW2tleSwgc3RyaW5ncyh2YWx1ZVtrZXldLCBcIkludmFsaWQgcGFja2FnZSBwbGF0Zm9ybVwiKV1dLFxuICAgICksXG4gICk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZWFkTnBtTG9jayh2YWx1ZTogdW5rbm93bik6IE5wbUxvY2sge1xuICBjb25zdCBkb2N1bWVudCA9IHJlY29yZCh2YWx1ZSwgXCJJbnZhbGlkIG5wbSBsb2NrIGRvY3VtZW50XCIpO1xuICByZXR1cm4ge1xuICAgIHBhY2thZ2VzOiBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgICBPYmplY3QuZW50cmllcyhyZWNvcmQoZG9jdW1lbnQucGFja2FnZXMgPz8ge30sIFwiSW52YWxpZCBucG0gbG9jayBwYWNrYWdlc1wiKSkubWFwKChbbmFtZSwgcmF3XSkgPT4ge1xuICAgICAgICBjb25zdCBlbnRyeSA9IHJlY29yZChyYXcsIFwiSW52YWxpZCBucG0gbG9jayBwYWNrYWdlXCIpO1xuICAgICAgICBjb25zdCByZXNvbHV0aW9uID1cbiAgICAgICAgICBlbnRyeS5yZXNvbHV0aW9uID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiByZWNvcmQoZW50cnkucmVzb2x1dGlvbiwgXCJJbnZhbGlkIHBhY2thZ2UgcmVzb2x1dGlvblwiKTtcbiAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICBuYW1lLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIC4uLnBhY2thZ2VQbGF0Zm9ybShlbnRyeSksXG4gICAgICAgICAgICAuLi4ocmVzb2x1dGlvblxuICAgICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICAgIHJlc29sdXRpb246IHtcbiAgICAgICAgICAgICAgICAgICAgLi4uKHJlc29sdXRpb24udGFyYmFsbCA9PT0gdW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgICAgICAgPyB7fVxuICAgICAgICAgICAgICAgICAgICAgIDogeyB0YXJiYWxsOiBzdHJpbmcocmVzb2x1dGlvbi50YXJiYWxsLCBcIkludmFsaWQgcGFja2FnZSB0YXJiYWxsXCIpIH0pLFxuICAgICAgICAgICAgICAgICAgICAuLi4ocmVzb2x1dGlvbi5pbnRlZ3JpdHkgPT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgICAgICAgICAgID8ge31cbiAgICAgICAgICAgICAgICAgICAgICA6IHsgaW50ZWdyaXR5OiBzdHJpbmcocmVzb2x1dGlvbi5pbnRlZ3JpdHksIFwiSW52YWxpZCBwYWNrYWdlIGludGVncml0eVwiKSB9KSxcbiAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICB9LFxuICAgICAgICBdO1xuICAgICAgfSksXG4gICAgKSxcbiAgfTtcbn1cblxuY29uc3Qgc2hhMjU2ID0gKGJ5dGVzOiBCaW5hcnlMaWtlKSA9PiBjcmVhdGVIYXNoKFwic2hhMjU2XCIpLnVwZGF0ZShieXRlcykuZGlnZXN0KFwiaGV4XCIpO1xuY29uc3Qgc3JpID0gKGhleDogc3RyaW5nKSA9PiBgc2hhMjU2LSR7QnVmZmVyLmZyb20oaGV4LCBcImhleFwiKS50b1N0cmluZyhcImJhc2U2NFwiKX1gO1xuY29uc3QgdGV4dCA9IChyb290OiBzdHJpbmcsIG5hbWU6IHN0cmluZykgPT4gcmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgbmFtZSksIFwidXRmOFwiKTtcblxuZnVuY3Rpb24gYXJ0aWZhY3QodXJsOiBzdHJpbmcsIGhhc2g6IHVua25vd24sIGRlc3RpbmF0aW9uOiBzdHJpbmcsIHBsYXRmb3Jtcz86IHN0cmluZ1tdKSB7XG4gIHJldHVybiBtYW5hZ2VkU291cmNlKHsgdXJsLCBoYXNoLCBkZXN0aW5hdGlvbiwgLi4uKHBsYXRmb3JtcyA/IHsgcGxhdGZvcm1zIH0gOiB7fSkgfSk7XG59XG5cbmZ1bmN0aW9uIHBsYXRmb3JtcyhlbnRyeTogUGFja2FnZVBsYXRmb3JtKSB7XG4gIGNvbnN0IGFjY2VwdHMgPSAodmFsdWVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCwgc2VsZWN0ZWQ6IHN0cmluZykgPT5cbiAgICAhdmFsdWVzIHx8XG4gICAgKCF2YWx1ZXMuaW5jbHVkZXMoYCEke3NlbGVjdGVkfWApICYmXG4gICAgICAoIXZhbHVlcy5zb21lKCh2YWx1ZTogc3RyaW5nKSA9PiAhdmFsdWUuc3RhcnRzV2l0aChcIiFcIikpIHx8IHZhbHVlcy5pbmNsdWRlcyhzZWxlY3RlZCkpKTtcbiAgcmV0dXJuIFtcIng2NFwiLCBcImFybTY0XCJdXG4gICAgLmZpbHRlcigoYXJjaCkgPT4gYWNjZXB0cyhlbnRyeS5vcywgXCJsaW51eFwiKSAmJiBhY2NlcHRzKGVudHJ5LmNwdSwgYXJjaCkgJiYgYWNjZXB0cyhlbnRyeS5saWJjLCBcImdsaWJjXCIpKVxuICAgIC5tYXAoKGFyY2gpID0+IGBsaW51eC0ke2FyY2h9YCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBucG1DaGVja0lucHV0cyhyb290OiBzdHJpbmcpIHtcbiAgY29uc3QgcGFja2FnZXMgPSByZWFkTnBtTG9jayh7IHBhY2thZ2VzOiBwbnBtUGFja2FnZXModGV4dChyb290LCBcInBucG0tbG9jay55YW1sXCIpKSB9KS5wYWNrYWdlcyA/PyB7fTtcbiAgcmV0dXJuIE9iamVjdC5lbnRyaWVzKHBhY2thZ2VzKS5mbGF0TWFwKChba2V5LCBlbnRyeV0pID0+IHtcbiAgICBjb25zdCBzZWxlY3RlZCA9IHBsYXRmb3JtcyhlbnRyeSk7XG4gICAgaWYgKCFzZWxlY3RlZC5sZW5ndGgpIHJldHVybiBbXTtcbiAgICBjb25zdCB7IG5hbWUsIHZlcnNpb24gfSA9IHBucG1JZGVudGl0eShrZXkpO1xuICAgIGlmICghL15bQS1aYS16MC05LitfLV0rJC8udGVzdCh2ZXJzaW9uKSB8fCAhL14oQFthLXowLTkuXy1dK1xcLyk/W2EtejAtOS5fLV0rJC8udGVzdChuYW1lKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgbG9ja2VkIG5wbSBzb3VyY2U6ICR7a2V5fWApO1xuICAgIGNvbnN0IHVybCA9XG4gICAgICBlbnRyeS5yZXNvbHV0aW9uPy50YXJiYWxsID8/XG4gICAgICBgaHR0cHM6Ly9yZWdpc3RyeS5ucG1qcy5vcmcvJHtuYW1lfS8tLyR7U3RyaW5nKG5hbWUuc3BsaXQoXCIvXCIpLmF0KC0xKSl9LSR7dmVyc2lvbn0udGd6YDtcbiAgICByZXR1cm4gW2FydGlmYWN0KHVybCwgZW50cnkucmVzb2x1dGlvbj8uaW50ZWdyaXR5LCBgbnBtLyR7bmFtZS5yZXBsYWNlQWxsKFwiL1wiLCBcIi1cIil9LSR7dmVyc2lvbn0udGd6YCwgc2VsZWN0ZWQpXTtcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXZlbkNoZWNrSW5wdXRzKHJvb3Q6IHN0cmluZykge1xuICByZXR1cm4gdGV4dChyb290LCBcIi5tdm4vY2hlY2tzdW1zL2NoZWNrc3Vtcy5zaGEyNTZcIilcbiAgICAudHJpbSgpXG4gICAgLnNwbGl0KFwiXFxuXCIpXG4gICAgLm1hcCgobGluZSkgPT4ge1xuICAgICAgY29uc3QgbWF0Y2ggPSAvXihbYS1mMC05XXs2NH0pIHsyfShbQS1aYS16MC05Ll8rLy1dKykkLy5leGVjKGxpbmUpO1xuICAgICAgaWYgKCFtYXRjaCkgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBsb2NrZWQgTWF2ZW4gY2hlY2tzdW1cIik7XG4gICAgICByZXR1cm4gYXJ0aWZhY3QoXG4gICAgICAgIGBodHRwczovL21hdmVuLWNlbnRyYWwuc3RvcmFnZS1kb3dubG9hZC5nb29nbGVhcGlzLmNvbS9tYXZlbjIvJHtTdHJpbmcobWF0Y2hbMl0pfWAsXG4gICAgICAgIHNyaShyZXF1aXJlZChtYXRjaFsxXSwgXCJNaXNzaW5nIE1hdmVuIGNoZWNrc3VtXCIpKSxcbiAgICAgICAgYG1hdmVuLyR7U3RyaW5nKG1hdGNoWzJdKX1gLFxuICAgICAgKTtcbiAgICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJ1YnlDaGVja0lucHV0cyhyb290OiBzdHJpbmcpIHtcbiAgY29uc3QgbG9jayA9IHRleHQocm9vdCwgXCJHZW1maWxlLmxvY2tcIik7XG4gIGNvbnN0IHNlY3Rpb24gPSAvKD86XnxcXG4pQ0hFQ0tTVU1TXFxuKFtcXHNcXFNdKj8pKD89XFxuW0EtWl18JCkvLmV4ZWMobG9jayk/LlsxXTtcbiAgaWYgKCFzZWN0aW9uKSB0aHJvdyBuZXcgRXJyb3IoXCJNYW5hZ2VkIGdlbXMgcmVxdWlyZSB0aGUgbG9jaydzIENIRUNLU1VNUyBzZWN0aW9uXCIpO1xuICByZXR1cm4gWy4uLnNlY3Rpb24ubWF0Y2hBbGwoL14gezJ9KFtBLVphLXowLTkuXy1dKykgXFwoKFteKV0rKVxcKSBzaGEyNTY9KFthLWYwLTldezY0fSkkL2dtKV0uZmxhdE1hcCgobWF0Y2gpID0+IHtcbiAgICBjb25zdCB2ZXJzaW9uID0gcmVxdWlyZWQobWF0Y2hbMl0sIFwiTWlzc2luZyBnZW0gdmVyc2lvblwiKSxcbiAgICAgIHBsYXRmb3JtID0gdmVyc2lvbi5yZXBsYWNlKC9eWzAtOV0rKD86XFwuWzAtOV0rKSooPzpcXC5wcmVcXC5bMC05XSspPy8sIFwiXCIpO1xuICAgIGNvbnN0IHNlbGVjdGVkID0gIXBsYXRmb3JtXG4gICAgICA/IFtcImxpbnV4LXg2NFwiLCBcImxpbnV4LWFybTY0XCJdXG4gICAgICA6IHBsYXRmb3JtID09PSBcIi14ODZfNjQtbGludXgtZ251XCJcbiAgICAgICAgPyBbXCJsaW51eC14NjRcIl1cbiAgICAgICAgOiBwbGF0Zm9ybSA9PT0gXCItYWFyY2g2NC1saW51eC1nbnVcIlxuICAgICAgICAgID8gW1wibGludXgtYXJtNjRcIl1cbiAgICAgICAgICA6IFtdO1xuICAgIGlmICghc2VsZWN0ZWQubGVuZ3RoKSByZXR1cm4gW107XG4gICAgY29uc3QgbmFtZSA9IGAke1N0cmluZyhtYXRjaFsxXSl9LSR7dmVyc2lvbn0uZ2VtYDtcbiAgICByZXR1cm4gW1xuICAgICAgYXJ0aWZhY3QoXG4gICAgICAgIGBodHRwczovL3J1YnlnZW1zLm9yZy9kb3dubG9hZHMvJHtuYW1lfWAsXG4gICAgICAgIHNyaShyZXF1aXJlZChtYXRjaFszXSwgXCJNaXNzaW5nIGdlbSBjaGVja3N1bVwiKSksXG4gICAgICAgIGBnZW1zLyR7bmFtZX1gLFxuICAgICAgICBzZWxlY3RlZCxcbiAgICAgICksXG4gICAgXTtcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjYXJnb0NoZWNrSW5wdXRzKHJvb3Q6IHN0cmluZykge1xuICBjb25zdCBsb2NrID0gcGFyc2VUb21sKHRleHQocm9vdCwgXCJDYXJnby5sb2NrXCIpKTtcbiAgcmV0dXJuIHJlY29yZHMobG9jay5wYWNrYWdlLCBcIkludmFsaWQgQ2FyZ28gbG9jayBwYWNrYWdlc1wiKVxuICAgIC5maWx0ZXIoKGVudHJ5KSA9PiBlbnRyeS5zb3VyY2UpXG4gICAgLm1hcCgoZW50cnkpID0+IHtcbiAgICAgIGlmIChcbiAgICAgICAgZW50cnkuc291cmNlICE9PSBcInJlZ2lzdHJ5K2h0dHBzOi8vZ2l0aHViLmNvbS9ydXN0LWxhbmcvY3JhdGVzLmlvLWluZGV4XCIgfHxcbiAgICAgICAgdHlwZW9mIGVudHJ5LmNoZWNrc3VtICE9PSBcInN0cmluZ1wiIHx8XG4gICAgICAgICEvXlthLWYwLTldezY0fSQvLnRlc3QoZW50cnkuY2hlY2tzdW0pXG4gICAgICApXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgbG9ja2VkIENhcmdvIHNvdXJjZTogJHtTdHJpbmcoZW50cnkubmFtZSl9YCk7XG4gICAgICBjb25zdCBjcmF0ZSA9IHN0cmluZyhlbnRyeS5uYW1lLCBcIk1pc3NpbmcgY3JhdGUgbmFtZVwiKSxcbiAgICAgICAgdmVyc2lvbiA9IHN0cmluZyhlbnRyeS52ZXJzaW9uLCBcIk1pc3NpbmcgY3JhdGUgdmVyc2lvblwiKTtcbiAgICAgIGNvbnN0IG5hbWUgPSBgJHtjcmF0ZX0tJHt2ZXJzaW9ufS5jcmF0ZWA7XG4gICAgICByZXR1cm4gYXJ0aWZhY3QoYGh0dHBzOi8vc3RhdGljLmNyYXRlcy5pby9jcmF0ZXMvJHtjcmF0ZX0vJHtuYW1lfWAsIHNyaShlbnRyeS5jaGVja3N1bSksIGBjYXJnby8ke25hbWV9YCk7XG4gICAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBweXRob25DaGVja0lucHV0cyhyb290OiBzdHJpbmcpIHtcbiAgY29uc3QgbG9jayA9IHBhcnNlVG9tbCh0ZXh0KHJvb3QsIFwidXYubG9ja1wiKSk7XG4gIHJldHVybiByZWNvcmRzKGxvY2sucGFja2FnZSwgXCJJbnZhbGlkIFB5dGhvbiBsb2NrIHBhY2thZ2VzXCIpLmZsYXRNYXAoKGVudHJ5KSA9PlxuICAgIFtcbiAgICAgIC4uLihlbnRyeS5zZGlzdCA9PT0gdW5kZWZpbmVkID8gW10gOiBbcmVjb3JkKGVudHJ5LnNkaXN0LCBcIkludmFsaWQgc291cmNlIGRpc3RyaWJ1dGlvblwiKV0pLFxuICAgICAgLi4ucmVjb3JkcyhlbnRyeS53aGVlbHMgPz8gW10sIFwiSW52YWxpZCBsb2NrZWQgd2hlZWxzXCIpLFxuICAgIF0uZmxhdE1hcCgodmFsdWUpID0+IHtcbiAgICAgIGNvbnN0IGZpbGUgPSB7XG4gICAgICAgIHVybDogc3RyaW5nKHZhbHVlLnVybCwgXCJJbnZhbGlkIFB5dGhvbiBhcnRpZmFjdCBVUkxcIiksXG4gICAgICAgIGhhc2g6IHN0cmluZyh2YWx1ZS5oYXNoLCBcIkludmFsaWQgUHl0aG9uIGFydGlmYWN0IGhhc2hcIiksXG4gICAgICB9O1xuICAgICAgY29uc3QgbmFtZSA9IGJhc2VuYW1lKG5ldyBVUkwoZmlsZS51cmwpLnBhdGhuYW1lKTtcbiAgICAgIGNvbnN0IHNlbGVjdGVkID1cbiAgICAgICAgIW5hbWUuZW5kc1dpdGgoXCIud2hsXCIpIHx8IG5hbWUuZW5kc1dpdGgoXCItYW55LndobFwiKVxuICAgICAgICAgID8gW1wibGludXgteDY0XCIsIFwibGludXgtYXJtNjRcIl1cbiAgICAgICAgICA6IFtcIng2NFwiLCBcImFybTY0XCJdXG4gICAgICAgICAgICAgIC5maWx0ZXIoKGFyY2gpID0+IG5ldyBSZWdFeHAoYG1hbnlsaW51eFteL10qJHthcmNoID09PSBcIng2NFwiID8gXCJ4ODZfNjRcIiA6IFwiYWFyY2g2NFwifWApLnRlc3QobmFtZSkpXG4gICAgICAgICAgICAgIC5tYXAoKGFyY2gpID0+IGBsaW51eC0ke2FyY2h9YCk7XG4gICAgICBpZiAoIXNlbGVjdGVkLmxlbmd0aCkgcmV0dXJuIFtdO1xuICAgICAgaWYgKCEvXnNoYTI1NjpbYS1mMC05XXs2NH0kLy50ZXN0KGZpbGUuaGFzaCkpIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBsb2NrZWQgUHl0aG9uIGludGVncml0eTogJHtuYW1lfWApO1xuICAgICAgcmV0dXJuIFthcnRpZmFjdChmaWxlLnVybCwgc3JpKGZpbGUuaGFzaC5zbGljZSg3KSksIGBweXRob24vJHtuYW1lfWAsIHNlbGVjdGVkKV07XG4gICAgfSksXG4gICk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjb21wb3NlckNoZWNrSW5wdXRzKHJvb3Q6IHN0cmluZykge1xuICByZXR1cm4gW1wiLlwiLCBcInRvb2xzXCIsIFwidG9vbHMvY29tcGF0XCJdLmZsYXRNYXAoKGRpcmVjdG9yeSkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBqb2luKHJvb3QsIGRpcmVjdG9yeSk7XG4gICAgaWYgKCFleGlzdHNTeW5jKGpvaW4oYmFzZSwgXCJjb21wb3Nlci5sb2NrXCIpKSkgcmV0dXJuIFtdO1xuICAgIGNvbnN0IGxvY2sgPSByZWNvcmQoSlNPTi5wYXJzZSh0ZXh0KGJhc2UsIFwiY29tcG9zZXIubG9ja1wiKSksIFwiSW52YWxpZCBDb21wb3NlciBsb2NrXCIpO1xuICAgIGNvbnN0IGNoZWNrc3VtcyA9IHN0cmluZ1JlY29yZChKU09OLnBhcnNlKHRleHQoYmFzZSwgXCIuY29tcG9zZXIvY2hlY2tzdW1zLmpzb25cIikpLCBcIkludmFsaWQgQ29tcG9zZXIgY2hlY2tzdW1zXCIpO1xuICAgIHJldHVybiBbXG4gICAgICAuLi5yZWNvcmRzKGxvY2sucGFja2FnZXMsIFwiSW52YWxpZCBDb21wb3NlciBwYWNrYWdlc1wiKSxcbiAgICAgIC4uLnJlY29yZHMobG9ja1tcInBhY2thZ2VzLWRldlwiXSwgXCJJbnZhbGlkIENvbXBvc2VyIGRldiBwYWNrYWdlc1wiKSxcbiAgICBdXG4gICAgICAubWFwKChlbnRyeSkgPT4gKHsgZW50cnksIGRpc3Q6IHJlY29yZChlbnRyeS5kaXN0LCBcIk1pc3NpbmcgQ29tcG9zZXIgZGlzdHJpYnV0aW9uXCIpIH0pKVxuICAgICAgLmZpbHRlcigoeyBkaXN0IH0pID0+IGRpc3QudHlwZSAhPT0gXCJwYXRoXCIpXG4gICAgICAubWFwKCh7IGVudHJ5LCBkaXN0IH0pID0+ICh7XG4gICAgICAgIG5hbWU6IHN0cmluZyhlbnRyeS5uYW1lLCBcIk1pc3NpbmcgQ29tcG9zZXIgcGFja2FnZSBuYW1lXCIpLFxuICAgICAgICB2ZXJzaW9uOiBzdHJpbmcoZW50cnkudmVyc2lvbiwgXCJNaXNzaW5nIENvbXBvc2VyIHBhY2thZ2UgdmVyc2lvblwiKSxcbiAgICAgICAgZGlzdCxcbiAgICAgIH0pKVxuICAgICAgLm1hcCgoZW50cnkpID0+IHtcbiAgICAgICAgY29uc3QgcmVmZXJlbmNlID1cbiAgICAgICAgICBlbnRyeS5kaXN0LnJlZmVyZW5jZSA9PT0gdW5kZWZpbmVkIHx8IGVudHJ5LmRpc3QucmVmZXJlbmNlID09PSBudWxsXG4gICAgICAgICAgICA/IFwiXCJcbiAgICAgICAgICAgIDogc3RyaW5nKGVudHJ5LmRpc3QucmVmZXJlbmNlLCBcIkludmFsaWQgZGlzdHJpYnV0aW9uIHJlZmVyZW5jZVwiKTtcbiAgICAgICAgY29uc3Qga2V5ID0gYCR7ZW50cnkubmFtZX1AJHtlbnRyeS52ZXJzaW9ufSMke3JlZmVyZW5jZX1gO1xuICAgICAgICBjb25zdCBkaWdlc3QgPSBjaGVja3N1bXNba2V5XTtcbiAgICAgICAgaWYgKCFkaWdlc3QgfHwgIS9eW2EtZjAtOV17NjR9JC8udGVzdChkaWdlc3QpKSB0aHJvdyBuZXcgRXJyb3IoYE1pc3NpbmcgcmV2aWV3ZWQgQ29tcG9zZXIgaW50ZWdyaXR5OiAke2tleX1gKTtcbiAgICAgICAgcmV0dXJuIGFydGlmYWN0KFxuICAgICAgICAgIHN0cmluZyhlbnRyeS5kaXN0LnVybCwgXCJJbnZhbGlkIENvbXBvc2VyIFVSTFwiKSxcbiAgICAgICAgICBzcmkoZGlnZXN0KSxcbiAgICAgICAgICBgY29tcG9zZXIvJHtkaXJlY3RvcnkgPT09IFwiLlwiID8gXCJhcHBsaWNhdGlvblwiIDogZGlyZWN0b3J5fS8ke2VudHJ5Lm5hbWV9LyR7ZGlnZXN0fS56aXBgLFxuICAgICAgICApO1xuICAgICAgfSk7XG4gIH0pO1xufVxuXG4vKiogQSBidWlsZGVyIGNvbnN1bWVzIHRoZXNlIGRlcGVuZGVuY3kgaWRlbnRpdGllczsgZGVwZW5kZW5jeSByZXNvbHV0aW9uIHN0YXlzIGluIHRoZSBsYW5ndWFnZSdzIGxvY2suICovXG5leHBvcnQgZnVuY3Rpb24gbWFuYWdlZENoZWNrSW5wdXRzKHJvb3Q6IHN0cmluZykge1xuICBjb25zdCBpbnB1dHM6IE1hbmFnZWRTb3VyY2VbXSA9IFtdO1xuICBjb25zdCBzb3VyY2VIYXNoZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgZm9yIChjb25zdCBbZmlsZSwgZ2VuZXJhdGUsIHNvdXJjZXNdIG9mIFtcbiAgICBbXG4gICAgICBcInBucG0tbG9jay55YW1sXCIsXG4gICAgICBucG1DaGVja0lucHV0cyxcbiAgICAgIFtcInBhY2thZ2UuanNvblwiLCBcInBucG0tbG9jay55YW1sXCIsIFwicG5wbS13b3Jrc3BhY2UueWFtbFwiLCBcIi5wbnBtZmlsZS5janNcIiwgXCIubnBtcmNcIl0sXG4gICAgXSxcbiAgICBbXCJDYXJnby5sb2NrXCIsIGNhcmdvQ2hlY2tJbnB1dHMsIFtcIkNhcmdvLnRvbWxcIiwgXCJDYXJnby5sb2NrXCJdXSxcbiAgICBbXCJ1di5sb2NrXCIsIHB5dGhvbkNoZWNrSW5wdXRzLCBbXCJweXByb2plY3QudG9tbFwiLCBcInV2LmxvY2tcIl1dLFxuICAgIFtcIkdlbWZpbGUubG9ja1wiLCBydWJ5Q2hlY2tJbnB1dHMsIFtcIkdlbWZpbGVcIiwgXCJHZW1maWxlLmxvY2tcIl1dLFxuICAgIFtcIi5tdm4vY2hlY2tzdW1zL2NoZWNrc3Vtcy5zaGEyNTZcIiwgbWF2ZW5DaGVja0lucHV0cywgW1wicG9tLnhtbFwiLCBcIi5tdm4vY2hlY2tzdW1zL2NoZWNrc3Vtcy5zaGEyNTZcIl1dLFxuICAgIFtcbiAgICAgIFwiY29tcG9zZXIubG9ja1wiLFxuICAgICAgY29tcG9zZXJDaGVja0lucHV0cyxcbiAgICAgIFtcbiAgICAgICAgXCJjb21wb3Nlci5qc29uXCIsXG4gICAgICAgIFwiY29tcG9zZXIubG9ja1wiLFxuICAgICAgICBcIi5jb21wb3Nlci9jaGVja3N1bXMuanNvblwiLFxuICAgICAgICBcInRvb2xzL2NvbXBvc2VyLmpzb25cIixcbiAgICAgICAgXCJ0b29scy9jb21wb3Nlci5sb2NrXCIsXG4gICAgICAgIFwidG9vbHMvLmNvbXBvc2VyL2NoZWNrc3Vtcy5qc29uXCIsXG4gICAgICAgIFwidG9vbHMvY29tcGF0L2NvbXBvc2VyLmpzb25cIixcbiAgICAgICAgXCJ0b29scy9jb21wYXQvY29tcG9zZXIubG9ja1wiLFxuICAgICAgICBcInRvb2xzL2NvbXBhdC8uY29tcG9zZXIvY2hlY2tzdW1zLmpzb25cIixcbiAgICAgIF0sXG4gICAgXSxcbiAgXSBhcyBjb25zdCkge1xuICAgIGlmICghZXhpc3RzU3luYyhqb2luKHJvb3QsIGZpbGUpKSkgY29udGludWU7XG4gICAgaW5wdXRzLnB1c2goLi4uZ2VuZXJhdGUocm9vdCkpO1xuICAgIGZvciAoY29uc3Qgc291cmNlIG9mIHNvdXJjZXMpXG4gICAgICBpZiAoZXhpc3RzU3luYyhqb2luKHJvb3QsIHNvdXJjZSkpKVxuICAgICAgICBzb3VyY2VIYXNoZXNbc291cmNlXSA9IGRlcGVuZGVuY3lJbnB1dEhhc2goc291cmNlLCByZWFkRmlsZVN5bmMoam9pbihyb290LCBzb3VyY2UpKSk7XG4gIH1cbiAgY29uc3QgZXh0cmFGaWxlID0gam9pbihyb290LCBcIm1hbmFnZWQtZXh0cmEtaW5wdXRzLmpzb25cIik7XG4gIGlmIChleGlzdHNTeW5jKGV4dHJhRmlsZSkpIHtcbiAgICBjb25zdCBleHRyYSA9IG1hbmFnZWREZWNsYXJhdGlvbihKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhleHRyYUZpbGUsIFwidXRmOFwiKSkpO1xuICAgIHNvdXJjZUhhc2hlc1tcIm1hbmFnZWQtZXh0cmEtaW5wdXRzLmpzb25cIl0gPSBzaGEyNTYocmVhZEZpbGVTeW5jKGV4dHJhRmlsZSkpO1xuICAgIGlmIChleHRyYS5zY2hlbWFfdmVyc2lvbiAhPT0gMSkgdGhyb3cgbmV3IEVycm9yKFwiVW5rbm93biBtYW5hZ2VkIGV4dHJhLWlucHV0IHNjaGVtYVwiKTtcbiAgICBmb3IgKGNvbnN0IFtmaWxlLCBleHBlY3RlZF0gb2YgT2JqZWN0LmVudHJpZXMoZXh0cmEuc291cmNlX2hhc2hlcykpIHtcbiAgICAgIGlmIChcbiAgICAgICAgIWZpbGUgfHxcbiAgICAgICAgZmlsZS5zdGFydHNXaXRoKFwiL1wiKSB8fFxuICAgICAgICBmaWxlLmluY2x1ZGVzKFwiXFxcXFwiKSB8fFxuICAgICAgICBmaWxlLnNwbGl0KFwiL1wiKS5zb21lKChwYXJ0KSA9PiAhcGFydCB8fCBwYXJ0ID09PSBcIi4uXCIgfHwgcGFydCA9PT0gXCIuXCIpXG4gICAgICApXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIlVuc2FmZSBzdXBwbGVtZW50YWwgc291cmNlIHBhdGhcIik7XG4gICAgICBpZiAoZGVwZW5kZW5jeUlucHV0SGFzaChmaWxlLCByZWFkRmlsZVN5bmMoam9pbihyb290LCBmaWxlKSkpICE9PSBleHBlY3RlZClcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGAke2ZpbGV9OiByZWZyZXNoIGRlcml2ZWQgbWFuYWdlZCBpbnB1dHNgKTtcbiAgICAgIHNvdXJjZUhhc2hlc1tmaWxlXSA9IGV4cGVjdGVkO1xuICAgIH1cbiAgICBpbnB1dHMucHVzaCguLi5leHRyYS5pbnB1dHMubWFwKChlbnRyeSkgPT4gYXJ0aWZhY3QoZW50cnkudXJsLCBlbnRyeS5oYXNoLCBlbnRyeS5kZXN0aW5hdGlvbiwgZW50cnkucGxhdGZvcm1zKSkpO1xuICB9XG4gIGNvbnN0IGJvb3RzdHJhcEZpbGUgPSBqb2luKHJvb3QsIFwibWFuYWdlZC1ib290c3RyYXAuanNvblwiKTtcbiAgY29uc3QgcmVnaXN0cnlGaWxlID0gam9pbihyb290LCBcIm1hbmFnZWQtcmVnaXN0cnkuanNvbi5iclwiKTtcbiAgY29uc3QgcmVnaXN0cnkgPSBleGlzdHNTeW5jKHJlZ2lzdHJ5RmlsZSk7XG4gIGlmIChyZWdpc3RyeSkgc291cmNlSGFzaGVzW1wibWFuYWdlZC1yZWdpc3RyeS5qc29uLmJyXCJdID0gc2hhMjU2KHJlYWRGaWxlU3luYyhyZWdpc3RyeUZpbGUpKTtcbiAgY29uc3QgYm9vdHN0cmFwID0gZXhpc3RzU3luYyhib290c3RyYXBGaWxlKVxuICAgID8gcmVjb3JkKEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGJvb3RzdHJhcEZpbGUsIFwidXRmOFwiKSksIFwiSW52YWxpZCBtYW5hZ2VkIGJvb3RzdHJhcFwiKVxuICAgIDogdW5kZWZpbmVkO1xuICBpZiAoYm9vdHN0cmFwKSB7XG4gICAgaWYgKGJvb3RzdHJhcC5zY2hlbWFfdmVyc2lvbiAhPT0gMSkgdGhyb3cgbmV3IEVycm9yKFwiVW5rbm93biBtYW5hZ2VkIGJvb3RzdHJhcCBzY2hlbWFcIik7XG4gICAgc291cmNlSGFzaGVzW1wibWFuYWdlZC1ib290c3RyYXAuanNvblwiXSA9IHNoYTI1NihyZWFkRmlsZVN5bmMoYm9vdHN0cmFwRmlsZSkpO1xuICAgIGZvciAoY29uc3QgW3BhdGgsIGVudHJ5XSBvZiBPYmplY3QuZW50cmllcyhcbiAgICAgIHJlY29yZChyZWNvcmQoYm9vdHN0cmFwLnBhY2thZ2VfbG9jaywgXCJJbnZhbGlkIGJvb3RzdHJhcCBsb2NrXCIpLnBhY2thZ2VzLCBcIkludmFsaWQgYm9vdHN0cmFwIHBhY2thZ2VzXCIpLFxuICAgICkpIHtcbiAgICAgIGlmICghcGF0aCkgY29udGludWU7XG4gICAgICBjb25zdCB2YWx1ZSA9IHJlY29yZChlbnRyeSwgXCJJbnZhbGlkIGJvb3RzdHJhcCBwYWNrYWdlXCIpO1xuICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBwbGF0Zm9ybXMocGFja2FnZVBsYXRmb3JtKHZhbHVlKSk7XG4gICAgICBpZiAoc2VsZWN0ZWQubGVuZ3RoKVxuICAgICAgICBpbnB1dHMucHVzaChcbiAgICAgICAgICBhcnRpZmFjdChcbiAgICAgICAgICAgIHN0cmluZyh2YWx1ZS5yZXNvbHZlZCwgXCJJbnZhbGlkIGJvb3RzdHJhcCBVUkxcIiksXG4gICAgICAgICAgICB2YWx1ZS5pbnRlZ3JpdHksXG4gICAgICAgICAgICBgYm9vdHN0cmFwLyR7cGF0aC5yZXBsYWNlQWxsKFwiL1wiLCBcIi1cIil9LnRnemAsXG4gICAgICAgICAgICBzZWxlY3RlZCxcbiAgICAgICAgICApLFxuICAgICAgICApO1xuICAgIH1cbiAgfVxuICBjb25zdCBkZXN0aW5hdGlvbnMgPSBuZXcgTWFwPHN0cmluZywgTWFuYWdlZFNvdXJjZT4oKTtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiBpbnB1dHMpIHtcbiAgICBjb25zdCBwcmV2aW91cyA9IGRlc3RpbmF0aW9ucy5nZXQoZW50cnkuZGVzdGluYXRpb24pO1xuICAgIGlmIChwcmV2aW91cyAmJiBKU09OLnN0cmluZ2lmeShwcmV2aW91cykgIT09IEpTT04uc3RyaW5naWZ5KGVudHJ5KSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQ29uZmxpY3RpbmcgbWFuYWdlZCBpbnB1dDogJHtlbnRyeS5kZXN0aW5hdGlvbn1gKTtcbiAgICBkZXN0aW5hdGlvbnMuc2V0KGVudHJ5LmRlc3RpbmF0aW9uLCBlbnRyeSk7XG4gIH1cbiAgcmV0dXJuIG1hbmFnZWREZWNsYXJhdGlvbih7XG4gICAgc2NoZW1hX3ZlcnNpb246IDEsXG4gICAgc291cmNlX2hhc2hlczogT2JqZWN0LmZyb21FbnRyaWVzKE9iamVjdC5lbnRyaWVzKHNvdXJjZUhhc2hlcykuc29ydCgpKSxcbiAgICAuLi4oYm9vdHN0cmFwID8geyBib290c3RyYXA6IHRydWUgfSA6IHt9KSxcbiAgICAuLi4ocmVnaXN0cnkgPyB7IHJlZ2lzdHJ5OiB0cnVlIH0gOiB7fSksXG4gICAgaW5wdXRzOiBbLi4uZGVzdGluYXRpb25zLnZhbHVlcygpXS5zb3J0KChhLCBiKSA9PlxuICAgICAgYS5kZXN0aW5hdGlvbiA8IGIuZGVzdGluYXRpb24gPyAtMSA6IGEuZGVzdGluYXRpb24gPiBiLmRlc3RpbmF0aW9uID8gMSA6IDAsXG4gICAgKSxcbiAgfSk7XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLFVBQVUsUUFBUSxTQUFTLFFBQVEsU0FBUyxvQkFBb0I7QUFDekUsU0FBUywyQkFBMkI7QUFDcEMsU0FBNkIsZUFBZSwwQkFBMEI7QUF5QnRFLFNBQVMsa0JBQWtC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QUFlLE1BQU0sQ0FBQyxHQUFHLDJCQUEyQixJQUNuRjtBQUNKLE1BQUksV0FBVztBQUNiLFFBQUksVUFBVSxtQkFBbUIsRUFBRyxPQUFNLElBQUksTUFBTSxrQ0FBa0M7QUFDdEYsaUJBQWEsd0JBQXdCLElBQUksT0FBTyxhQUFhLGFBQWEsQ0FBQztBQUMzRSxlQUFXLENBQUMsTUFBTSxLQUFLLEtBQUssT0FBTztBQUFBLE1BQ2pDLE9BQU8sT0FBTyxVQUFVLGNBQWMsd0JBQXdCLEVBQUUsVUFBVSw0QkFBNEI7QUFBQSxJQUN4RyxHQUFHO0FBQ0QsVUFBSSxDQUFDLEtBQU07QUFDWCxZQUFNLFFBQVEsT0FBTyxPQUFPLDJCQUEyQjtBQUN2RCxZQUFNLFdBQVcsVUFBVSxnQkFBZ0IsS0FBSyxDQUFDO0FBQ2pELFVBQUksU0FBUztBQUNYLGVBQU87QUFBQSxVQUNMO0FBQUEsWUFDRSxPQUFPLE1BQU0sVUFBVSx1QkFBdUI7QUFBQSxZQUM5QyxNQUFNO0FBQUEsWUFDTixhQUFhLEtBQUssV0FBVyxLQUFLLEdBQUcsQ0FBQztBQUFBLFlBQ3RDO0FBQUEsVUFDRjtBQUFBLFFBQ0Y7QUFBQSxJQUNKO0FBQUEsRUFDRjtBQUNBLFFBQU0sZUFBZSxvQkFBSSxJQUEyQjtBQUNwRCxhQUFXLFNBQVMsUUFBUTtBQUMxQixVQUFNLFdBQVcsYUFBYSxJQUFJLE1BQU0sV0FBVztBQUNuRCxRQUFJLFlBQVksS0FBSyxVQUFVLFFBQVEsTUFBTSxLQUFLLFVBQVUsS0FBSztBQUMvRCxZQUFNLElBQUksTUFBTSw4QkFBOEIsTUFBTSxXQUFXLEVBQUU7QUFDbkUsaUJBQWEsSUFBSSxNQUFNLGFBQWEsS0FBSztBQUFBLEVBQzNDO0FBQ0EsU0FBTyxtQkFBbUI7QUFBQSxJQUN4QixnQkFBZ0I7QUFBQSxJQUNoQixlQUFlLE9BQU8sWUFBWSxPQUFPLFFBQVEsWUFBWSxFQUFFLEtBQUssQ0FBQztBQUFBLElBQ3JFLEdBQUksWUFBWSxFQUFFLFdBQVcsS0FBSyxJQUFJLENBQUM7QUFBQSxJQUN2QyxHQUFJLFdBQVcsRUFBRSxVQUFVLEtBQUssSUFBSSxDQUFDO0FBQUEsSUFDckMsUUFBUSxDQUFDLEdBQUcsYUFBYSxPQUFPLENBQUMsRUFBRTtBQUFBLE1BQUssQ0FBQyxHQUFHLE1BQzFDLEVBQUUsY0FBYyxFQUFFLGNBQWMsS0FBSyxFQUFFLGNBQWMsRUFBRSxjQUFjLElBQUk7QUFBQSxJQUMzRTtBQUFBLEVBQ0YsQ0FBQztBQUNIOyIsIm5hbWVzIjpbInBsYXRmb3JtcyJdLCJmaWxlIjoic2NyaXB0cy9tYW5hZ2VkLWNoZWNrLWlucHV0cy5tanMifQ==
