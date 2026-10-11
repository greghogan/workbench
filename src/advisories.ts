import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { readText, readToml } from "./core.js";

interface Query {
  package?: { name: string; ecosystem: string };
  version?: string;
  commit?: string;
}
interface Finding {
  id: string;
}
interface Result {
  vulns?: Finding[];
  next_page_token?: string;
}

/** Query exact locked packages, including tools; advisory absence is not a reachability claim. */
export function lockedQueries(directory: string, language: string): Query[] {
  if (language === "php") {
    const packages = new Map<string, Query>();
    for (const root of [".", "tools", "tools/compat"]) {
      const path = join(directory, root, "composer.lock");
      if (!existsSync(path)) continue;
      const lock = JSON.parse(readText(path)) as {
        packages: { name: string; version: string; dist?: { type?: string } }[];
        "packages-dev": { name: string; version: string; dist?: { type?: string } }[];
      };
      for (const entry of [...lock.packages, ...lock["packages-dev"]]) {
        if (entry.dist?.type === "path") continue;
        const version = entry.version.replace(/^v/, "");
        packages.set(`${entry.name}@${version}`, { package: { name: entry.name, ecosystem: "Packagist" }, version });
      }
    }
    return [...packages.values()];
  }
  if (language === "typescript" || language === "javascript") {
    const packages = new Set<string>();
    for (const document of parseAllDocuments(readText(join(directory, "pnpm-lock.yaml")))) {
      if (document.errors.length)
        throw new Error(`invalid pnpm lock: ${document.errors.map((error) => error.message).join("; ")}`);
      const lock = document.toJS() as { packages?: Record<string, unknown> };
      for (const key of Object.keys(lock.packages ?? {})) packages.add(key);
    }
    return [...packages].map((key) => {
      const match = /^(.+)@([^(@]+)(?:\(.*)?$/.exec(key);
      if (!match?.[1] || !match[2]) throw new Error(`unsupported npm lock identity: ${key}`);
      return { package: { name: match[1], ecosystem: "npm" }, version: match[2] };
    });
  }
  if (language === "ruby") {
    const lock = readText(join(directory, "Gemfile.lock"));
    const registry = /^GEM\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m.exec(lock)?.[1] ?? "";
    const packages = new Map<string, Query>();
    for (const match of registry.matchAll(
      /^ {4}([a-zA-Z0-9_-]+) \((\d+\.\d+\.\d+(?:\.[a-zA-Z0-9.]+)?)(?:-[^)]+)?\)$/gm,
    )) {
      const name = match[1];
      const version = match[2];
      if (!name || !version) throw new Error("invalid locked gem identity");
      packages.set(`${name}@${version}`, { package: { name, ecosystem: "RubyGems" }, version });
    }
    return [...packages.values()];
  }
  if (language === "java") {
    const checksums = readText(join(directory, ".mvn/checksums/checksums.sha256"));
    const paths = new Set<string>();
    const packages = new Map<string, Query>();
    for (const line of checksums.trim().split(/\r?\n/)) {
      const match = /^[a-f0-9]{64} [ *](\S+)$/.exec(line);
      const path = match?.[1];
      if (!path || path.split("/").some((part) => !part || part === "." || part === "..") || paths.has(path))
        throw new Error("invalid Maven trusted checksum entry");
      paths.add(path);
      // POMs describe graph metadata; only JAR entries represent acquired dependency code.
      if (!path.endsWith(".jar")) continue;
      const parts = path.split("/");
      const file = parts.pop();
      const version = parts.pop();
      const artifact = parts.pop();
      if (
        !version ||
        !artifact ||
        !parts.length ||
        !(file === `${artifact}-${version}.jar` || file?.startsWith(`${artifact}-${version}-`))
      )
        throw new Error(`invalid Maven artifact identity: ${path}`);
      const name = `${parts.join(".")}:${artifact}`;
      packages.set(`${name}@${version}`, { package: { name, ecosystem: "Maven" }, version });
    }
    return [...packages.values()];
  }
  if (language === "rust" || language === "python") {
    const lock = readToml(join(directory, language === "rust" ? "Cargo.lock" : "uv.lock")) as {
      package: { name: string; version: string; source?: string | { registry?: string } }[];
    };
    return lock.package
      .filter((entry) =>
        typeof entry.source === "string" ? entry.source.startsWith("registry+") : !!entry.source?.registry,
      )
      .map((entry) => ({
        package: { name: entry.name, ecosystem: language === "rust" ? "crates.io" : "PyPI" },
        version: entry.version,
      }));
  }
  if (language === "go") {
    // Only archive entries represent acquired dependency code; /go.mod entries describe graph metadata.
    const list = readText(join(directory, "go.sum"));
    return list
      .split(/\r?\n/)
      .filter((line) => line && !line.split(" ")[1]?.endsWith("/go.mod"))
      .map((line) => {
        const [name, version] = line.split(" ");
        if (!name || !version) throw new Error(`unsupported Go module identity: ${line}`);
        return { package: { name, ecosystem: "Go" }, version };
      });
  }
  if (language === "c" || language === "cpp") {
    const installed = process.env.WORKBENCH_BUILD_DIR
      ? join(process.env.WORKBENCH_BUILD_DIR, "debug/vcpkg_installed")
      : join(directory, "build/vcpkg_installed");
    if (!existsSync(installed))
      throw new Error("build the native reference before checking its resolved vcpkg sources");
    const commits = new Set<string>();
    for (const target of readdirSync(installed, { withFileTypes: true })) {
      const share = join(installed, target.name, "share");
      if (!target.isDirectory() || !existsSync(share)) continue;
      for (const name of readdirSync(share)) {
        const path = join(share, name, "vcpkg.spdx.json");
        if (!existsSync(path)) continue;
        const sbom = JSON.parse(readText(path)) as { packages: { downloadLocation?: string }[] };
        for (const item of sbom.packages) {
          const source = /^git\+https:\/\/github\.com\/([\w.-]+\/[\w.-]+)@([\w./-]+)$/.exec(
            item.downloadLocation ?? "",
          );
          if (!source?.[1] || !source[2] || source[1] === "microsoft/vcpkg") continue;
          if (/^[a-f0-9]{40}$/.test(source[2])) {
            commits.add(source[2]);
            continue;
          }
          const refs = execFileSync(
            "git",
            [
              "ls-remote",
              "--tags",
              `https://github.com/${source[1]}.git`,
              `refs/tags/${source[2]}`,
              `refs/tags/${source[2]}^{}`,
            ],
            { encoding: "utf8" },
          )
            .trim()
            .split("\n");
          const commit = refs.at(-1)?.split(/\s/)[0];
          if (!commit || !/^[a-f0-9]{40}$/.test(commit))
            throw new Error(`cannot resolve source tag ${source[1]}@${source[2]}`);
          commits.add(commit);
        }
      }
    }
    if (!commits.size) throw new Error("vcpkg SBOMs contain no supported upstream Git identities");
    return [...commits].map((commit) => ({ commit }));
  }
  throw new Error(`no advisory adapter for '${language}'`);
}

export async function checkAdvisories(directory: string, language: string): Promise<void> {
  const queries = lockedQueries(directory, language);
  if (!queries.length) {
    console.log("No registry dependencies in this lockfile.");
    return;
  }
  const findings: string[] = [];
  for (let offset = 0; offset < queries.length; offset += 100) {
    const batch = queries.slice(offset, offset + 100);
    const response = await fetch("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: batch }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`advisory query failed: HTTP ${String(response.status)}`);
    const data = (await response.json()) as { results?: Result[] };
    if (
      !Array.isArray(data.results) ||
      data.results.length !== batch.length ||
      data.results.some((entry) => entry.next_page_token)
    )
      throw new Error("advisory query returned incomplete results");
    for (const [index, result] of data.results.entries())
      for (const finding of result.vulns ?? []) findings.push(`${JSON.stringify(batch[index])}: ${finding.id}`);
  }
  if (findings.length)
    throw new Error(`locked dependencies have advisories (review reachability separately):\n${findings.join("\n")}`);
  console.log(`No known OSV advisories for ${String(queries.length)} locked package/source identities.`);
}
