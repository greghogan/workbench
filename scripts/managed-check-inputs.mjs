// Generated from managed-check-inputs.mts; edit the TypeScript source.
import { required, record, records, string, strings, stringRecord } from "./values.mjs";
import { managedSource, managedDeclaration } from "./managed-source-contract.mjs";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseToml } from "smol-toml";
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
      if (existsSync(join(root, source))) sourceHashes[source] = sha256(readFileSync(join(root, source)));
  }
  const extraFile = join(root, "managed-extra-inputs.json");
  if (existsSync(extraFile)) {
    const extra = managedDeclaration(JSON.parse(readFileSync(extraFile, "utf8")));
    sourceHashes["managed-extra-inputs.json"] = sha256(readFileSync(extraFile));
    if (extra.schema_version !== 1) throw new Error("Unknown managed extra-input schema");
    for (const [file, expected] of Object.entries(extra.source_hashes)) {
      if (!file || file.startsWith("/") || file.includes("\\") || file.split("/").some((part) => !part || part === ".." || part === "."))
        throw new Error("Unsafe supplemental source path");
      if (sha256(readFileSync(join(root, file))) !== expected)
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1hbmFnZWQtY2hlY2staW5wdXRzLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyByZXF1aXJlZCwgcmVjb3JkLCByZWNvcmRzLCBzdHJpbmcsIHN0cmluZ3MsIHN0cmluZ1JlY29yZCB9IGZyb20gXCIuL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB0eXBlIHsgTWFuYWdlZFNvdXJjZSB9IGZyb20gXCIuL21hbmFnZWQtc291cmNlLWNvbnRyYWN0Lm1qc1wiO1xuZXhwb3J0IGludGVyZmFjZSBQYWNrYWdlUGxhdGZvcm0ge1xuICBvcz86IHN0cmluZ1tdO1xuICBjcHU/OiBzdHJpbmdbXTtcbiAgbGliYz86IHN0cmluZ1tdO1xufVxuZXhwb3J0IGludGVyZmFjZSBOcG1Mb2NrZWRQYWNrYWdlIGV4dGVuZHMgUGFja2FnZVBsYXRmb3JtIHtcbiAgcmVzb2x1dGlvbj86IHsgdGFyYmFsbD86IHN0cmluZzsgaW50ZWdyaXR5Pzogc3RyaW5nIH07XG59XG5leHBvcnQgaW50ZXJmYWNlIE5wbUxvY2sge1xuICBwYWNrYWdlcz86IFJlY29yZDxzdHJpbmcsIE5wbUxvY2tlZFBhY2thZ2U+O1xufVxuZXhwb3J0IGludGVyZmFjZSBCb290c3RyYXBQYWNrYWdlIGV4dGVuZHMgUGFja2FnZVBsYXRmb3JtIHtcbiAgdmVyc2lvbjogc3RyaW5nO1xuICByZXNvbHZlZDogc3RyaW5nO1xuICBpbnRlZ3JpdHk6IHN0cmluZztcbn1cbmV4cG9ydCBpbnRlcmZhY2UgTWFuYWdlZEJvb3RzdHJhcCB7XG4gIHNjaGVtYV92ZXJzaW9uOiBudW1iZXI7XG4gIHBhY2thZ2VfanNvbjogdW5rbm93bjtcbiAgcGFja2FnZV9sb2NrOiB7IHBhY2thZ2VzOiBSZWNvcmQ8c3RyaW5nLCBCb290c3RyYXBQYWNrYWdlPiB9O1xuICBwcm9vZnM6IHVua25vd25bXTtcbn1cbmltcG9ydCB0eXBlIHsgQmluYXJ5TGlrZSB9IGZyb20gXCJjcnlwdG9cIjtcbmltcG9ydCB7IG1hbmFnZWRTb3VyY2UsIG1hbmFnZWREZWNsYXJhdGlvbiB9IGZyb20gXCIuL21hbmFnZWQtc291cmNlLWNvbnRyYWN0Lm1qc1wiO1xuaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgcGFyc2UgYXMgcGFyc2VUb21sIH0gZnJvbSBcInNtb2wtdG9tbFwiO1xuaW1wb3J0IHsgcG5wbVBhY2thZ2VzLCBwbnBtSWRlbnRpdHkgfSBmcm9tIFwiLi9wbnBtLWxvY2subWpzXCI7XG5cbmZ1bmN0aW9uIHBhY2thZ2VQbGF0Zm9ybSh2YWx1ZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBQYWNrYWdlUGxhdGZvcm0ge1xuICByZXR1cm4gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgIFtcIm9zXCIsIFwiY3B1XCIsIFwibGliY1wiXS5mbGF0TWFwKChrZXkpID0+XG4gICAgICB2YWx1ZVtrZXldID09PSB1bmRlZmluZWQgPyBbXSA6IFtba2V5LCBzdHJpbmdzKHZhbHVlW2tleV0sIFwiSW52YWxpZCBwYWNrYWdlIHBsYXRmb3JtXCIpXV0sXG4gICAgKSxcbiAgKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlYWROcG1Mb2NrKHZhbHVlOiB1bmtub3duKTogTnBtTG9jayB7XG4gIGNvbnN0IGRvY3VtZW50ID0gcmVjb3JkKHZhbHVlLCBcIkludmFsaWQgbnBtIGxvY2sgZG9jdW1lbnRcIik7XG4gIHJldHVybiB7XG4gICAgcGFja2FnZXM6IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgIE9iamVjdC5lbnRyaWVzKHJlY29yZChkb2N1bWVudC5wYWNrYWdlcyA/PyB7fSwgXCJJbnZhbGlkIG5wbSBsb2NrIHBhY2thZ2VzXCIpKS5tYXAoKFtuYW1lLCByYXddKSA9PiB7XG4gICAgICAgIGNvbnN0IGVudHJ5ID0gcmVjb3JkKHJhdywgXCJJbnZhbGlkIG5wbSBsb2NrIHBhY2thZ2VcIik7XG4gICAgICAgIGNvbnN0IHJlc29sdXRpb24gPVxuICAgICAgICAgIGVudHJ5LnJlc29sdXRpb24gPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IHJlY29yZChlbnRyeS5yZXNvbHV0aW9uLCBcIkludmFsaWQgcGFja2FnZSByZXNvbHV0aW9uXCIpO1xuICAgICAgICByZXR1cm4gW1xuICAgICAgICAgIG5hbWUsXG4gICAgICAgICAge1xuICAgICAgICAgICAgLi4ucGFja2FnZVBsYXRmb3JtKGVudHJ5KSxcbiAgICAgICAgICAgIC4uLihyZXNvbHV0aW9uXG4gICAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgICAgcmVzb2x1dGlvbjoge1xuICAgICAgICAgICAgICAgICAgICAuLi4ocmVzb2x1dGlvbi50YXJiYWxsID09PSB1bmRlZmluZWRcbiAgICAgICAgICAgICAgICAgICAgICA/IHt9XG4gICAgICAgICAgICAgICAgICAgICAgOiB7IHRhcmJhbGw6IHN0cmluZyhyZXNvbHV0aW9uLnRhcmJhbGwsIFwiSW52YWxpZCBwYWNrYWdlIHRhcmJhbGxcIikgfSksXG4gICAgICAgICAgICAgICAgICAgIC4uLihyZXNvbHV0aW9uLmludGVncml0eSA9PT0gdW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgICAgICAgPyB7fVxuICAgICAgICAgICAgICAgICAgICAgIDogeyBpbnRlZ3JpdHk6IHN0cmluZyhyZXNvbHV0aW9uLmludGVncml0eSwgXCJJbnZhbGlkIHBhY2thZ2UgaW50ZWdyaXR5XCIpIH0pLFxuICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgIH0sXG4gICAgICAgIF07XG4gICAgICB9KSxcbiAgICApLFxuICB9O1xufVxuXG5jb25zdCBzaGEyNTYgPSAoYnl0ZXM6IEJpbmFyeUxpa2UpID0+IGNyZWF0ZUhhc2goXCJzaGEyNTZcIikudXBkYXRlKGJ5dGVzKS5kaWdlc3QoXCJoZXhcIik7XG5jb25zdCBzcmkgPSAoaGV4OiBzdHJpbmcpID0+IGBzaGEyNTYtJHtCdWZmZXIuZnJvbShoZXgsIFwiaGV4XCIpLnRvU3RyaW5nKFwiYmFzZTY0XCIpfWA7XG5jb25zdCB0ZXh0ID0gKHJvb3Q6IHN0cmluZywgbmFtZTogc3RyaW5nKSA9PiByZWFkRmlsZVN5bmMoam9pbihyb290LCBuYW1lKSwgXCJ1dGY4XCIpO1xuXG5mdW5jdGlvbiBhcnRpZmFjdCh1cmw6IHN0cmluZywgaGFzaDogdW5rbm93biwgZGVzdGluYXRpb246IHN0cmluZywgcGxhdGZvcm1zPzogc3RyaW5nW10pIHtcbiAgcmV0dXJuIG1hbmFnZWRTb3VyY2UoeyB1cmwsIGhhc2gsIGRlc3RpbmF0aW9uLCAuLi4ocGxhdGZvcm1zID8geyBwbGF0Zm9ybXMgfSA6IHt9KSB9KTtcbn1cblxuZnVuY3Rpb24gcGxhdGZvcm1zKGVudHJ5OiBQYWNrYWdlUGxhdGZvcm0pIHtcbiAgY29uc3QgYWNjZXB0cyA9ICh2YWx1ZXM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkLCBzZWxlY3RlZDogc3RyaW5nKSA9PlxuICAgICF2YWx1ZXMgfHxcbiAgICAoIXZhbHVlcy5pbmNsdWRlcyhgISR7c2VsZWN0ZWR9YCkgJiZcbiAgICAgICghdmFsdWVzLnNvbWUoKHZhbHVlOiBzdHJpbmcpID0+ICF2YWx1ZS5zdGFydHNXaXRoKFwiIVwiKSkgfHwgdmFsdWVzLmluY2x1ZGVzKHNlbGVjdGVkKSkpO1xuICByZXR1cm4gW1wieDY0XCIsIFwiYXJtNjRcIl1cbiAgICAuZmlsdGVyKChhcmNoKSA9PiBhY2NlcHRzKGVudHJ5Lm9zLCBcImxpbnV4XCIpICYmIGFjY2VwdHMoZW50cnkuY3B1LCBhcmNoKSAmJiBhY2NlcHRzKGVudHJ5LmxpYmMsIFwiZ2xpYmNcIikpXG4gICAgLm1hcCgoYXJjaCkgPT4gYGxpbnV4LSR7YXJjaH1gKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5wbUNoZWNrSW5wdXRzKHJvb3Q6IHN0cmluZykge1xuICBjb25zdCBwYWNrYWdlcyA9IHJlYWROcG1Mb2NrKHsgcGFja2FnZXM6IHBucG1QYWNrYWdlcyh0ZXh0KHJvb3QsIFwicG5wbS1sb2NrLnlhbWxcIikpIH0pLnBhY2thZ2VzID8/IHt9O1xuICByZXR1cm4gT2JqZWN0LmVudHJpZXMocGFja2FnZXMpLmZsYXRNYXAoKFtrZXksIGVudHJ5XSkgPT4ge1xuICAgIGNvbnN0IHNlbGVjdGVkID0gcGxhdGZvcm1zKGVudHJ5KTtcbiAgICBpZiAoIXNlbGVjdGVkLmxlbmd0aCkgcmV0dXJuIFtdO1xuICAgIGNvbnN0IHsgbmFtZSwgdmVyc2lvbiB9ID0gcG5wbUlkZW50aXR5KGtleSk7XG4gICAgaWYgKCEvXltBLVphLXowLTkuK18tXSskLy50ZXN0KHZlcnNpb24pIHx8ICEvXihAW2EtejAtOS5fLV0rXFwvKT9bYS16MC05Ll8tXSskLy50ZXN0KG5hbWUpKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbnN1cHBvcnRlZCBsb2NrZWQgbnBtIHNvdXJjZTogJHtrZXl9YCk7XG4gICAgY29uc3QgdXJsID1cbiAgICAgIGVudHJ5LnJlc29sdXRpb24/LnRhcmJhbGwgPz9cbiAgICAgIGBodHRwczovL3JlZ2lzdHJ5Lm5wbWpzLm9yZy8ke25hbWV9Ly0vJHtTdHJpbmcobmFtZS5zcGxpdChcIi9cIikuYXQoLTEpKX0tJHt2ZXJzaW9ufS50Z3pgO1xuICAgIHJldHVybiBbYXJ0aWZhY3QodXJsLCBlbnRyeS5yZXNvbHV0aW9uPy5pbnRlZ3JpdHksIGBucG0vJHtuYW1lLnJlcGxhY2VBbGwoXCIvXCIsIFwiLVwiKX0tJHt2ZXJzaW9ufS50Z3pgLCBzZWxlY3RlZCldO1xuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1hdmVuQ2hlY2tJbnB1dHMocm9vdDogc3RyaW5nKSB7XG4gIHJldHVybiB0ZXh0KHJvb3QsIFwiLm12bi9jaGVja3N1bXMvY2hlY2tzdW1zLnNoYTI1NlwiKVxuICAgIC50cmltKClcbiAgICAuc3BsaXQoXCJcXG5cIilcbiAgICAubWFwKChsaW5lKSA9PiB7XG4gICAgICBjb25zdCBtYXRjaCA9IC9eKFthLWYwLTldezY0fSkgezJ9KFtBLVphLXowLTkuXysvLV0rKSQvLmV4ZWMobGluZSk7XG4gICAgICBpZiAoIW1hdGNoKSB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIGxvY2tlZCBNYXZlbiBjaGVja3N1bVwiKTtcbiAgICAgIHJldHVybiBhcnRpZmFjdChcbiAgICAgICAgYGh0dHBzOi8vbWF2ZW4tY2VudHJhbC5zdG9yYWdlLWRvd25sb2FkLmdvb2dsZWFwaXMuY29tL21hdmVuMi8ke1N0cmluZyhtYXRjaFsyXSl9YCxcbiAgICAgICAgc3JpKHJlcXVpcmVkKG1hdGNoWzFdLCBcIk1pc3NpbmcgTWF2ZW4gY2hlY2tzdW1cIikpLFxuICAgICAgICBgbWF2ZW4vJHtTdHJpbmcobWF0Y2hbMl0pfWAsXG4gICAgICApO1xuICAgIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcnVieUNoZWNrSW5wdXRzKHJvb3Q6IHN0cmluZykge1xuICBjb25zdCBsb2NrID0gdGV4dChyb290LCBcIkdlbWZpbGUubG9ja1wiKTtcbiAgY29uc3Qgc2VjdGlvbiA9IC8oPzpefFxcbilDSEVDS1NVTVNcXG4oW1xcc1xcU10qPykoPz1cXG5bQS1aXXwkKS8uZXhlYyhsb2NrKT8uWzFdO1xuICBpZiAoIXNlY3Rpb24pIHRocm93IG5ldyBFcnJvcihcIk1hbmFnZWQgZ2VtcyByZXF1aXJlIHRoZSBsb2NrJ3MgQ0hFQ0tTVU1TIHNlY3Rpb25cIik7XG4gIHJldHVybiBbLi4uc2VjdGlvbi5tYXRjaEFsbCgvXiB7Mn0oW0EtWmEtejAtOS5fLV0rKSBcXCgoW14pXSspXFwpIHNoYTI1Nj0oW2EtZjAtOV17NjR9KSQvZ20pXS5mbGF0TWFwKChtYXRjaCkgPT4ge1xuICAgIGNvbnN0IHZlcnNpb24gPSByZXF1aXJlZChtYXRjaFsyXSwgXCJNaXNzaW5nIGdlbSB2ZXJzaW9uXCIpLFxuICAgICAgcGxhdGZvcm0gPSB2ZXJzaW9uLnJlcGxhY2UoL15bMC05XSsoPzpcXC5bMC05XSspKig/OlxcLnByZVxcLlswLTldKyk/LywgXCJcIik7XG4gICAgY29uc3Qgc2VsZWN0ZWQgPSAhcGxhdGZvcm1cbiAgICAgID8gW1wibGludXgteDY0XCIsIFwibGludXgtYXJtNjRcIl1cbiAgICAgIDogcGxhdGZvcm0gPT09IFwiLXg4Nl82NC1saW51eC1nbnVcIlxuICAgICAgICA/IFtcImxpbnV4LXg2NFwiXVxuICAgICAgICA6IHBsYXRmb3JtID09PSBcIi1hYXJjaDY0LWxpbnV4LWdudVwiXG4gICAgICAgICAgPyBbXCJsaW51eC1hcm02NFwiXVxuICAgICAgICAgIDogW107XG4gICAgaWYgKCFzZWxlY3RlZC5sZW5ndGgpIHJldHVybiBbXTtcbiAgICBjb25zdCBuYW1lID0gYCR7U3RyaW5nKG1hdGNoWzFdKX0tJHt2ZXJzaW9ufS5nZW1gO1xuICAgIHJldHVybiBbXG4gICAgICBhcnRpZmFjdChcbiAgICAgICAgYGh0dHBzOi8vcnVieWdlbXMub3JnL2Rvd25sb2Fkcy8ke25hbWV9YCxcbiAgICAgICAgc3JpKHJlcXVpcmVkKG1hdGNoWzNdLCBcIk1pc3NpbmcgZ2VtIGNoZWNrc3VtXCIpKSxcbiAgICAgICAgYGdlbXMvJHtuYW1lfWAsXG4gICAgICAgIHNlbGVjdGVkLFxuICAgICAgKSxcbiAgICBdO1xuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNhcmdvQ2hlY2tJbnB1dHMocm9vdDogc3RyaW5nKSB7XG4gIGNvbnN0IGxvY2sgPSBwYXJzZVRvbWwodGV4dChyb290LCBcIkNhcmdvLmxvY2tcIikpO1xuICByZXR1cm4gcmVjb3Jkcyhsb2NrLnBhY2thZ2UsIFwiSW52YWxpZCBDYXJnbyBsb2NrIHBhY2thZ2VzXCIpXG4gICAgLmZpbHRlcigoZW50cnkpID0+IGVudHJ5LnNvdXJjZSlcbiAgICAubWFwKChlbnRyeSkgPT4ge1xuICAgICAgaWYgKFxuICAgICAgICBlbnRyeS5zb3VyY2UgIT09IFwicmVnaXN0cnkraHR0cHM6Ly9naXRodWIuY29tL3J1c3QtbGFuZy9jcmF0ZXMuaW8taW5kZXhcIiB8fFxuICAgICAgICB0eXBlb2YgZW50cnkuY2hlY2tzdW0gIT09IFwic3RyaW5nXCIgfHxcbiAgICAgICAgIS9eW2EtZjAtOV17NjR9JC8udGVzdChlbnRyeS5jaGVja3N1bSlcbiAgICAgIClcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbnN1cHBvcnRlZCBsb2NrZWQgQ2FyZ28gc291cmNlOiAke1N0cmluZyhlbnRyeS5uYW1lKX1gKTtcbiAgICAgIGNvbnN0IGNyYXRlID0gc3RyaW5nKGVudHJ5Lm5hbWUsIFwiTWlzc2luZyBjcmF0ZSBuYW1lXCIpLFxuICAgICAgICB2ZXJzaW9uID0gc3RyaW5nKGVudHJ5LnZlcnNpb24sIFwiTWlzc2luZyBjcmF0ZSB2ZXJzaW9uXCIpO1xuICAgICAgY29uc3QgbmFtZSA9IGAke2NyYXRlfS0ke3ZlcnNpb259LmNyYXRlYDtcbiAgICAgIHJldHVybiBhcnRpZmFjdChgaHR0cHM6Ly9zdGF0aWMuY3JhdGVzLmlvL2NyYXRlcy8ke2NyYXRlfS8ke25hbWV9YCwgc3JpKGVudHJ5LmNoZWNrc3VtKSwgYGNhcmdvLyR7bmFtZX1gKTtcbiAgICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHB5dGhvbkNoZWNrSW5wdXRzKHJvb3Q6IHN0cmluZykge1xuICBjb25zdCBsb2NrID0gcGFyc2VUb21sKHRleHQocm9vdCwgXCJ1di5sb2NrXCIpKTtcbiAgcmV0dXJuIHJlY29yZHMobG9jay5wYWNrYWdlLCBcIkludmFsaWQgUHl0aG9uIGxvY2sgcGFja2FnZXNcIikuZmxhdE1hcCgoZW50cnkpID0+XG4gICAgW1xuICAgICAgLi4uKGVudHJ5LnNkaXN0ID09PSB1bmRlZmluZWQgPyBbXSA6IFtyZWNvcmQoZW50cnkuc2Rpc3QsIFwiSW52YWxpZCBzb3VyY2UgZGlzdHJpYnV0aW9uXCIpXSksXG4gICAgICAuLi5yZWNvcmRzKGVudHJ5LndoZWVscyA/PyBbXSwgXCJJbnZhbGlkIGxvY2tlZCB3aGVlbHNcIiksXG4gICAgXS5mbGF0TWFwKCh2YWx1ZSkgPT4ge1xuICAgICAgY29uc3QgZmlsZSA9IHtcbiAgICAgICAgdXJsOiBzdHJpbmcodmFsdWUudXJsLCBcIkludmFsaWQgUHl0aG9uIGFydGlmYWN0IFVSTFwiKSxcbiAgICAgICAgaGFzaDogc3RyaW5nKHZhbHVlLmhhc2gsIFwiSW52YWxpZCBQeXRob24gYXJ0aWZhY3QgaGFzaFwiKSxcbiAgICAgIH07XG4gICAgICBjb25zdCBuYW1lID0gYmFzZW5hbWUobmV3IFVSTChmaWxlLnVybCkucGF0aG5hbWUpO1xuICAgICAgY29uc3Qgc2VsZWN0ZWQgPVxuICAgICAgICAhbmFtZS5lbmRzV2l0aChcIi53aGxcIikgfHwgbmFtZS5lbmRzV2l0aChcIi1hbnkud2hsXCIpXG4gICAgICAgICAgPyBbXCJsaW51eC14NjRcIiwgXCJsaW51eC1hcm02NFwiXVxuICAgICAgICAgIDogW1wieDY0XCIsIFwiYXJtNjRcIl1cbiAgICAgICAgICAgICAgLmZpbHRlcigoYXJjaCkgPT4gbmV3IFJlZ0V4cChgbWFueWxpbnV4W14vXSoke2FyY2ggPT09IFwieDY0XCIgPyBcIng4Nl82NFwiIDogXCJhYXJjaDY0XCJ9YCkudGVzdChuYW1lKSlcbiAgICAgICAgICAgICAgLm1hcCgoYXJjaCkgPT4gYGxpbnV4LSR7YXJjaH1gKTtcbiAgICAgIGlmICghc2VsZWN0ZWQubGVuZ3RoKSByZXR1cm4gW107XG4gICAgICBpZiAoIS9ec2hhMjU2OlthLWYwLTldezY0fSQvLnRlc3QoZmlsZS5oYXNoKSkgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGxvY2tlZCBQeXRob24gaW50ZWdyaXR5OiAke25hbWV9YCk7XG4gICAgICByZXR1cm4gW2FydGlmYWN0KGZpbGUudXJsLCBzcmkoZmlsZS5oYXNoLnNsaWNlKDcpKSwgYHB5dGhvbi8ke25hbWV9YCwgc2VsZWN0ZWQpXTtcbiAgICB9KSxcbiAgKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNvbXBvc2VyQ2hlY2tJbnB1dHMocm9vdDogc3RyaW5nKSB7XG4gIHJldHVybiBbXCIuXCIsIFwidG9vbHNcIiwgXCJ0b29scy9jb21wYXRcIl0uZmxhdE1hcCgoZGlyZWN0b3J5KSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGpvaW4ocm9vdCwgZGlyZWN0b3J5KTtcbiAgICBpZiAoIWV4aXN0c1N5bmMoam9pbihiYXNlLCBcImNvbXBvc2VyLmxvY2tcIikpKSByZXR1cm4gW107XG4gICAgY29uc3QgbG9jayA9IHJlY29yZChKU09OLnBhcnNlKHRleHQoYmFzZSwgXCJjb21wb3Nlci5sb2NrXCIpKSwgXCJJbnZhbGlkIENvbXBvc2VyIGxvY2tcIik7XG4gICAgY29uc3QgY2hlY2tzdW1zID0gc3RyaW5nUmVjb3JkKEpTT04ucGFyc2UodGV4dChiYXNlLCBcIi5jb21wb3Nlci9jaGVja3N1bXMuanNvblwiKSksIFwiSW52YWxpZCBDb21wb3NlciBjaGVja3N1bXNcIik7XG4gICAgcmV0dXJuIFtcbiAgICAgIC4uLnJlY29yZHMobG9jay5wYWNrYWdlcywgXCJJbnZhbGlkIENvbXBvc2VyIHBhY2thZ2VzXCIpLFxuICAgICAgLi4ucmVjb3Jkcyhsb2NrW1wicGFja2FnZXMtZGV2XCJdLCBcIkludmFsaWQgQ29tcG9zZXIgZGV2IHBhY2thZ2VzXCIpLFxuICAgIF1cbiAgICAgIC5tYXAoKGVudHJ5KSA9PiAoeyBlbnRyeSwgZGlzdDogcmVjb3JkKGVudHJ5LmRpc3QsIFwiTWlzc2luZyBDb21wb3NlciBkaXN0cmlidXRpb25cIikgfSkpXG4gICAgICAuZmlsdGVyKCh7IGRpc3QgfSkgPT4gZGlzdC50eXBlICE9PSBcInBhdGhcIilcbiAgICAgIC5tYXAoKHsgZW50cnksIGRpc3QgfSkgPT4gKHtcbiAgICAgICAgbmFtZTogc3RyaW5nKGVudHJ5Lm5hbWUsIFwiTWlzc2luZyBDb21wb3NlciBwYWNrYWdlIG5hbWVcIiksXG4gICAgICAgIHZlcnNpb246IHN0cmluZyhlbnRyeS52ZXJzaW9uLCBcIk1pc3NpbmcgQ29tcG9zZXIgcGFja2FnZSB2ZXJzaW9uXCIpLFxuICAgICAgICBkaXN0LFxuICAgICAgfSkpXG4gICAgICAubWFwKChlbnRyeSkgPT4ge1xuICAgICAgICBjb25zdCByZWZlcmVuY2UgPVxuICAgICAgICAgIGVudHJ5LmRpc3QucmVmZXJlbmNlID09PSB1bmRlZmluZWQgfHwgZW50cnkuZGlzdC5yZWZlcmVuY2UgPT09IG51bGxcbiAgICAgICAgICAgID8gXCJcIlxuICAgICAgICAgICAgOiBzdHJpbmcoZW50cnkuZGlzdC5yZWZlcmVuY2UsIFwiSW52YWxpZCBkaXN0cmlidXRpb24gcmVmZXJlbmNlXCIpO1xuICAgICAgICBjb25zdCBrZXkgPSBgJHtlbnRyeS5uYW1lfUAke2VudHJ5LnZlcnNpb259IyR7cmVmZXJlbmNlfWA7XG4gICAgICAgIGNvbnN0IGRpZ2VzdCA9IGNoZWNrc3Vtc1trZXldO1xuICAgICAgICBpZiAoIWRpZ2VzdCB8fCAhL15bYS1mMC05XXs2NH0kLy50ZXN0KGRpZ2VzdCkpIHRocm93IG5ldyBFcnJvcihgTWlzc2luZyByZXZpZXdlZCBDb21wb3NlciBpbnRlZ3JpdHk6ICR7a2V5fWApO1xuICAgICAgICByZXR1cm4gYXJ0aWZhY3QoXG4gICAgICAgICAgc3RyaW5nKGVudHJ5LmRpc3QudXJsLCBcIkludmFsaWQgQ29tcG9zZXIgVVJMXCIpLFxuICAgICAgICAgIHNyaShkaWdlc3QpLFxuICAgICAgICAgIGBjb21wb3Nlci8ke2RpcmVjdG9yeSA9PT0gXCIuXCIgPyBcImFwcGxpY2F0aW9uXCIgOiBkaXJlY3Rvcnl9LyR7ZW50cnkubmFtZX0vJHtkaWdlc3R9LnppcGAsXG4gICAgICAgICk7XG4gICAgICB9KTtcbiAgfSk7XG59XG5cbi8qKiBBIGJ1aWxkZXIgY29uc3VtZXMgZXhhY3RseSB0aGVzZSBzb3VyY2UgYnl0ZXM7IGRlcGVuZGVuY3kgcmVzb2x1dGlvbiBzdGF5cyBpbiB0aGUgbGFuZ3VhZ2UncyBsb2NrLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1hbmFnZWRDaGVja0lucHV0cyhyb290OiBzdHJpbmcpIHtcbiAgY29uc3QgaW5wdXRzOiBNYW5hZ2VkU291cmNlW10gPSBbXTtcbiAgY29uc3Qgc291cmNlSGFzaGVzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gIGZvciAoY29uc3QgW2ZpbGUsIGdlbmVyYXRlLCBzb3VyY2VzXSBvZiBbXG4gICAgW1wicG5wbS1sb2NrLnlhbWxcIiwgbnBtQ2hlY2tJbnB1dHMsIFtcInBhY2thZ2UuanNvblwiLCBcInBucG0tbG9jay55YW1sXCIsIFwicG5wbS13b3Jrc3BhY2UueWFtbFwiLCBcIi5wbnBtZmlsZS5janNcIl1dLFxuICAgIFtcIkNhcmdvLmxvY2tcIiwgY2FyZ29DaGVja0lucHV0cywgW1wiQ2FyZ28udG9tbFwiLCBcIkNhcmdvLmxvY2tcIl1dLFxuICAgIFtcInV2LmxvY2tcIiwgcHl0aG9uQ2hlY2tJbnB1dHMsIFtcInB5cHJvamVjdC50b21sXCIsIFwidXYubG9ja1wiXV0sXG4gICAgW1wiR2VtZmlsZS5sb2NrXCIsIHJ1YnlDaGVja0lucHV0cywgW1wiR2VtZmlsZVwiLCBcIkdlbWZpbGUubG9ja1wiXV0sXG4gICAgW1wiLm12bi9jaGVja3N1bXMvY2hlY2tzdW1zLnNoYTI1NlwiLCBtYXZlbkNoZWNrSW5wdXRzLCBbXCJwb20ueG1sXCIsIFwiLm12bi9jaGVja3N1bXMvY2hlY2tzdW1zLnNoYTI1NlwiXV0sXG4gICAgW1xuICAgICAgXCJjb21wb3Nlci5sb2NrXCIsXG4gICAgICBjb21wb3NlckNoZWNrSW5wdXRzLFxuICAgICAgW1xuICAgICAgICBcImNvbXBvc2VyLmpzb25cIixcbiAgICAgICAgXCJjb21wb3Nlci5sb2NrXCIsXG4gICAgICAgIFwiLmNvbXBvc2VyL2NoZWNrc3Vtcy5qc29uXCIsXG4gICAgICAgIFwidG9vbHMvY29tcG9zZXIuanNvblwiLFxuICAgICAgICBcInRvb2xzL2NvbXBvc2VyLmxvY2tcIixcbiAgICAgICAgXCJ0b29scy8uY29tcG9zZXIvY2hlY2tzdW1zLmpzb25cIixcbiAgICAgICAgXCJ0b29scy9jb21wYXQvY29tcG9zZXIuanNvblwiLFxuICAgICAgICBcInRvb2xzL2NvbXBhdC9jb21wb3Nlci5sb2NrXCIsXG4gICAgICAgIFwidG9vbHMvY29tcGF0Ly5jb21wb3Nlci9jaGVja3N1bXMuanNvblwiLFxuICAgICAgXSxcbiAgICBdLFxuICBdIGFzIGNvbnN0KSB7XG4gICAgaWYgKCFleGlzdHNTeW5jKGpvaW4ocm9vdCwgZmlsZSkpKSBjb250aW51ZTtcbiAgICBpbnB1dHMucHVzaCguLi5nZW5lcmF0ZShyb290KSk7XG4gICAgZm9yIChjb25zdCBzb3VyY2Ugb2Ygc291cmNlcylcbiAgICAgIGlmIChleGlzdHNTeW5jKGpvaW4ocm9vdCwgc291cmNlKSkpIHNvdXJjZUhhc2hlc1tzb3VyY2VdID0gc2hhMjU2KHJlYWRGaWxlU3luYyhqb2luKHJvb3QsIHNvdXJjZSkpKTtcbiAgfVxuICBjb25zdCBleHRyYUZpbGUgPSBqb2luKHJvb3QsIFwibWFuYWdlZC1leHRyYS1pbnB1dHMuanNvblwiKTtcbiAgaWYgKGV4aXN0c1N5bmMoZXh0cmFGaWxlKSkge1xuICAgIGNvbnN0IGV4dHJhID0gbWFuYWdlZERlY2xhcmF0aW9uKEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGV4dHJhRmlsZSwgXCJ1dGY4XCIpKSk7XG4gICAgc291cmNlSGFzaGVzW1wibWFuYWdlZC1leHRyYS1pbnB1dHMuanNvblwiXSA9IHNoYTI1NihyZWFkRmlsZVN5bmMoZXh0cmFGaWxlKSk7XG4gICAgaWYgKGV4dHJhLnNjaGVtYV92ZXJzaW9uICE9PSAxKSB0aHJvdyBuZXcgRXJyb3IoXCJVbmtub3duIG1hbmFnZWQgZXh0cmEtaW5wdXQgc2NoZW1hXCIpO1xuICAgIGZvciAoY29uc3QgW2ZpbGUsIGV4cGVjdGVkXSBvZiBPYmplY3QuZW50cmllcyhleHRyYS5zb3VyY2VfaGFzaGVzKSkge1xuICAgICAgaWYgKFxuICAgICAgICAhZmlsZSB8fFxuICAgICAgICBmaWxlLnN0YXJ0c1dpdGgoXCIvXCIpIHx8XG4gICAgICAgIGZpbGUuaW5jbHVkZXMoXCJcXFxcXCIpIHx8XG4gICAgICAgIGZpbGUuc3BsaXQoXCIvXCIpLnNvbWUoKHBhcnQpID0+ICFwYXJ0IHx8IHBhcnQgPT09IFwiLi5cIiB8fCBwYXJ0ID09PSBcIi5cIilcbiAgICAgIClcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiVW5zYWZlIHN1cHBsZW1lbnRhbCBzb3VyY2UgcGF0aFwiKTtcbiAgICAgIGlmIChzaGEyNTYocmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgZmlsZSkpKSAhPT0gZXhwZWN0ZWQpXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgJHtmaWxlfTogcmVmcmVzaCBkZXJpdmVkIG1hbmFnZWQgaW5wdXRzYCk7XG4gICAgICBzb3VyY2VIYXNoZXNbZmlsZV0gPSBleHBlY3RlZDtcbiAgICB9XG4gICAgaW5wdXRzLnB1c2goLi4uZXh0cmEuaW5wdXRzLm1hcCgoZW50cnkpID0+IGFydGlmYWN0KGVudHJ5LnVybCwgZW50cnkuaGFzaCwgZW50cnkuZGVzdGluYXRpb24sIGVudHJ5LnBsYXRmb3JtcykpKTtcbiAgfVxuICBjb25zdCBib290c3RyYXBGaWxlID0gam9pbihyb290LCBcIm1hbmFnZWQtYm9vdHN0cmFwLmpzb25cIik7XG4gIGNvbnN0IHJlZ2lzdHJ5RmlsZSA9IGpvaW4ocm9vdCwgXCJtYW5hZ2VkLXJlZ2lzdHJ5Lmpzb24uYnJcIik7XG4gIGNvbnN0IHJlZ2lzdHJ5ID0gZXhpc3RzU3luYyhyZWdpc3RyeUZpbGUpO1xuICBpZiAocmVnaXN0cnkpIHNvdXJjZUhhc2hlc1tcIm1hbmFnZWQtcmVnaXN0cnkuanNvbi5iclwiXSA9IHNoYTI1NihyZWFkRmlsZVN5bmMocmVnaXN0cnlGaWxlKSk7XG4gIGNvbnN0IGJvb3RzdHJhcCA9IGV4aXN0c1N5bmMoYm9vdHN0cmFwRmlsZSlcbiAgICA/IHJlY29yZChKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhib290c3RyYXBGaWxlLCBcInV0ZjhcIikpLCBcIkludmFsaWQgbWFuYWdlZCBib290c3RyYXBcIilcbiAgICA6IHVuZGVmaW5lZDtcbiAgaWYgKGJvb3RzdHJhcCkge1xuICAgIGlmIChib290c3RyYXAuc2NoZW1hX3ZlcnNpb24gIT09IDEpIHRocm93IG5ldyBFcnJvcihcIlVua25vd24gbWFuYWdlZCBib290c3RyYXAgc2NoZW1hXCIpO1xuICAgIHNvdXJjZUhhc2hlc1tcIm1hbmFnZWQtYm9vdHN0cmFwLmpzb25cIl0gPSBzaGEyNTYocmVhZEZpbGVTeW5jKGJvb3RzdHJhcEZpbGUpKTtcbiAgICBmb3IgKGNvbnN0IFtwYXRoLCBlbnRyeV0gb2YgT2JqZWN0LmVudHJpZXMoXG4gICAgICByZWNvcmQocmVjb3JkKGJvb3RzdHJhcC5wYWNrYWdlX2xvY2ssIFwiSW52YWxpZCBib290c3RyYXAgbG9ja1wiKS5wYWNrYWdlcywgXCJJbnZhbGlkIGJvb3RzdHJhcCBwYWNrYWdlc1wiKSxcbiAgICApKSB7XG4gICAgICBpZiAoIXBhdGgpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgdmFsdWUgPSByZWNvcmQoZW50cnksIFwiSW52YWxpZCBib290c3RyYXAgcGFja2FnZVwiKTtcbiAgICAgIGNvbnN0IHNlbGVjdGVkID0gcGxhdGZvcm1zKHBhY2thZ2VQbGF0Zm9ybSh2YWx1ZSkpO1xuICAgICAgaWYgKHNlbGVjdGVkLmxlbmd0aClcbiAgICAgICAgaW5wdXRzLnB1c2goXG4gICAgICAgICAgYXJ0aWZhY3QoXG4gICAgICAgICAgICBzdHJpbmcodmFsdWUucmVzb2x2ZWQsIFwiSW52YWxpZCBib290c3RyYXAgVVJMXCIpLFxuICAgICAgICAgICAgdmFsdWUuaW50ZWdyaXR5LFxuICAgICAgICAgICAgYGJvb3RzdHJhcC8ke3BhdGgucmVwbGFjZUFsbChcIi9cIiwgXCItXCIpfS50Z3pgLFxuICAgICAgICAgICAgc2VsZWN0ZWQsXG4gICAgICAgICAgKSxcbiAgICAgICAgKTtcbiAgICB9XG4gIH1cbiAgY29uc3QgZGVzdGluYXRpb25zID0gbmV3IE1hcDxzdHJpbmcsIE1hbmFnZWRTb3VyY2U+KCk7XG4gIGZvciAoY29uc3QgZW50cnkgb2YgaW5wdXRzKSB7XG4gICAgY29uc3QgcHJldmlvdXMgPSBkZXN0aW5hdGlvbnMuZ2V0KGVudHJ5LmRlc3RpbmF0aW9uKTtcbiAgICBpZiAocHJldmlvdXMgJiYgSlNPTi5zdHJpbmdpZnkocHJldmlvdXMpICE9PSBKU09OLnN0cmluZ2lmeShlbnRyeSkpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbmZsaWN0aW5nIG1hbmFnZWQgaW5wdXQ6ICR7ZW50cnkuZGVzdGluYXRpb259YCk7XG4gICAgZGVzdGluYXRpb25zLnNldChlbnRyeS5kZXN0aW5hdGlvbiwgZW50cnkpO1xuICB9XG4gIHJldHVybiBtYW5hZ2VkRGVjbGFyYXRpb24oe1xuICAgIHNjaGVtYV92ZXJzaW9uOiAxLFxuICAgIHNvdXJjZV9oYXNoZXM6IE9iamVjdC5mcm9tRW50cmllcyhPYmplY3QuZW50cmllcyhzb3VyY2VIYXNoZXMpLnNvcnQoKSksXG4gICAgLi4uKGJvb3RzdHJhcCA/IHsgYm9vdHN0cmFwOiB0cnVlIH0gOiB7fSksXG4gICAgLi4uKHJlZ2lzdHJ5ID8geyByZWdpc3RyeTogdHJ1ZSB9IDoge30pLFxuICAgIGlucHV0czogWy4uLmRlc3RpbmF0aW9ucy52YWx1ZXMoKV0uc29ydCgoYSwgYikgPT5cbiAgICAgIGEuZGVzdGluYXRpb24gPCBiLmRlc3RpbmF0aW9uID8gLTEgOiBhLmRlc3RpbmF0aW9uID4gYi5kZXN0aW5hdGlvbiA/IDEgOiAwLFxuICAgICksXG4gIH0pO1xufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxVQUFVLFFBQVEsU0FBUyxRQUFRLFNBQVMsb0JBQW9CO0FBeUJ6RSxTQUFTLGVBQWUsMEJBQTBCO0FBQ2xELFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsWUFBWSxvQkFBb0I7QUFDekMsU0FBUyxVQUFVLFlBQVk7QUFDL0IsU0FBUyxTQUFTLGlCQUFpQjtBQUNuQyxTQUFTLGNBQWMsb0JBQW9CO0FBRTNDLFNBQVMsZ0JBQWdCLE9BQWlEO0FBQ3hFLFNBQU8sT0FBTztB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
