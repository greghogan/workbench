// Generated from managed-check-inputs.mts; edit the TypeScript source.
import { required, record, records, string, strings, stringRecord } from "./values.mjs";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1hbmFnZWQtY2hlY2staW5wdXRzLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyByZXF1aXJlZCwgcmVjb3JkLCByZWNvcmRzLCBzdHJpbmcsIHN0cmluZ3MsIHN0cmluZ1JlY29yZCB9IGZyb20gXCIuL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IHR5cGUgTWFuYWdlZFNvdXJjZSwgbWFuYWdlZFNvdXJjZSwgbWFuYWdlZERlY2xhcmF0aW9uIH0gZnJvbSBcIi4vbWFuYWdlZC1zb3VyY2UtY29udHJhY3QubWpzXCI7XG5leHBvcnQgaW50ZXJmYWNlIFBhY2thZ2VQbGF0Zm9ybSB7XG4gIG9zPzogc3RyaW5nW107XG4gIGNwdT86IHN0cmluZ1tdO1xuICBsaWJjPzogc3RyaW5nW107XG59XG5leHBvcnQgaW50ZXJmYWNlIE5wbUxvY2tlZFBhY2thZ2UgZXh0ZW5kcyBQYWNrYWdlUGxhdGZvcm0ge1xuICByZXNvbHV0aW9uPzogeyB0YXJiYWxsPzogc3RyaW5nOyBpbnRlZ3JpdHk/OiBzdHJpbmcgfTtcbn1cbmV4cG9ydCBpbnRlcmZhY2UgTnBtTG9jayB7XG4gIHBhY2thZ2VzPzogUmVjb3JkPHN0cmluZywgTnBtTG9ja2VkUGFja2FnZT47XG59XG5leHBvcnQgaW50ZXJmYWNlIEJvb3RzdHJhcFBhY2thZ2UgZXh0ZW5kcyBQYWNrYWdlUGxhdGZvcm0ge1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIHJlc29sdmVkOiBzdHJpbmc7XG4gIGludGVncml0eTogc3RyaW5nO1xufVxuZXhwb3J0IGludGVyZmFjZSBNYW5hZ2VkQm9vdHN0cmFwIHtcbiAgc2NoZW1hX3ZlcnNpb246IG51bWJlcjtcbiAgcGFja2FnZV9qc29uOiB1bmtub3duO1xuICBwYWNrYWdlX2xvY2s6IHsgcGFja2FnZXM6IFJlY29yZDxzdHJpbmcsIEJvb3RzdHJhcFBhY2thZ2U+IH07XG4gIHByb29mczogdW5rbm93bltdO1xufVxuaW1wb3J0IHR5cGUgeyBCaW5hcnlMaWtlIH0gZnJvbSBcImNyeXB0b1wiO1xuXG5pbXBvcnQgeyBjcmVhdGVIYXNoIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBwYXJzZVRvbWwgfSBmcm9tIFwiLi9ydW50aW1lLXBhcnNlcnMubWpzXCI7XG5pbXBvcnQgeyBwbnBtUGFja2FnZXMsIHBucG1JZGVudGl0eSB9IGZyb20gXCIuL3BucG0tbG9jay5tanNcIjtcblxuZnVuY3Rpb24gcGFja2FnZVBsYXRmb3JtKHZhbHVlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFBhY2thZ2VQbGF0Zm9ybSB7XG4gIHJldHVybiBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgW1wib3NcIiwgXCJjcHVcIiwgXCJsaWJjXCJdLmZsYXRNYXAoKGtleSkgPT5cbiAgICAgIHZhbHVlW2tleV0gPT09IHVuZGVmaW5lZCA/IFtdIDogW1trZXksIHN0cmluZ3ModmFsdWVba2V5XSwgXCJJbnZhbGlkIHBhY2thZ2UgcGxhdGZvcm1cIildXSxcbiAgICApLFxuICApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVhZE5wbUxvY2sodmFsdWU6IHVua25vd24pOiBOcG1Mb2NrIHtcbiAgY29uc3QgZG9jdW1lbnQgPSByZWNvcmQodmFsdWUsIFwiSW52YWxpZCBucG0gbG9jayBkb2N1bWVudFwiKTtcbiAgcmV0dXJuIHtcbiAgICBwYWNrYWdlczogT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgT2JqZWN0LmVudHJpZXMocmVjb3JkKGRvY3VtZW50LnBhY2thZ2VzID8/IHt9LCBcIkludmFsaWQgbnBtIGxvY2sgcGFja2FnZXNcIikpLm1hcCgoW25hbWUsIHJhd10pID0+IHtcbiAgICAgICAgY29uc3QgZW50cnkgPSByZWNvcmQocmF3LCBcIkludmFsaWQgbnBtIGxvY2sgcGFja2FnZVwiKTtcbiAgICAgICAgY29uc3QgcmVzb2x1dGlvbiA9XG4gICAgICAgICAgZW50cnkucmVzb2x1dGlvbiA9PT0gdW5kZWZpbmVkID8gdW5kZWZpbmVkIDogcmVjb3JkKGVudHJ5LnJlc29sdXRpb24sIFwiSW52YWxpZCBwYWNrYWdlIHJlc29sdXRpb25cIik7XG4gICAgICAgIHJldHVybiBbXG4gICAgICAgICAgbmFtZSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICAuLi5wYWNrYWdlUGxhdGZvcm0oZW50cnkpLFxuICAgICAgICAgICAgLi4uKHJlc29sdXRpb25cbiAgICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgICByZXNvbHV0aW9uOiB7XG4gICAgICAgICAgICAgICAgICAgIC4uLihyZXNvbHV0aW9uLnRhcmJhbGwgPT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgICAgICAgICAgID8ge31cbiAgICAgICAgICAgICAgICAgICAgICA6IHsgdGFyYmFsbDogc3RyaW5nKHJlc29sdXRpb24udGFyYmFsbCwgXCJJbnZhbGlkIHBhY2thZ2UgdGFyYmFsbFwiKSB9KSxcbiAgICAgICAgICAgICAgICAgICAgLi4uKHJlc29sdXRpb24uaW50ZWdyaXR5ID09PSB1bmRlZmluZWRcbiAgICAgICAgICAgICAgICAgICAgICA/IHt9XG4gICAgICAgICAgICAgICAgICAgICAgOiB7IGludGVncml0eTogc3RyaW5nKHJlc29sdXRpb24uaW50ZWdyaXR5LCBcIkludmFsaWQgcGFja2FnZSBpbnRlZ3JpdHlcIikgfSksXG4gICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgfSxcbiAgICAgICAgXTtcbiAgICAgIH0pLFxuICAgICksXG4gIH07XG59XG5cbmNvbnN0IHNoYTI1NiA9IChieXRlczogQmluYXJ5TGlrZSkgPT4gY3JlYXRlSGFzaChcInNoYTI1NlwiKS51cGRhdGUoYnl0ZXMpLmRpZ2VzdChcImhleFwiKTtcbmNvbnN0IHNyaSA9IChoZXg6IHN0cmluZykgPT4gYHNoYTI1Ni0ke0J1ZmZlci5mcm9tKGhleCwgXCJoZXhcIikudG9TdHJpbmcoXCJiYXNlNjRcIil9YDtcbmNvbnN0IHRleHQgPSAocm9vdDogc3RyaW5nLCBuYW1lOiBzdHJpbmcpID0+IHJlYWRGaWxlU3luYyhqb2luKHJvb3QsIG5hbWUpLCBcInV0ZjhcIik7XG5cbmZ1bmN0aW9uIGFydGlmYWN0KHVybDogc3RyaW5nLCBoYXNoOiB1bmtub3duLCBkZXN0aW5hdGlvbjogc3RyaW5nLCBwbGF0Zm9ybXM/OiBzdHJpbmdbXSkge1xuICByZXR1cm4gbWFuYWdlZFNvdXJjZSh7IHVybCwgaGFzaCwgZGVzdGluYXRpb24sIC4uLihwbGF0Zm9ybXMgPyB7IHBsYXRmb3JtcyB9IDoge30pIH0pO1xufVxuXG5mdW5jdGlvbiBwbGF0Zm9ybXMoZW50cnk6IFBhY2thZ2VQbGF0Zm9ybSkge1xuICBjb25zdCBhY2NlcHRzID0gKHZhbHVlczogc3RyaW5nW10gfCB1bmRlZmluZWQsIHNlbGVjdGVkOiBzdHJpbmcpID0+XG4gICAgIXZhbHVlcyB8fFxuICAgICghdmFsdWVzLmluY2x1ZGVzKGAhJHtzZWxlY3RlZH1gKSAmJlxuICAgICAgKCF2YWx1ZXMuc29tZSgodmFsdWU6IHN0cmluZykgPT4gIXZhbHVlLnN0YXJ0c1dpdGgoXCIhXCIpKSB8fCB2YWx1ZXMuaW5jbHVkZXMoc2VsZWN0ZWQpKSk7XG4gIHJldHVybiBbXCJ4NjRcIiwgXCJhcm02NFwiXVxuICAgIC5maWx0ZXIoKGFyY2gpID0+IGFjY2VwdHMoZW50cnkub3MsIFwibGludXhcIikgJiYgYWNjZXB0cyhlbnRyeS5jcHUsIGFyY2gpICYmIGFjY2VwdHMoZW50cnkubGliYywgXCJnbGliY1wiKSlcbiAgICAubWFwKChhcmNoKSA9PiBgbGludXgtJHthcmNofWApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbnBtQ2hlY2tJbnB1dHMocm9vdDogc3RyaW5nKSB7XG4gIGNvbnN0IHBhY2thZ2VzID0gcmVhZE5wbUxvY2soeyBwYWNrYWdlczogcG5wbVBhY2thZ2VzKHRleHQocm9vdCwgXCJwbnBtLWxvY2sueWFtbFwiKSkgfSkucGFja2FnZXMgPz8ge307XG4gIHJldHVybiBPYmplY3QuZW50cmllcyhwYWNrYWdlcykuZmxhdE1hcCgoW2tleSwgZW50cnldKSA9PiB7XG4gICAgY29uc3Qgc2VsZWN0ZWQgPSBwbGF0Zm9ybXMoZW50cnkpO1xuICAgIGlmICghc2VsZWN0ZWQubGVuZ3RoKSByZXR1cm4gW107XG4gICAgY29uc3QgeyBuYW1lLCB2ZXJzaW9uIH0gPSBwbnBtSWRlbnRpdHkoa2V5KTtcbiAgICBpZiAoIS9eW0EtWmEtejAtOS4rXy1dKyQvLnRlc3QodmVyc2lvbikgfHwgIS9eKEBbYS16MC05Ll8tXStcXC8pP1thLXowLTkuXy1dKyQvLnRlc3QobmFtZSkpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIGxvY2tlZCBucG0gc291cmNlOiAke2tleX1gKTtcbiAgICBjb25zdCB1cmwgPVxuICAgICAgZW50cnkucmVzb2x1dGlvbj8udGFyYmFsbCA/P1xuICAgICAgYGh0dHBzOi8vcmVnaXN0cnkubnBtanMub3JnLyR7bmFtZX0vLS8ke1N0cmluZyhuYW1lLnNwbGl0KFwiL1wiKS5hdCgtMSkpfS0ke3ZlcnNpb259LnRnemA7XG4gICAgcmV0dXJuIFthcnRpZmFjdCh1cmwsIGVudHJ5LnJlc29sdXRpb24/LmludGVncml0eSwgYG5wbS8ke25hbWUucmVwbGFjZUFsbChcIi9cIiwgXCItXCIpfS0ke3ZlcnNpb259LnRnemAsIHNlbGVjdGVkKV07XG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWF2ZW5DaGVja0lucHV0cyhyb290OiBzdHJpbmcpIHtcbiAgcmV0dXJuIHRleHQocm9vdCwgXCIubXZuL2NoZWNrc3Vtcy9jaGVja3N1bXMuc2hhMjU2XCIpXG4gICAgLnRyaW0oKVxuICAgIC5zcGxpdChcIlxcblwiKVxuICAgIC5tYXAoKGxpbmUpID0+IHtcbiAgICAgIGNvbnN0IG1hdGNoID0gL14oW2EtZjAtOV17NjR9KSB7Mn0oW0EtWmEtejAtOS5fKy8tXSspJC8uZXhlYyhsaW5lKTtcbiAgICAgIGlmICghbWF0Y2gpIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgbG9ja2VkIE1hdmVuIGNoZWNrc3VtXCIpO1xuICAgICAgcmV0dXJuIGFydGlmYWN0KFxuICAgICAgICBgaHR0cHM6Ly9tYXZlbi1jZW50cmFsLnN0b3JhZ2UtZG93bmxvYWQuZ29vZ2xlYXBpcy5jb20vbWF2ZW4yLyR7U3RyaW5nKG1hdGNoWzJdKX1gLFxuICAgICAgICBzcmkocmVxdWlyZWQobWF0Y2hbMV0sIFwiTWlzc2luZyBNYXZlbiBjaGVja3N1bVwiKSksXG4gICAgICAgIGBtYXZlbi8ke1N0cmluZyhtYXRjaFsyXSl9YCxcbiAgICAgICk7XG4gICAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBydWJ5Q2hlY2tJbnB1dHMocm9vdDogc3RyaW5nKSB7XG4gIGNvbnN0IGxvY2sgPSB0ZXh0KHJvb3QsIFwiR2VtZmlsZS5sb2NrXCIpO1xuICBjb25zdCBzZWN0aW9uID0gLyg/Ol58XFxuKUNIRUNLU1VNU1xcbihbXFxzXFxTXSo/KSg/PVxcbltBLVpdfCQpLy5leGVjKGxvY2spPy5bMV07XG4gIGlmICghc2VjdGlvbikgdGhyb3cgbmV3IEVycm9yKFwiTWFuYWdlZCBnZW1zIHJlcXVpcmUgdGhlIGxvY2sncyBDSEVDS1NVTVMgc2VjdGlvblwiKTtcbiAgcmV0dXJuIFsuLi5zZWN0aW9uLm1hdGNoQWxsKC9eIHsyfShbQS1aYS16MC05Ll8tXSspIFxcKChbXildKylcXCkgc2hhMjU2PShbYS1mMC05XXs2NH0pJC9nbSldLmZsYXRNYXAoKG1hdGNoKSA9PiB7XG4gICAgY29uc3QgdmVyc2lvbiA9IHJlcXVpcmVkKG1hdGNoWzJdLCBcIk1pc3NpbmcgZ2VtIHZlcnNpb25cIiksXG4gICAgICBwbGF0Zm9ybSA9IHZlcnNpb24ucmVwbGFjZSgvXlswLTldKyg/OlxcLlswLTldKykqKD86XFwucHJlXFwuWzAtOV0rKT8vLCBcIlwiKTtcbiAgICBjb25zdCBzZWxlY3RlZCA9ICFwbGF0Zm9ybVxuICAgICAgPyBbXCJsaW51eC14NjRcIiwgXCJsaW51eC1hcm02NFwiXVxuICAgICAgOiBwbGF0Zm9ybSA9PT0gXCIteDg2XzY0LWxpbnV4LWdudVwiXG4gICAgICAgID8gW1wibGludXgteDY0XCJdXG4gICAgICAgIDogcGxhdGZvcm0gPT09IFwiLWFhcmNoNjQtbGludXgtZ251XCJcbiAgICAgICAgICA/IFtcImxpbnV4LWFybTY0XCJdXG4gICAgICAgICAgOiBbXTtcbiAgICBpZiAoIXNlbGVjdGVkLmxlbmd0aCkgcmV0dXJuIFtdO1xuICAgIGNvbnN0IG5hbWUgPSBgJHtTdHJpbmcobWF0Y2hbMV0pfS0ke3ZlcnNpb259LmdlbWA7XG4gICAgcmV0dXJuIFtcbiAgICAgIGFydGlmYWN0KFxuICAgICAgICBgaHR0cHM6Ly9ydWJ5Z2Vtcy5vcmcvZG93bmxvYWRzLyR7bmFtZX1gLFxuICAgICAgICBzcmkocmVxdWlyZWQobWF0Y2hbM10sIFwiTWlzc2luZyBnZW0gY2hlY2tzdW1cIikpLFxuICAgICAgICBgZ2Vtcy8ke25hbWV9YCxcbiAgICAgICAgc2VsZWN0ZWQsXG4gICAgICApLFxuICAgIF07XG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY2FyZ29DaGVja0lucHV0cyhyb290OiBzdHJpbmcpIHtcbiAgY29uc3QgbG9jayA9IHBhcnNlVG9tbCh0ZXh0KHJvb3QsIFwiQ2FyZ28ubG9ja1wiKSk7XG4gIHJldHVybiByZWNvcmRzKGxvY2sucGFja2FnZSwgXCJJbnZhbGlkIENhcmdvIGxvY2sgcGFja2FnZXNcIilcbiAgICAuZmlsdGVyKChlbnRyeSkgPT4gZW50cnkuc291cmNlKVxuICAgIC5tYXAoKGVudHJ5KSA9PiB7XG4gICAgICBpZiAoXG4gICAgICAgIGVudHJ5LnNvdXJjZSAhPT0gXCJyZWdpc3RyeStodHRwczovL2dpdGh1Yi5jb20vcnVzdC1sYW5nL2NyYXRlcy5pby1pbmRleFwiIHx8XG4gICAgICAgIHR5cGVvZiBlbnRyeS5jaGVja3N1bSAhPT0gXCJzdHJpbmdcIiB8fFxuICAgICAgICAhL15bYS1mMC05XXs2NH0kLy50ZXN0KGVudHJ5LmNoZWNrc3VtKVxuICAgICAgKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIGxvY2tlZCBDYXJnbyBzb3VyY2U6ICR7U3RyaW5nKGVudHJ5Lm5hbWUpfWApO1xuICAgICAgY29uc3QgY3JhdGUgPSBzdHJpbmcoZW50cnkubmFtZSwgXCJNaXNzaW5nIGNyYXRlIG5hbWVcIiksXG4gICAgICAgIHZlcnNpb24gPSBzdHJpbmcoZW50cnkudmVyc2lvbiwgXCJNaXNzaW5nIGNyYXRlIHZlcnNpb25cIik7XG4gICAgICBjb25zdCBuYW1lID0gYCR7Y3JhdGV9LSR7dmVyc2lvbn0uY3JhdGVgO1xuICAgICAgcmV0dXJuIGFydGlmYWN0KGBodHRwczovL3N0YXRpYy5jcmF0ZXMuaW8vY3JhdGVzLyR7Y3JhdGV9LyR7bmFtZX1gLCBzcmkoZW50cnkuY2hlY2tzdW0pLCBgY2FyZ28vJHtuYW1lfWApO1xuICAgIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcHl0aG9uQ2hlY2tJbnB1dHMocm9vdDogc3RyaW5nKSB7XG4gIGNvbnN0IGxvY2sgPSBwYXJzZVRvbWwodGV4dChyb290LCBcInV2LmxvY2tcIikpO1xuICByZXR1cm4gcmVjb3Jkcyhsb2NrLnBhY2thZ2UsIFwiSW52YWxpZCBQeXRob24gbG9jayBwYWNrYWdlc1wiKS5mbGF0TWFwKChlbnRyeSkgPT5cbiAgICBbXG4gICAgICAuLi4oZW50cnkuc2Rpc3QgPT09IHVuZGVmaW5lZCA/IFtdIDogW3JlY29yZChlbnRyeS5zZGlzdCwgXCJJbnZhbGlkIHNvdXJjZSBkaXN0cmlidXRpb25cIildKSxcbiAgICAgIC4uLnJlY29yZHMoZW50cnkud2hlZWxzID8/IFtdLCBcIkludmFsaWQgbG9ja2VkIHdoZWVsc1wiKSxcbiAgICBdLmZsYXRNYXAoKHZhbHVlKSA9PiB7XG4gICAgICBjb25zdCBmaWxlID0ge1xuICAgICAgICB1cmw6IHN0cmluZyh2YWx1ZS51cmwsIFwiSW52YWxpZCBQeXRob24gYXJ0aWZhY3QgVVJMXCIpLFxuICAgICAgICBoYXNoOiBzdHJpbmcodmFsdWUuaGFzaCwgXCJJbnZhbGlkIFB5dGhvbiBhcnRpZmFjdCBoYXNoXCIpLFxuICAgICAgfTtcbiAgICAgIGNvbnN0IG5hbWUgPSBiYXNlbmFtZShuZXcgVVJMKGZpbGUudXJsKS5wYXRobmFtZSk7XG4gICAgICBjb25zdCBzZWxlY3RlZCA9XG4gICAgICAgICFuYW1lLmVuZHNXaXRoKFwiLndobFwiKSB8fCBuYW1lLmVuZHNXaXRoKFwiLWFueS53aGxcIilcbiAgICAgICAgICA/IFtcImxpbnV4LXg2NFwiLCBcImxpbnV4LWFybTY0XCJdXG4gICAgICAgICAgOiBbXCJ4NjRcIiwgXCJhcm02NFwiXVxuICAgICAgICAgICAgICAuZmlsdGVyKChhcmNoKSA9PiBuZXcgUmVnRXhwKGBtYW55bGludXhbXi9dKiR7YXJjaCA9PT0gXCJ4NjRcIiA/IFwieDg2XzY0XCIgOiBcImFhcmNoNjRcIn1gKS50ZXN0KG5hbWUpKVxuICAgICAgICAgICAgICAubWFwKChhcmNoKSA9PiBgbGludXgtJHthcmNofWApO1xuICAgICAgaWYgKCFzZWxlY3RlZC5sZW5ndGgpIHJldHVybiBbXTtcbiAgICAgIGlmICghL15zaGEyNTY6W2EtZjAtOV17NjR9JC8udGVzdChmaWxlLmhhc2gpKSB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgbG9ja2VkIFB5dGhvbiBpbnRlZ3JpdHk6ICR7bmFtZX1gKTtcbiAgICAgIHJldHVybiBbYXJ0aWZhY3QoZmlsZS51cmwsIHNyaShmaWxlLmhhc2guc2xpY2UoNykpLCBgcHl0aG9uLyR7bmFtZX1gLCBzZWxlY3RlZCldO1xuICAgIH0pLFxuICApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY29tcG9zZXJDaGVja0lucHV0cyhyb290OiBzdHJpbmcpIHtcbiAgcmV0dXJuIFtcIi5cIiwgXCJ0b29sc1wiLCBcInRvb2xzL2NvbXBhdFwiXS5mbGF0TWFwKChkaXJlY3RvcnkpID0+IHtcbiAgICBjb25zdCBiYXNlID0gam9pbihyb290LCBkaXJlY3RvcnkpO1xuICAgIGlmICghZXhpc3RzU3luYyhqb2luKGJhc2UsIFwiY29tcG9zZXIubG9ja1wiKSkpIHJldHVybiBbXTtcbiAgICBjb25zdCBsb2NrID0gcmVjb3JkKEpTT04ucGFyc2UodGV4dChiYXNlLCBcImNvbXBvc2VyLmxvY2tcIikpLCBcIkludmFsaWQgQ29tcG9zZXIgbG9ja1wiKTtcbiAgICBjb25zdCBjaGVja3N1bXMgPSBzdHJpbmdSZWNvcmQoSlNPTi5wYXJzZSh0ZXh0KGJhc2UsIFwiLmNvbXBvc2VyL2NoZWNrc3Vtcy5qc29uXCIpKSwgXCJJbnZhbGlkIENvbXBvc2VyIGNoZWNrc3Vtc1wiKTtcbiAgICByZXR1cm4gW1xuICAgICAgLi4ucmVjb3Jkcyhsb2NrLnBhY2thZ2VzLCBcIkludmFsaWQgQ29tcG9zZXIgcGFja2FnZXNcIiksXG4gICAgICAuLi5yZWNvcmRzKGxvY2tbXCJwYWNrYWdlcy1kZXZcIl0sIFwiSW52YWxpZCBDb21wb3NlciBkZXYgcGFja2FnZXNcIiksXG4gICAgXVxuICAgICAgLm1hcCgoZW50cnkpID0+ICh7IGVudHJ5LCBkaXN0OiByZWNvcmQoZW50cnkuZGlzdCwgXCJNaXNzaW5nIENvbXBvc2VyIGRpc3RyaWJ1dGlvblwiKSB9KSlcbiAgICAgIC5maWx0ZXIoKHsgZGlzdCB9KSA9PiBkaXN0LnR5cGUgIT09IFwicGF0aFwiKVxuICAgICAgLm1hcCgoeyBlbnRyeSwgZGlzdCB9KSA9PiAoe1xuICAgICAgICBuYW1lOiBzdHJpbmcoZW50cnkubmFtZSwgXCJNaXNzaW5nIENvbXBvc2VyIHBhY2thZ2UgbmFtZVwiKSxcbiAgICAgICAgdmVyc2lvbjogc3RyaW5nKGVudHJ5LnZlcnNpb24sIFwiTWlzc2luZyBDb21wb3NlciBwYWNrYWdlIHZlcnNpb25cIiksXG4gICAgICAgIGRpc3QsXG4gICAgICB9KSlcbiAgICAgIC5tYXAoKGVudHJ5KSA9PiB7XG4gICAgICAgIGNvbnN0IHJlZmVyZW5jZSA9XG4gICAgICAgICAgZW50cnkuZGlzdC5yZWZlcmVuY2UgPT09IHVuZGVmaW5lZCB8fCBlbnRyeS5kaXN0LnJlZmVyZW5jZSA9PT0gbnVsbFxuICAgICAgICAgICAgPyBcIlwiXG4gICAgICAgICAgICA6IHN0cmluZyhlbnRyeS5kaXN0LnJlZmVyZW5jZSwgXCJJbnZhbGlkIGRpc3RyaWJ1dGlvbiByZWZlcmVuY2VcIik7XG4gICAgICAgIGNvbnN0IGtleSA9IGAke2VudHJ5Lm5hbWV9QCR7ZW50cnkudmVyc2lvbn0jJHtyZWZlcmVuY2V9YDtcbiAgICAgICAgY29uc3QgZGlnZXN0ID0gY2hlY2tzdW1zW2tleV07XG4gICAgICAgIGlmICghZGlnZXN0IHx8ICEvXlthLWYwLTldezY0fSQvLnRlc3QoZGlnZXN0KSkgdGhyb3cgbmV3IEVycm9yKGBNaXNzaW5nIHJldmlld2VkIENvbXBvc2VyIGludGVncml0eTogJHtrZXl9YCk7XG4gICAgICAgIHJldHVybiBhcnRpZmFjdChcbiAgICAgICAgICBzdHJpbmcoZW50cnkuZGlzdC51cmwsIFwiSW52YWxpZCBDb21wb3NlciBVUkxcIiksXG4gICAgICAgICAgc3JpKGRpZ2VzdCksXG4gICAgICAgICAgYGNvbXBvc2VyLyR7ZGlyZWN0b3J5ID09PSBcIi5cIiA/IFwiYXBwbGljYXRpb25cIiA6IGRpcmVjdG9yeX0vJHtlbnRyeS5uYW1lfS8ke2RpZ2VzdH0uemlwYCxcbiAgICAgICAgKTtcbiAgICAgIH0pO1xuICB9KTtcbn1cblxuLyoqIEEgYnVpbGRlciBjb25zdW1lcyBleGFjdGx5IHRoZXNlIHNvdXJjZSBieXRlczsgZGVwZW5kZW5jeSByZXNvbHV0aW9uIHN0YXlzIGluIHRoZSBsYW5ndWFnZSdzIGxvY2suICovXG5leHBvcnQgZnVuY3Rpb24gbWFuYWdlZENoZWNrSW5wdXRzKHJvb3Q6IHN0cmluZykge1xuICBjb25zdCBpbnB1dHM6IE1hbmFnZWRTb3VyY2VbXSA9IFtdO1xuICBjb25zdCBzb3VyY2VIYXNoZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgZm9yIChjb25zdCBbZmlsZSwgZ2VuZXJhdGUsIHNvdXJjZXNdIG9mIFtcbiAgICBbXCJwbnBtLWxvY2sueWFtbFwiLCBucG1DaGVja0lucHV0cywgW1wicGFja2FnZS5qc29uXCIsIFwicG5wbS1sb2NrLnlhbWxcIiwgXCJwbnBtLXdvcmtzcGFjZS55YW1sXCIsIFwiLnBucG1maWxlLmNqc1wiXV0sXG4gICAgW1wiQ2FyZ28ubG9ja1wiLCBjYXJnb0NoZWNrSW5wdXRzLCBbXCJDYXJnby50b21sXCIsIFwiQ2FyZ28ubG9ja1wiXV0sXG4gICAgW1widXYubG9ja1wiLCBweXRob25DaGVja0lucHV0cywgW1wicHlwcm9qZWN0LnRvbWxcIiwgXCJ1di5sb2NrXCJdXSxcbiAgICBbXCJHZW1maWxlLmxvY2tcIiwgcnVieUNoZWNrSW5wdXRzLCBbXCJHZW1maWxlXCIsIFwiR2VtZmlsZS5sb2NrXCJdXSxcbiAgICBbXCIubXZuL2NoZWNrc3Vtcy9jaGVja3N1bXMuc2hhMjU2XCIsIG1hdmVuQ2hlY2tJbnB1dHMsIFtcInBvbS54bWxcIiwgXCIubXZuL2NoZWNrc3Vtcy9jaGVja3N1bXMuc2hhMjU2XCJdXSxcbiAgICBbXG4gICAgICBcImNvbXBvc2VyLmxvY2tcIixcbiAgICAgIGNvbXBvc2VyQ2hlY2tJbnB1dHMsXG4gICAgICBbXG4gICAgICAgIFwiY29tcG9zZXIuanNvblwiLFxuICAgICAgICBcImNvbXBvc2VyLmxvY2tcIixcbiAgICAgICAgXCIuY29tcG9zZXIvY2hlY2tzdW1zLmpzb25cIixcbiAgICAgICAgXCJ0b29scy9jb21wb3Nlci5qc29uXCIsXG4gICAgICAgIFwidG9vbHMvY29tcG9zZXIubG9ja1wiLFxuICAgICAgICBcInRvb2xzLy5jb21wb3Nlci9jaGVja3N1bXMuanNvblwiLFxuICAgICAgICBcInRvb2xzL2NvbXBhdC9jb21wb3Nlci5qc29uXCIsXG4gICAgICAgIFwidG9vbHMvY29tcGF0L2NvbXBvc2VyLmxvY2tcIixcbiAgICAgICAgXCJ0b29scy9jb21wYXQvLmNvbXBvc2VyL2NoZWNrc3Vtcy5qc29uXCIsXG4gICAgICBdLFxuICAgIF0sXG4gIF0gYXMgY29uc3QpIHtcbiAgICBpZiAoIWV4aXN0c1N5bmMoam9pbihyb290LCBmaWxlKSkpIGNvbnRpbnVlO1xuICAgIGlucHV0cy5wdXNoKC4uLmdlbmVyYXRlKHJvb3QpKTtcbiAgICBmb3IgKGNvbnN0IHNvdXJjZSBvZiBzb3VyY2VzKVxuICAgICAgaWYgKGV4aXN0c1N5bmMoam9pbihyb290LCBzb3VyY2UpKSkgc291cmNlSGFzaGVzW3NvdXJjZV0gPSBzaGEyNTYocmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgc291cmNlKSkpO1xuICB9XG4gIGNvbnN0IGV4dHJhRmlsZSA9IGpvaW4ocm9vdCwgXCJtYW5hZ2VkLWV4dHJhLWlucHV0cy5qc29uXCIpO1xuICBpZiAoZXhpc3RzU3luYyhleHRyYUZpbGUpKSB7XG4gICAgY29uc3QgZXh0cmEgPSBtYW5hZ2VkRGVjbGFyYXRpb24oSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoZXh0cmFGaWxlLCBcInV0ZjhcIikpKTtcbiAgICBzb3VyY2VIYXNoZXNbXCJtYW5hZ2VkLWV4dHJhLWlucHV0cy5qc29uXCJdID0gc2hhMjU2KHJlYWRGaWxlU3luYyhleHRyYUZpbGUpKTtcbiAgICBpZiAoZXh0cmEuc2NoZW1hX3ZlcnNpb24gIT09IDEpIHRocm93IG5ldyBFcnJvcihcIlVua25vd24gbWFuYWdlZCBleHRyYS1pbnB1dCBzY2hlbWFcIik7XG4gICAgZm9yIChjb25zdCBbZmlsZSwgZXhwZWN0ZWRdIG9mIE9iamVjdC5lbnRyaWVzKGV4dHJhLnNvdXJjZV9oYXNoZXMpKSB7XG4gICAgICBpZiAoXG4gICAgICAgICFmaWxlIHx8XG4gICAgICAgIGZpbGUuc3RhcnRzV2l0aChcIi9cIikgfHxcbiAgICAgICAgZmlsZS5pbmNsdWRlcyhcIlxcXFxcIikgfHxcbiAgICAgICAgZmlsZS5zcGxpdChcIi9cIikuc29tZSgocGFydCkgPT4gIXBhcnQgfHwgcGFydCA9PT0gXCIuLlwiIHx8IHBhcnQgPT09IFwiLlwiKVxuICAgICAgKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJVbnNhZmUgc3VwcGxlbWVudGFsIHNvdXJjZSBwYXRoXCIpO1xuICAgICAgaWYgKHNoYTI1NihyZWFkRmlsZVN5bmMoam9pbihyb290LCBmaWxlKSkpICE9PSBleHBlY3RlZClcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGAke2ZpbGV9OiByZWZyZXNoIGRlcml2ZWQgbWFuYWdlZCBpbnB1dHNgKTtcbiAgICAgIHNvdXJjZUhhc2hlc1tmaWxlXSA9IGV4cGVjdGVkO1xuICAgIH1cbiAgICBpbnB1dHMucHVzaCguLi5leHRyYS5pbnB1dHMubWFwKChlbnRyeSkgPT4gYXJ0aWZhY3QoZW50cnkudXJsLCBlbnRyeS5oYXNoLCBlbnRyeS5kZXN0aW5hdGlvbiwgZW50cnkucGxhdGZvcm1zKSkpO1xuICB9XG4gIGNvbnN0IGJvb3RzdHJhcEZpbGUgPSBqb2luKHJvb3QsIFwibWFuYWdlZC1ib290c3RyYXAuanNvblwiKTtcbiAgY29uc3QgcmVnaXN0cnlGaWxlID0gam9pbihyb290LCBcIm1hbmFnZWQtcmVnaXN0cnkuanNvbi5iclwiKTtcbiAgY29uc3QgcmVnaXN0cnkgPSBleGlzdHNTeW5jKHJlZ2lzdHJ5RmlsZSk7XG4gIGlmIChyZWdpc3RyeSkgc291cmNlSGFzaGVzW1wibWFuYWdlZC1yZWdpc3RyeS5qc29uLmJyXCJdID0gc2hhMjU2KHJlYWRGaWxlU3luYyhyZWdpc3RyeUZpbGUpKTtcbiAgY29uc3QgYm9vdHN0cmFwID0gZXhpc3RzU3luYyhib290c3RyYXBGaWxlKVxuICAgID8gcmVjb3JkKEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGJvb3RzdHJhcEZpbGUsIFwidXRmOFwiKSksIFwiSW52YWxpZCBtYW5hZ2VkIGJvb3RzdHJhcFwiKVxuICAgIDogdW5kZWZpbmVkO1xuICBpZiAoYm9vdHN0cmFwKSB7XG4gICAgaWYgKGJvb3RzdHJhcC5zY2hlbWFfdmVyc2lvbiAhPT0gMSkgdGhyb3cgbmV3IEVycm9yKFwiVW5rbm93biBtYW5hZ2VkIGJvb3RzdHJhcCBzY2hlbWFcIik7XG4gICAgc291cmNlSGFzaGVzW1wibWFuYWdlZC1ib290c3RyYXAuanNvblwiXSA9IHNoYTI1NihyZWFkRmlsZVN5bmMoYm9vdHN0cmFwRmlsZSkpO1xuICAgIGZvciAoY29uc3QgW3BhdGgsIGVudHJ5XSBvZiBPYmplY3QuZW50cmllcyhcbiAgICAgIHJlY29yZChyZWNvcmQoYm9vdHN0cmFwLnBhY2thZ2VfbG9jaywgXCJJbnZhbGlkIGJvb3RzdHJhcCBsb2NrXCIpLnBhY2thZ2VzLCBcIkludmFsaWQgYm9vdHN0cmFwIHBhY2thZ2VzXCIpLFxuICAgICkpIHtcbiAgICAgIGlmICghcGF0aCkgY29udGludWU7XG4gICAgICBjb25zdCB2YWx1ZSA9IHJlY29yZChlbnRyeSwgXCJJbnZhbGlkIGJvb3RzdHJhcCBwYWNrYWdlXCIpO1xuICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBwbGF0Zm9ybXMocGFja2FnZVBsYXRmb3JtKHZhbHVlKSk7XG4gICAgICBpZiAoc2VsZWN0ZWQubGVuZ3RoKVxuICAgICAgICBpbnB1dHMucHVzaChcbiAgICAgICAgICBhcnRpZmFjdChcbiAgICAgICAgICAgIHN0cmluZyh2YWx1ZS5yZXNvbHZlZCwgXCJJbnZhbGlkIGJvb3RzdHJhcCBVUkxcIiksXG4gICAgICAgICAgICB2YWx1ZS5pbnRlZ3JpdHksXG4gICAgICAgICAgICBgYm9vdHN0cmFwLyR7cGF0aC5yZXBsYWNlQWxsKFwiL1wiLCBcIi1cIil9LnRnemAsXG4gICAgICAgICAgICBzZWxlY3RlZCxcbiAgICAgICAgICApLFxuICAgICAgICApO1xuICAgIH1cbiAgfVxuICBjb25zdCBkZXN0aW5hdGlvbnMgPSBuZXcgTWFwPHN0cmluZywgTWFuYWdlZFNvdXJjZT4oKTtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiBpbnB1dHMpIHtcbiAgICBjb25zdCBwcmV2aW91cyA9IGRlc3RpbmF0aW9ucy5nZXQoZW50cnkuZGVzdGluYXRpb24pO1xuICAgIGlmIChwcmV2aW91cyAmJiBKU09OLnN0cmluZ2lmeShwcmV2aW91cykgIT09IEpTT04uc3RyaW5naWZ5KGVudHJ5KSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQ29uZmxpY3RpbmcgbWFuYWdlZCBpbnB1dDogJHtlbnRyeS5kZXN0aW5hdGlvbn1gKTtcbiAgICBkZXN0aW5hdGlvbnMuc2V0KGVudHJ5LmRlc3RpbmF0aW9uLCBlbnRyeSk7XG4gIH1cbiAgcmV0dXJuIG1hbmFnZWREZWNsYXJhdGlvbih7XG4gICAgc2NoZW1hX3ZlcnNpb246IDEsXG4gICAgc291cmNlX2hhc2hlczogT2JqZWN0LmZyb21FbnRyaWVzKE9iamVjdC5lbnRyaWVzKHNvdXJjZUhhc2hlcykuc29ydCgpKSxcbiAgICAuLi4oYm9vdHN0cmFwID8geyBib290c3RyYXA6IHRydWUgfSA6IHt9KSxcbiAgICAuLi4ocmVnaXN0cnkgPyB7IHJlZ2lzdHJ5OiB0cnVlIH0gOiB7fSksXG4gICAgaW5wdXRzOiBbLi4uZGVzdGluYXRpb25zLnZhbHVlcygpXS5zb3J0KChhLCBiKSA9PlxuICAgICAgYS5kZXN0aW5hdGlvbiA8IGIuZGVzdGluYXRpb24gPyAtMSA6IGEuZGVzdGluYXRpb24gPiBiLmRlc3RpbmF0aW9uID8gMSA6IDAsXG4gICAgKSxcbiAgfSk7XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLFVBQVUsUUFBUSxTQUFTLFFBQVEsU0FBUyxvQkFBb0I7QUFDekUsU0FBNkIsZUFBZSwwQkFBMEI7QUF5QnRFLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsWUFBWSxvQkFBb0I7QUFDekMsU0FBUyxVQUFVLFlBQVk7QUFDL0IsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUyxjQUFjLG9CQUFvQjtBQUUzQyxTQUFTLGdCQUFnQixPQUFpRDtBQUN4RSxTQUFPLE9BQU87QUFBQSxJQUNaLENBQUMsTUFBTSxPQUFPLE1BQU0sRUFBRTtBQUFBLE1BQVEsQ0FBQyxR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
