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
  if (language === "typescript") {
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
