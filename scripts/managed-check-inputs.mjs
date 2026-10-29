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
    ["pnpm-lock.yaml", npmCheckInputs, ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".pnpmfile.cjs"]],
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1hbmFnZWQtY2hlY2staW5wdXRzLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyByZXF1aXJlZCwgcmVjb3JkLCByZWNvcmRzLCBzdHJpbmcsIHN0cmluZ3MsIHN0cmluZ1JlY29yZCB9IGZyb20gXCIuL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IGRlcGVuZGVuY3lJbnB1dEhhc2ggfSBmcm9tIFwiLi9kZXBlbmRlbmN5LWlkZW50aXR5Lm1qc1wiO1xuaW1wb3J0IHsgdHlwZSBNYW5hZ2VkU291cmNlLCBtYW5hZ2VkU291cmNlLCBtYW5hZ2VkRGVjbGFyYXRpb24gfSBmcm9tIFwiLi9tYW5hZ2VkLXNvdXJjZS1jb250cmFjdC5tanNcIjtcbmV4cG9ydCBpbnRlcmZhY2UgUGFja2FnZVBsYXRmb3JtIHtcbiAgb3M/OiBzdHJpbmdbXTtcbiAgY3B1Pzogc3RyaW5nW107XG4gIGxpYmM/OiBzdHJpbmdbXTtcbn1cbmV4cG9ydCBpbnRlcmZhY2UgTnBtTG9ja2VkUGFja2FnZSBleHRlbmRzIFBhY2thZ2VQbGF0Zm9ybSB7XG4gIHJlc29sdXRpb24/OiB7IHRhcmJhbGw/OiBzdHJpbmc7IGludGVncml0eT86IHN0cmluZyB9O1xufVxuZXhwb3J0IGludGVyZmFjZSBOcG1Mb2NrIHtcbiAgcGFja2FnZXM/OiBSZWNvcmQ8c3RyaW5nLCBOcG1Mb2NrZWRQYWNrYWdlPjtcbn1cbmV4cG9ydCBpbnRlcmZhY2UgQm9vdHN0cmFwUGFja2FnZSBleHRlbmRzIFBhY2thZ2VQbGF0Zm9ybSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgcmVzb2x2ZWQ6IHN0cmluZztcbiAgaW50ZWdyaXR5OiBzdHJpbmc7XG59XG5leHBvcnQgaW50ZXJmYWNlIE1hbmFnZWRCb290c3RyYXAge1xuICBzY2hlbWFfdmVyc2lvbjogbnVtYmVyO1xuICBwYWNrYWdlX2pzb246IHVua25vd247XG4gIHBhY2thZ2VfbG9jazogeyBwYWNrYWdlczogUmVjb3JkPHN0cmluZywgQm9vdHN0cmFwUGFja2FnZT4gfTtcbiAgcHJvb2ZzOiB1bmtub3duW107XG59XG5pbXBvcnQgdHlwZSB7IEJpbmFyeUxpa2UgfSBmcm9tIFwiY3J5cHRvXCI7XG5cbmltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHBhcnNlVG9tbCB9IGZyb20gXCIuL3J1bnRpbWUtcGFyc2Vycy5tanNcIjtcbmltcG9ydCB7IHBucG1QYWNrYWdlcywgcG5wbUlkZW50aXR5IH0gZnJvbSBcIi4vcG5wbS1sb2NrLm1qc1wiO1xuXG5mdW5jdGlvbiBwYWNrYWdlUGxhdGZvcm0odmFsdWU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUGFja2FnZVBsYXRmb3JtIHtcbiAgcmV0dXJuIE9iamVjdC5mcm9tRW50cmllcyhcbiAgICBbXCJvc1wiLCBcImNwdVwiLCBcImxpYmNcIl0uZmxhdE1hcCgoa2V5KSA9PlxuICAgICAgdmFsdWVba2V5XSA9PT0gdW5kZWZpbmVkID8gW10gOiBbW2tleSwgc3RyaW5ncyh2YWx1ZVtrZXldLCBcIkludmFsaWQgcGFja2FnZSBwbGF0Zm9ybVwiKV1dLFxuICAgICksXG4gICk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZWFkTnBtTG9jayh2YWx1ZTogdW5rbm93bik6IE5wbUxvY2sge1xuICBjb25zdCBkb2N1bWVudCA9IHJlY29yZCh2YWx1ZSwgXCJJbnZhbGlkIG5wbSBsb2NrIGRvY3VtZW50XCIpO1xuICByZXR1cm4ge1xuICAgIHBhY2thZ2VzOiBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgICBPYmplY3QuZW50cmllcyhyZWNvcmQoZG9jdW1lbnQucGFja2FnZXMgPz8ge30sIFwiSW52YWxpZCBucG0gbG9jayBwYWNrYWdlc1wiKSkubWFwKChbbmFtZSwgcmF3XSkgPT4ge1xuICAgICAgICBjb25zdCBlbnRyeSA9IHJlY29yZChyYXcsIFwiSW52YWxpZCBucG0gbG9jayBwYWNrYWdlXCIpO1xuICAgICAgICBjb25zdCByZXNvbHV0aW9uID1cbiAgICAgICAgICBlbnRyeS5yZXNvbHV0aW9uID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiByZWNvcmQoZW50cnkucmVzb2x1dGlvbiwgXCJJbnZhbGlkIHBhY2thZ2UgcmVzb2x1dGlvblwiKTtcbiAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICBuYW1lLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIC4uLnBhY2thZ2VQbGF0Zm9ybShlbnRyeSksXG4gICAgICAgICAgICAuLi4ocmVzb2x1dGlvblxuICAgICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICAgIHJlc29sdXRpb246IHtcbiAgICAgICAgICAgICAgICAgICAgLi4uKHJlc29sdXRpb24udGFyYmFsbCA9PT0gdW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgICAgICAgPyB7fVxuICAgICAgICAgICAgICAgICAgICAgIDogeyB0YXJiYWxsOiBzdHJpbmcocmVzb2x1dGlvbi50YXJiYWxsLCBcIkludmFsaWQgcGFja2FnZSB0YXJiYWxsXCIpIH0pLFxuICAgICAgICAgICAgICAgICAgICAuLi4ocmVzb2x1dGlvbi5pbnRlZ3JpdHkgPT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgICAgICAgICAgID8ge31cbiAgICAgICAgICAgICAgICAgICAgICA6IHsgaW50ZWdyaXR5OiBzdHJpbmcocmVzb2x1dGlvbi5pbnRlZ3JpdHksIFwiSW52YWxpZCBwYWNrYWdlIGludGVncml0eVwiKSB9KSxcbiAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICB9LFxuICAgICAgICBdO1xuICAgICAgfSksXG4gICAgKSxcbiAgfTtcbn1cblxuY29uc3Qgc2hhMjU2ID0gKGJ5dGVzOiBCaW5hcnlMaWtlKSA9PiBjcmVhdGVIYXNoKFwic2hhMjU2XCIpLnVwZGF0ZShieXRlcykuZGlnZXN0KFwiaGV4XCIpO1xuY29uc3Qgc3JpID0gKGhleDogc3RyaW5nKSA9PiBgc2hhMjU2LSR7QnVmZmVyLmZyb20oaGV4LCBcImhleFwiKS50b1N0cmluZyhcImJhc2U2NFwiKX1gO1xuY29uc3QgdGV4dCA9IChyb290OiBzdHJpbmcsIG5hbWU6IHN0cmluZykgPT4gcmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgbmFtZSksIFwidXRmOFwiKTtcblxuZnVuY3Rpb24gYXJ0aWZhY3QodXJsOiBzdHJpbmcsIGhhc2g6IHVua25vd24sIGRlc3RpbmF0aW9uOiBzdHJpbmcsIHBsYXRmb3Jtcz86IHN0cmluZ1tdKSB7XG4gIHJldHVybiBtYW5hZ2VkU291cmNlKHsgdXJsLCBoYXNoLCBkZXN0aW5hdGlvbiwgLi4uKHBsYXRmb3JtcyA/IHsgcGxhdGZvcm1zIH0gOiB7fSkgfSk7XG59XG5cbmZ1bmN0aW9uIHBsYXRmb3JtcyhlbnRyeTogUGFja2FnZVBsYXRmb3JtKSB7XG4gIGNvbnN0IGFjY2VwdHMgPSAodmFsdWVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCwgc2VsZWN0ZWQ6IHN0cmluZykgPT5cbiAgICAhdmFsdWVzIHx8XG4gICAgKCF2YWx1ZXMuaW5jbHVkZXMoYCEke3NlbGVjdGVkfWApICYmXG4gICAgICAoIXZhbHVlcy5zb21lKCh2YWx1ZTogc3RyaW5nKSA9PiAhdmFsdWUuc3RhcnRzV2l0aChcIiFcIikpIHx8IHZhbHVlcy5pbmNsdWRlcyhzZWxlY3RlZCkpKTtcbiAgcmV0dXJuIFtcIng2NFwiLCBcImFybTY0XCJdXG4gICAgLmZpbHRlcigoYXJjaCkgPT4gYWNjZXB0cyhlbnRyeS5vcywgXCJsaW51eFwiKSAmJiBhY2NlcHRzKGVudHJ5LmNwdSwgYXJjaCkgJiYgYWNjZXB0cyhlbnRyeS5saWJjLCBcImdsaWJjXCIpKVxuICAgIC5tYXAoKGFyY2gpID0+IGBsaW51eC0ke2FyY2h9YCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBucG1DaGVja0lucHV0cyhyb290OiBzdHJpbmcpIHtcbiAgY29uc3QgcGFja2FnZXMgPSByZWFkTnBtTG9jayh7IHBhY2thZ2VzOiBwbnBtUGFja2FnZXModGV4dChyb290LCBcInBucG0tbG9jay55YW1sXCIpKSB9KS5wYWNrYWdlcyA/PyB7fTtcbiAgcmV0dXJuIE9iamVjdC5lbnRyaWVzKHBhY2thZ2VzKS5mbGF0TWFwKChba2V5LCBlbnRyeV0pID0+IHtcbiAgICBjb25zdCBzZWxlY3RlZCA9IHBsYXRmb3JtcyhlbnRyeSk7XG4gICAgaWYgKCFzZWxlY3RlZC5sZW5ndGgpIHJldHVybiBbXTtcbiAgICBjb25zdCB7IG5hbWUsIHZlcnNpb24gfSA9IHBucG1JZGVudGl0eShrZXkpO1xuICAgIGlmICghL15bQS1aYS16MC05LitfLV0rJC8udGVzdCh2ZXJzaW9uKSB8fCAhL14oQFthLXowLTkuXy1dK1xcLyk/W2EtejAtOS5fLV0rJC8udGVzdChuYW1lKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgbG9ja2VkIG5wbSBzb3VyY2U6ICR7a2V5fWApO1xuICAgIGNvbnN0IHVybCA9XG4gICAgICBlbnRyeS5yZXNvbHV0aW9uPy50YXJiYWxsID8/XG4gICAgICBgaHR0cHM6Ly9yZWdpc3RyeS5ucG1qcy5vcmcvJHtuYW1lfS8tLyR7U3RyaW5nKG5hbWUuc3BsaXQoXCIvXCIpLmF0KC0xKSl9LSR7dmVyc2lvbn0udGd6YDtcbiAgICByZXR1cm4gW2FydGlmYWN0KHVybCwgZW50cnkucmVzb2x1dGlvbj8uaW50ZWdyaXR5LCBgbnBtLyR7bmFtZS5yZXBsYWNlQWxsKFwiL1wiLCBcIi1cIil9LSR7dmVyc2lvbn0udGd6YCwgc2VsZWN0ZWQpXTtcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXZlbkNoZWNrSW5wdXRzKHJvb3Q6IHN0cmluZykge1xuICByZXR1cm4gdGV4dChyb290LCBcIi5tdm4vY2hlY2tzdW1zL2NoZWNrc3Vtcy5zaGEyNTZcIilcbiAgICAudHJpbSgpXG4gICAgLnNwbGl0KFwiXFxuXCIpXG4gICAgLm1hcCgobGluZSkgPT4ge1xuICAgICAgY29uc3QgbWF0Y2ggPSAvXihbYS1mMC05XXs2NH0pIHsyfShbQS1aYS16MC05Ll8rLy1dKykkLy5leGVjKGxpbmUpO1xuICAgICAgaWYgKCFtYXRjaCkgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBsb2NrZWQgTWF2ZW4gY2hlY2tzdW1cIik7XG4gICAgICByZXR1cm4gYXJ0aWZhY3QoXG4gICAgICAgIGBodHRwczovL21hdmVuLWNlbnRyYWwuc3RvcmFnZS1kb3dubG9hZC5nb29nbGVhcGlzLmNvbS9tYXZlbjIvJHtTdHJpbmcobWF0Y2hbMl0pfWAsXG4gICAgICAgIHNyaShyZXF1aXJlZChtYXRjaFsxXSwgXCJNaXNzaW5nIE1hdmVuIGNoZWNrc3VtXCIpKSxcbiAgICAgICAgYG1hdmVuLyR7U3RyaW5nKG1hdGNoWzJdKX1gLFxuICAgICAgKTtcbiAgICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJ1YnlDaGVja0lucHV0cyhyb290OiBzdHJpbmcpIHtcbiAgY29uc3QgbG9jayA9IHRleHQocm9vdCwgXCJHZW1maWxlLmxvY2tcIik7XG4gIGNvbnN0IHNlY3Rpb24gPSAvKD86XnxcXG4pQ0hFQ0tTVU1TXFxuKFtcXHNcXFNdKj8pKD89XFxuW0EtWl18JCkvLmV4ZWMobG9jayk/LlsxXTtcbiAgaWYgKCFzZWN0aW9uKSB0aHJvdyBuZXcgRXJyb3IoXCJNYW5hZ2VkIGdlbXMgcmVxdWlyZSB0aGUgbG9jaydzIENIRUNLU1VNUyBzZWN0aW9uXCIpO1xuICByZXR1cm4gWy4uLnNlY3Rpb24ubWF0Y2hBbGwoL14gezJ9KFtBLVphLXowLTkuXy1dKykgXFwoKFteKV0rKVxcKSBzaGEyNTY9KFthLWYwLTldezY0fSkkL2dtKV0uZmxhdE1hcCgobWF0Y2gpID0+IHtcbiAgICBjb25zdCB2ZXJzaW9uID0gcmVxdWlyZWQobWF0Y2hbMl0sIFwiTWlzc2luZyBnZW0gdmVyc2lvblwiKSxcbiAgICAgIHBsYXRmb3JtID0gdmVyc2lvbi5yZXBsYWNlKC9eWzAtOV0rKD86XFwuWzAtOV0rKSooPzpcXC5wcmVcXC5bMC05XSspPy8sIFwiXCIpO1xuICAgIGNvbnN0IHNlbGVjdGVkID0gIXBsYXRmb3JtXG4gICAgICA/IFtcImxpbnV4LXg2NFwiLCBcImxpbnV4LWFybTY0XCJdXG4gICAgICA6IHBsYXRmb3JtID09PSBcIi14ODZfNjQtbGludXgtZ251XCJcbiAgICAgICAgPyBbXCJsaW51eC14NjRcIl1cbiAgICAgICAgOiBwbGF0Zm9ybSA9PT0gXCItYWFyY2g2NC1saW51eC1nbnVcIlxuICAgICAgICAgID8gW1wibGludXgtYXJtNjRcIl1cbiAgICAgICAgICA6IFtdO1xuICAgIGlmICghc2VsZWN0ZWQubGVuZ3RoKSByZXR1cm4gW107XG4gICAgY29uc3QgbmFtZSA9IGAke1N0cmluZyhtYXRjaFsxXSl9LSR7dmVyc2lvbn0uZ2VtYDtcbiAgICByZXR1cm4gW1xuICAgICAgYXJ0aWZhY3QoXG4gICAgICAgIGBodHRwczovL3J1YnlnZW1zLm9yZy9kb3dubG9hZHMvJHtuYW1lfWAsXG4gICAgICAgIHNyaShyZXF1aXJlZChtYXRjaFszXSwgXCJNaXNzaW5nIGdlbSBjaGVja3N1bVwiKSksXG4gICAgICAgIGBnZW1zLyR7bmFtZX1gLFxuICAgICAgICBzZWxlY3RlZCxcbiAgICAgICksXG4gICAgXTtcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjYXJnb0NoZWNrSW5wdXRzKHJvb3Q6IHN0cmluZykge1xuICBjb25zdCBsb2NrID0gcGFyc2VUb21sKHRleHQocm9vdCwgXCJDYXJnby5sb2NrXCIpKTtcbiAgcmV0dXJuIHJlY29yZHMobG9jay5wYWNrYWdlLCBcIkludmFsaWQgQ2FyZ28gbG9jayBwYWNrYWdlc1wiKVxuICAgIC5maWx0ZXIoKGVudHJ5KSA9PiBlbnRyeS5zb3VyY2UpXG4gICAgLm1hcCgoZW50cnkpID0+IHtcbiAgICAgIGlmIChcbiAgICAgICAgZW50cnkuc291cmNlICE9PSBcInJlZ2lzdHJ5K2h0dHBzOi8vZ2l0aHViLmNvbS9ydXN0LWxhbmcvY3JhdGVzLmlvLWluZGV4XCIgfHxcbiAgICAgICAgdHlwZW9mIGVudHJ5LmNoZWNrc3VtICE9PSBcInN0cmluZ1wiIHx8XG4gICAgICAgICEvXlthLWYwLTldezY0fSQvLnRlc3QoZW50cnkuY2hlY2tzdW0pXG4gICAgICApXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgbG9ja2VkIENhcmdvIHNvdXJjZTogJHtTdHJpbmcoZW50cnkubmFtZSl9YCk7XG4gICAgICBjb25zdCBjcmF0ZSA9IHN0cmluZyhlbnRyeS5uYW1lLCBcIk1pc3NpbmcgY3JhdGUgbmFtZVwiKSxcbiAgICAgICAgdmVyc2lvbiA9IHN0cmluZyhlbnRyeS52ZXJzaW9uLCBcIk1pc3NpbmcgY3JhdGUgdmVyc2lvblwiKTtcbiAgICAgIGNvbnN0IG5hbWUgPSBgJHtjcmF0ZX0tJHt2ZXJzaW9ufS5jcmF0ZWA7XG4gICAgICByZXR1cm4gYXJ0aWZhY3QoYGh0dHBzOi8vc3RhdGljLmNyYXRlcy5pby9jcmF0ZXMvJHtjcmF0ZX0vJHtuYW1lfWAsIHNyaShlbnRyeS5jaGVja3N1bSksIGBjYXJnby8ke25hbWV9YCk7XG4gICAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBweXRob25DaGVja0lucHV0cyhyb290OiBzdHJpbmcpIHtcbiAgY29uc3QgbG9jayA9IHBhcnNlVG9tbCh0ZXh0KHJvb3QsIFwidXYubG9ja1wiKSk7XG4gIHJldHVybiByZWNvcmRzKGxvY2sucGFja2FnZSwgXCJJbnZhbGlkIFB5dGhvbiBsb2NrIHBhY2thZ2VzXCIpLmZsYXRNYXAoKGVudHJ5KSA9PlxuICAgIFtcbiAgICAgIC4uLihlbnRyeS5zZGlzdCA9PT0gdW5kZWZpbmVkID8gW10gOiBbcmVjb3JkKGVudHJ5LnNkaXN0LCBcIkludmFsaWQgc291cmNlIGRpc3RyaWJ1dGlvblwiKV0pLFxuICAgICAgLi4ucmVjb3JkcyhlbnRyeS53aGVlbHMgPz8gW10sIFwiSW52YWxpZCBsb2NrZWQgd2hlZWxzXCIpLFxuICAgIF0uZmxhdE1hcCgodmFsdWUpID0+IHtcbiAgICAgIGNvbnN0IGZpbGUgPSB7XG4gICAgICAgIHVybDogc3RyaW5nKHZhbHVlLnVybCwgXCJJbnZhbGlkIFB5dGhvbiBhcnRpZmFjdCBVUkxcIiksXG4gICAgICAgIGhhc2g6IHN0cmluZyh2YWx1ZS5oYXNoLCBcIkludmFsaWQgUHl0aG9uIGFydGlmYWN0IGhhc2hcIiksXG4gICAgICB9O1xuICAgICAgY29uc3QgbmFtZSA9IGJhc2VuYW1lKG5ldyBVUkwoZmlsZS51cmwpLnBhdGhuYW1lKTtcbiAgICAgIGNvbnN0IHNlbGVjdGVkID1cbiAgICAgICAgIW5hbWUuZW5kc1dpdGgoXCIud2hsXCIpIHx8IG5hbWUuZW5kc1dpdGgoXCItYW55LndobFwiKVxuICAgICAgICAgID8gW1wibGludXgteDY0XCIsIFwibGludXgtYXJtNjRcIl1cbiAgICAgICAgICA6IFtcIng2NFwiLCBcImFybTY0XCJdXG4gICAgICAgICAgICAgIC5maWx0ZXIoKGFyY2gpID0+IG5ldyBSZWdFeHAoYG1hbnlsaW51eFteL10qJHthcmNoID09PSBcIng2NFwiID8gXCJ4ODZfNjRcIiA6IFwiYWFyY2g2NFwifWApLnRlc3QobmFtZSkpXG4gICAgICAgICAgICAgIC5tYXAoKGFyY2gpID0+IGBsaW51eC0ke2FyY2h9YCk7XG4gICAgICBpZiAoIXNlbGVjdGVkLmxlbmd0aCkgcmV0dXJuIFtdO1xuICAgICAgaWYgKCEvXnNoYTI1NjpbYS1mMC05XXs2NH0kLy50ZXN0KGZpbGUuaGFzaCkpIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBsb2NrZWQgUHl0aG9uIGludGVncml0eTogJHtuYW1lfWApO1xuICAgICAgcmV0dXJuIFthcnRpZmFjdChmaWxlLnVybCwgc3JpKGZpbGUuaGFzaC5zbGljZSg3KSksIGBweXRob24vJHtuYW1lfWAsIHNlbGVjdGVkKV07XG4gICAgfSksXG4gICk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjb21wb3NlckNoZWNrSW5wdXRzKHJvb3Q6IHN0cmluZykge1xuICByZXR1cm4gW1wiLlwiLCBcInRvb2xzXCIsIFwidG9vbHMvY29tcGF0XCJdLmZsYXRNYXAoKGRpcmVjdG9yeSkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBqb2luKHJvb3QsIGRpcmVjdG9yeSk7XG4gICAgaWYgKCFleGlzdHNTeW5jKGpvaW4oYmFzZSwgXCJjb21wb3Nlci5sb2NrXCIpKSkgcmV0dXJuIFtdO1xuICAgIGNvbnN0IGxvY2sgPSByZWNvcmQoSlNPTi5wYXJzZSh0ZXh0KGJhc2UsIFwiY29tcG9zZXIubG9ja1wiKSksIFwiSW52YWxpZCBDb21wb3NlciBsb2NrXCIpO1xuICAgIGNvbnN0IGNoZWNrc3VtcyA9IHN0cmluZ1JlY29yZChKU09OLnBhcnNlKHRleHQoYmFzZSwgXCIuY29tcG9zZXIvY2hlY2tzdW1zLmpzb25cIikpLCBcIkludmFsaWQgQ29tcG9zZXIgY2hlY2tzdW1zXCIpO1xuICAgIHJldHVybiBbXG4gICAgICAuLi5yZWNvcmRzKGxvY2sucGFja2FnZXMsIFwiSW52YWxpZCBDb21wb3NlciBwYWNrYWdlc1wiKSxcbiAgICAgIC4uLnJlY29yZHMobG9ja1tcInBhY2thZ2VzLWRldlwiXSwgXCJJbnZhbGlkIENvbXBvc2VyIGRldiBwYWNrYWdlc1wiKSxcbiAgICBdXG4gICAgICAubWFwKChlbnRyeSkgPT4gKHsgZW50cnksIGRpc3Q6IHJlY29yZChlbnRyeS5kaXN0LCBcIk1pc3NpbmcgQ29tcG9zZXIgZGlzdHJpYnV0aW9uXCIpIH0pKVxuICAgICAgLmZpbHRlcigoeyBkaXN0IH0pID0+IGRpc3QudHlwZSAhPT0gXCJwYXRoXCIpXG4gICAgICAubWFwKCh7IGVudHJ5LCBkaXN0IH0pID0+ICh7XG4gICAgICAgIG5hbWU6IHN0cmluZyhlbnRyeS5uYW1lLCBcIk1pc3NpbmcgQ29tcG9zZXIgcGFja2FnZSBuYW1lXCIpLFxuICAgICAgICB2ZXJzaW9uOiBzdHJpbmcoZW50cnkudmVyc2lvbiwgXCJNaXNzaW5nIENvbXBvc2VyIHBhY2thZ2UgdmVyc2lvblwiKSxcbiAgICAgICAgZGlzdCxcbiAgICAgIH0pKVxuICAgICAgLm1hcCgoZW50cnkpID0+IHtcbiAgICAgICAgY29uc3QgcmVmZXJlbmNlID1cbiAgICAgICAgICBlbnRyeS5kaXN0LnJlZmVyZW5jZSA9PT0gdW5kZWZpbmVkIHx8IGVudHJ5LmRpc3QucmVmZXJlbmNlID09PSBudWxsXG4gICAgICAgICAgICA/IFwiXCJcbiAgICAgICAgICAgIDogc3RyaW5nKGVudHJ5LmRpc3QucmVmZXJlbmNlLCBcIkludmFsaWQgZGlzdHJpYnV0aW9uIHJlZmVyZW5jZVwiKTtcbiAgICAgICAgY29uc3Qga2V5ID0gYCR7ZW50cnkubmFtZX1AJHtlbnRyeS52ZXJzaW9ufSMke3JlZmVyZW5jZX1gO1xuICAgICAgICBjb25zdCBkaWdlc3QgPSBjaGVja3N1bXNba2V5XTtcbiAgICAgICAgaWYgKCFkaWdlc3QgfHwgIS9eW2EtZjAtOV17NjR9JC8udGVzdChkaWdlc3QpKSB0aHJvdyBuZXcgRXJyb3IoYE1pc3NpbmcgcmV2aWV3ZWQgQ29tcG9zZXIgaW50ZWdyaXR5OiAke2tleX1gKTtcbiAgICAgICAgcmV0dXJuIGFydGlmYWN0KFxuICAgICAgICAgIHN0cmluZyhlbnRyeS5kaXN0LnVybCwgXCJJbnZhbGlkIENvbXBvc2VyIFVSTFwiKSxcbiAgICAgICAgICBzcmkoZGlnZXN0KSxcbiAgICAgICAgICBgY29tcG9zZXIvJHtkaXJlY3RvcnkgPT09IFwiLlwiID8gXCJhcHBsaWNhdGlvblwiIDogZGlyZWN0b3J5fS8ke2VudHJ5Lm5hbWV9LyR7ZGlnZXN0fS56aXBgLFxuICAgICAgICApO1xuICAgICAgfSk7XG4gIH0pO1xufVxuXG4vKiogQSBidWlsZGVyIGNvbnN1bWVzIHRoZXNlIGRlcGVuZGVuY3kgaWRlbnRpdGllczsgZGVwZW5kZW5jeSByZXNvbHV0aW9uIHN0YXlzIGluIHRoZSBsYW5ndWFnZSdzIGxvY2suICovXG5leHBvcnQgZnVuY3Rpb24gbWFuYWdlZENoZWNrSW5wdXRzKHJvb3Q6IHN0cmluZykge1xuICBjb25zdCBpbnB1dHM6IE1hbmFnZWRTb3VyY2VbXSA9IFtdO1xuICBjb25zdCBzb3VyY2VIYXNoZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgZm9yIChjb25zdCBbZmlsZSwgZ2VuZXJhdGUsIHNvdXJjZXNdIG9mIFtcbiAgICBbXCJwbnBtLWxvY2sueWFtbFwiLCBucG1DaGVja0lucHV0cywgW1wicGFja2FnZS5qc29uXCIsIFwicG5wbS1sb2NrLnlhbWxcIiwgXCJwbnBtLXdvcmtzcGFjZS55YW1sXCIsIFwiLnBucG1maWxlLmNqc1wiXV0sXG4gICAgW1wiQ2FyZ28ubG9ja1wiLCBjYXJnb0NoZWNrSW5wdXRzLCBbXCJDYXJnby50b21sXCIsIFwiQ2FyZ28ubG9ja1wiXV0sXG4gICAgW1widXYubG9ja1wiLCBweXRob25DaGVja0lucHV0cywgW1wicHlwcm9qZWN0LnRvbWxcIiwgXCJ1di5sb2NrXCJdXSxcbiAgICBbXCJHZW1maWxlLmxvY2tcIiwgcnVieUNoZWNrSW5wdXRzLCBbXCJHZW1maWxlXCIsIFwiR2VtZmlsZS5sb2NrXCJdXSxcbiAgICBbXCIubXZuL2NoZWNrc3Vtcy9jaGVja3N1bXMuc2hhMjU2XCIsIG1hdmVuQ2hlY2tJbnB1dHMsIFtcInBvbS54bWxcIiwgXCIubXZuL2NoZWNrc3Vtcy9jaGVja3N1bXMuc2hhMjU2XCJdXSxcbiAgICBbXG4gICAgICBcImNvbXBvc2VyLmxvY2tcIixcbiAgICAgIGNvbXBvc2VyQ2hlY2tJbnB1dHMsXG4gICAgICBbXG4gICAgICAgIFwiY29tcG9zZXIuanNvblwiLFxuICAgICAgICBcImNvbXBvc2VyLmxvY2tcIixcbiAgICAgICAgXCIuY29tcG9zZXIvY2hlY2tzdW1zLmpzb25cIixcbiAgICAgICAgXCJ0b29scy9jb21wb3Nlci5qc29uXCIsXG4gICAgICAgIFwidG9vbHMvY29tcG9zZXIubG9ja1wiLFxuICAgICAgICBcInRvb2xzLy5jb21wb3Nlci9jaGVja3N1bXMuanNvblwiLFxuICAgICAgICBcInRvb2xzL2NvbXBhdC9jb21wb3Nlci5qc29uXCIsXG4gICAgICAgIFwidG9vbHMvY29tcGF0L2NvbXBvc2VyLmxvY2tcIixcbiAgICAgICAgXCJ0b29scy9jb21wYXQvLmNvbXBvc2VyL2NoZWNrc3Vtcy5qc29uXCIsXG4gICAgICBdLFxuICAgIF0sXG4gIF0gYXMgY29uc3QpIHtcbiAgICBpZiAoIWV4aXN0c1N5bmMoam9pbihyb290LCBmaWxlKSkpIGNvbnRpbnVlO1xuICAgIGlucHV0cy5wdXNoKC4uLmdlbmVyYXRlKHJvb3QpKTtcbiAgICBmb3IgKGNvbnN0IHNvdXJjZSBvZiBzb3VyY2VzKVxuICAgICAgaWYgKGV4aXN0c1N5bmMoam9pbihyb290LCBzb3VyY2UpKSlcbiAgICAgICAgc291cmNlSGFzaGVzW3NvdXJjZV0gPSBkZXBlbmRlbmN5SW5wdXRIYXNoKHNvdXJjZSwgcmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgc291cmNlKSkpO1xuICB9XG4gIGNvbnN0IGV4dHJhRmlsZSA9IGpvaW4ocm9vdCwgXCJtYW5hZ2VkLWV4dHJhLWlucHV0cy5qc29uXCIpO1xuICBpZiAoZXhpc3RzU3luYyhleHRyYUZpbGUpKSB7XG4gICAgY29uc3QgZXh0cmEgPSBtYW5hZ2VkRGVjbGFyYXRpb24oSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoZXh0cmFGaWxlLCBcInV0ZjhcIikpKTtcbiAgICBzb3VyY2VIYXNoZXNbXCJtYW5hZ2VkLWV4dHJhLWlucHV0cy5qc29uXCJdID0gc2hhMjU2KHJlYWRGaWxlU3luYyhleHRyYUZpbGUpKTtcbiAgICBpZiAoZXh0cmEuc2NoZW1hX3ZlcnNpb24gIT09IDEpIHRocm93IG5ldyBFcnJvcihcIlVua25vd24gbWFuYWdlZCBleHRyYS1pbnB1dCBzY2hlbWFcIik7XG4gICAgZm9yIChjb25zdCBbZmlsZSwgZXhwZWN0ZWRdIG9mIE9iamVjdC5lbnRyaWVzKGV4dHJhLnNvdXJjZV9oYXNoZXMpKSB7XG4gICAgICBpZiAoXG4gICAgICAgICFmaWxlIHx8XG4gICAgICAgIGZpbGUuc3RhcnRzV2l0aChcIi9cIikgfHxcbiAgICAgICAgZmlsZS5pbmNsdWRlcyhcIlxcXFxcIikgfHxcbiAgICAgICAgZmlsZS5zcGxpdChcIi9cIikuc29tZSgocGFydCkgPT4gIXBhcnQgfHwgcGFydCA9PT0gXCIuLlwiIHx8IHBhcnQgPT09IFwiLlwiKVxuICAgICAgKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJVbnNhZmUgc3VwcGxlbWVudGFsIHNvdXJjZSBwYXRoXCIpO1xuICAgICAgaWYgKGRlcGVuZGVuY3lJbnB1dEhhc2goZmlsZSwgcmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgZmlsZSkpKSAhPT0gZXhwZWN0ZWQpXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgJHtmaWxlfTogcmVmcmVzaCBkZXJpdmVkIG1hbmFnZWQgaW5wdXRzYCk7XG4gICAgICBzb3VyY2VIYXNoZXNbZmlsZV0gPSBleHBlY3RlZDtcbiAgICB9XG4gICAgaW5wdXRzLnB1c2goLi4uZXh0cmEuaW5wdXRzLm1hcCgoZW50cnkpID0+IGFydGlmYWN0KGVudHJ5LnVybCwgZW50cnkuaGFzaCwgZW50cnkuZGVzdGluYXRpb24sIGVudHJ5LnBsYXRmb3JtcykpKTtcbiAgfVxuICBjb25zdCBib290c3RyYXBGaWxlID0gam9pbihyb290LCBcIm1hbmFnZWQtYm9vdHN0cmFwLmpzb25cIik7XG4gIGNvbnN0IHJlZ2lzdHJ5RmlsZSA9IGpvaW4ocm9vdCwgXCJtYW5hZ2VkLXJlZ2lzdHJ5Lmpzb24uYnJcIik7XG4gIGNvbnN0IHJlZ2lzdHJ5ID0gZXhpc3RzU3luYyhyZWdpc3RyeUZpbGUpO1xuICBpZiAocmVnaXN0cnkpIHNvdXJjZUhhc2hlc1tcIm1hbmFnZWQtcmVnaXN0cnkuanNvbi5iclwiXSA9IHNoYTI1NihyZWFkRmlsZVN5bmMocmVnaXN0cnlGaWxlKSk7XG4gIGNvbnN0IGJvb3RzdHJhcCA9IGV4aXN0c1N5bmMoYm9vdHN0cmFwRmlsZSlcbiAgICA/IHJlY29yZChKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhib290c3RyYXBGaWxlLCBcInV0ZjhcIikpLCBcIkludmFsaWQgbWFuYWdlZCBib290c3RyYXBcIilcbiAgICA6IHVuZGVmaW5lZDtcbiAgaWYgKGJvb3RzdHJhcCkge1xuICAgIGlmIChib290c3RyYXAuc2NoZW1hX3ZlcnNpb24gIT09IDEpIHRocm93IG5ldyBFcnJvcihcIlVua25vd24gbWFuYWdlZCBib290c3RyYXAgc2NoZW1hXCIpO1xuICAgIHNvdXJjZUhhc2hlc1tcIm1hbmFnZWQtYm9vdHN0cmFwLmpzb25cIl0gPSBzaGEyNTYocmVhZEZpbGVTeW5jKGJvb3RzdHJhcEZpbGUpKTtcbiAgICBmb3IgKGNvbnN0IFtwYXRoLCBlbnRyeV0gb2YgT2JqZWN0LmVudHJpZXMoXG4gICAgICByZWNvcmQocmVjb3JkKGJvb3RzdHJhcC5wYWNrYWdlX2xvY2ssIFwiSW52YWxpZCBib290c3RyYXAgbG9ja1wiKS5wYWNrYWdlcywgXCJJbnZhbGlkIGJvb3RzdHJhcCBwYWNrYWdlc1wiKSxcbiAgICApKSB7XG4gICAgICBpZiAoIXBhdGgpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgdmFsdWUgPSByZWNvcmQoZW50cnksIFwiSW52YWxpZCBib290c3RyYXAgcGFja2FnZVwiKTtcbiAgICAgIGNvbnN0IHNlbGVjdGVkID0gcGxhdGZvcm1zKHBhY2thZ2VQbGF0Zm9ybSh2YWx1ZSkpO1xuICAgICAgaWYgKHNlbGVjdGVkLmxlbmd0aClcbiAgICAgICAgaW5wdXRzLnB1c2goXG4gICAgICAgICAgYXJ0aWZhY3QoXG4gICAgICAgICAgICBzdHJpbmcodmFsdWUucmVzb2x2ZWQsIFwiSW52YWxpZCBib290c3RyYXAgVVJMXCIpLFxuICAgICAgICAgICAgdmFsdWUuaW50ZWdyaXR5LFxuICAgICAgICAgICAgYGJvb3RzdHJhcC8ke3BhdGgucmVwbGFjZUFsbChcIi9cIiwgXCItXCIpfS50Z3pgLFxuICAgICAgICAgICAgc2VsZWN0ZWQsXG4gICAgICAgICAgKSxcbiAgICAgICAgKTtcbiAgICB9XG4gIH1cbiAgY29uc3QgZGVzdGluYXRpb25zID0gbmV3IE1hcDxzdHJpbmcsIE1hbmFnZWRTb3VyY2U+KCk7XG4gIGZvciAoY29uc3QgZW50cnkgb2YgaW5wdXRzKSB7XG4gICAgY29uc3QgcHJldmlvdXMgPSBkZXN0aW5hdGlvbnMuZ2V0KGVudHJ5LmRlc3RpbmF0aW9uKTtcbiAgICBpZiAocHJldmlvdXMgJiYgSlNPTi5zdHJpbmdpZnkocHJldmlvdXMpICE9PSBKU09OLnN0cmluZ2lmeShlbnRyeSkpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbmZsaWN0aW5nIG1hbmFnZWQgaW5wdXQ6ICR7ZW50cnkuZGVzdGluYXRpb259YCk7XG4gICAgZGVzdGluYXRpb25zLnNldChlbnRyeS5kZXN0aW5hdGlvbiwgZW50cnkpO1xuICB9XG4gIHJldHVybiBtYW5hZ2VkRGVjbGFyYXRpb24oe1xuICAgIHNjaGVtYV92ZXJzaW9uOiAxLFxuICAgIHNvdXJjZV9oYXNoZXM6IE9iamVjdC5mcm9tRW50cmllcyhPYmplY3QuZW50cmllcyhzb3VyY2VIYXNoZXMpLnNvcnQoKSksXG4gICAgLi4uKGJvb3RzdHJhcCA/IHsgYm9vdHN0cmFwOiB0cnVlIH0gOiB7fSksXG4gICAgLi4uKHJlZ2lzdHJ5ID8geyByZWdpc3RyeTogdHJ1ZSB9IDoge30pLFxuICAgIGlucHV0czogWy4uLmRlc3RpbmF0aW9ucy52YWx1ZXMoKV0uc29ydCgoYSwgYikgPT5cbiAgICAgIGEuZGVzdGluYXRpb24gPCBiLmRlc3RpbmF0aW9uID8gLTEgOiBhLmRlc3RpbmF0aW9uID4gYi5kZXN0aW5hdGlvbiA/IDEgOiAwLFxuICAgICksXG4gIH0pO1xufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxVQUFVLFFBQVEsU0FBUyxRQUFRLFNBQVMsb0JBQW9CO0FBQ3pFLFNBQVMsMkJBQTJCO0FBQ3BDLFNBQTZCLGVBQWUsMEJBQTBCO0FBeUJ0RSxTQUFTLGtCQUFrQjtBQUMzQixTQUFTLFlBQVksb0JBQW9CO0FBQ3pDLFNBQVMsVUFBVSxZ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QUFtQixFQUFHLE9BQU0sSUFBSSxNQUFNLGtDQUFrQztBQUN0RixpQkFBYSx3QkFBd0IsSUFBSSxPQUFPLGFBQWEsYUFBYSxDQUFDO0FBQzNFLGVBQVcsQ0FBQyxNQUFNLEtBQUssS0FBSyxPQUFPO0FBQUEsTUFDakMsT0FBTyxPQUFPLFVBQVUsY0FBYyx3QkFBd0IsRUFBRSxVQUFVLDRCQUE0QjtBQUFBLElBQ3hHLEdBQUc7QUFDRCxVQUFJLENBQUMsS0FBTTtBQUNYLFlBQU0sUUFBUSxPQUFPLE9BQU8sMkJBQTJCO0FBQ3ZELFlBQU0sV0FBVyxVQUFVLGdCQUFnQixLQUFLLENBQUM7QUFDakQsVUFBSSxTQUFTO0FBQ1gsZUFBTztBQUFBLFVBQ0w7QUFBQSxZQUNFLE9BQU8sTUFBTSxVQUFVLHVCQUF1QjtBQUFBLFlBQzlDLE1BQU07QUFBQSxZQUNOLGFBQWEsS0FBSyxXQUFXLEtBQUssR0FBRyxDQUFDO0FBQUEsWUFDdEM7QUFBQSxVQUNGO0FBQUEsUUFDRjtBQUFBLElBQ0o7QUFBQSxFQUNGO0FBQ0EsUUFBTSxlQUFlLG9CQUFJLElBQTJCO0FBQ3BELGFBQVcsU0FBUyxRQUFRO0FBQzFCLFVBQU0sV0FBVyxhQUFhLElBQUksTUFBTSxXQUFXO0FBQ25ELFFBQUksWUFBWSxLQUFLLFVBQVUsUUFBUSxNQUFNLEtBQUssVUFBVSxLQUFLO0FBQy9ELFlBQU0sSUFBSSxNQUFNLDhCQUE4QixNQUFNLFdBQVcsRUFBRTtBQUNuRSxpQkFBYSxJQUFJLE1BQU0sYUFBYSxLQUFLO0FBQUEsRUFDM0M7QUFDQSxTQUFPLG1CQUFtQjtBQUFBLElBQ3hCLGdCQUFnQjtBQUFBLElBQ2hCLGVBQWUsT0FBTyxZQUFZLE9BQU8sUUFBUSxZQUFZLEVBQUUsS0FBSyxDQUFDO0FBQUEsSUFDckUsR0FBSSxZQUFZLEVBQUUsV0FBVyxLQUFLLElBQUksQ0FBQztBQUFBLElBQ3ZDLEdBQUksV0FBVyxFQUFFLFVBQVUsS0FBSyxJQUFJLENBQUM7QUFBQSxJQUNyQyxRQUFRLENBQUMsR0FBRyxhQUFhLE9BQU8sQ0FBQyxFQUFFO0FBQUEsTUFBSyxDQUFDLEdBQUcsTUFDMUMsRUFBRSxjQUFjLEVBQUUsY0FBYyxLQUFLLEVBQUUsY0FBYyxFQUFFLGNBQWMsSUFBSTtBQUFBLElBQzNFO0FBQUEsRUFDRixDQUFDO0FBQ0g7IiwibmFtZXMiOlsicGxhdGZvcm1zIl0sImZpbGUiOiJzY3JpcHRzL21hbmFnZWQtY2hlY2staW5wdXRzLm1qcyJ9
