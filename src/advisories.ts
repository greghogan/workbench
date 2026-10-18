import { existsSync } from "node:fs";
import { join } from "node:path";
import { pnpmPackages, pnpmIdentity } from "../scripts/pnpm-lock.mjs";
import { readText, readToml } from "./core.js";
import { advisoryInline as inline, fetchAdvisory, formatAdvisory } from "./advisory-details.js";

interface Query {
  package: { name: string; ecosystem: string };
  version: string;
}
interface Finding {
  id: string;
}
interface Result {
  vulns?: Finding[];
  next_page_token?: string;
}

function validFinding(value: unknown): value is Finding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const finding = value as Partial<Finding>;
  return typeof finding.id === "string" && finding.id.trim().length > 0;
}

function validResult(value: unknown): value is Result {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Partial<Result>;
  return (
    (result.vulns === undefined || (Array.isArray(result.vulns) && result.vulns.every(validFinding))) &&
    (result.next_page_token === undefined || typeof result.next_page_token === "string")
  );
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
    const queries = Object.keys(pnpmPackages(readText(join(directory, "pnpm-lock.yaml")))).map((key) => {
      const { name, version } = pnpmIdentity(key);
      return { package: { name, ecosystem: "npm" }, version };
    });
    for (const bootstrap of ["scripts/package-manager", "scripts/container-tools"]) {
      const path = join(directory, bootstrap, "package-lock.json");
      if (!existsSync(path)) continue;
      const lock = JSON.parse(readText(path)) as { packages: Record<string, { version?: string }> };
      for (const [name, entry] of Object.entries(lock.packages)) {
        if (!name) continue;
        if (!entry.version) throw new Error(`${path}: missing bootstrap package version`);
        queries.push({
          package: { name: name.replace(/^.*node_modules\//, ""), ecosystem: "npm" },
          version: entry.version,
        });
      }
    }
    return [...new Map(queries.map((query) => [`${query.package.name}@${query.version}`, query])).values()];
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
  throw new Error(`no advisory adapter for '${language}'`);
}

export async function checkAdvisories(directory: string, language: string): Promise<void> {
  const queries = lockedQueries(directory, language);
  if (!queries.length) {
    console.log("No registry dependencies in this lockfile.");
    return;
  }
  const findings: { query: Query; id: string }[] = [];
  for (let offset = 0; offset < queries.length; offset += 100) {
    const batch = queries.slice(offset, offset + 100);
    const response = await fetch("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: batch }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`advisory query failed: HTTP ${String(response.status)}`);
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid advisory response");
    const results = (data as { results?: unknown }).results;
    if (!Array.isArray(results) || results.length !== batch.length)
      throw new Error("advisory query returned incomplete results");
    if (!results.every(validResult)) throw new Error("invalid advisory response");
    if (results.some((entry) => entry.next_page_token)) throw new Error("advisory query returned incomplete results");
    for (const [index, result] of results.entries())
      for (const finding of result.vulns ?? []) {
        const query = batch[index];
        if (query) findings.push({ query, id: finding.id });
      }
  }
  if (findings.length) {
    const messages: string[] = [];
    const detailsById = new Map<string, ReturnType<typeof fetchAdvisory>>();
    for (let offset = 0; offset < findings.length; offset += 4) {
      const batch = findings.slice(offset, offset + 4);
      const details = await Promise.all(
        batch.map(async ({ query, id }) => {
          let request = detailsById.get(id);
          if (!request) {
            request = fetchAdvisory(id);
            detailsById.set(id, request);
          }
          return formatAdvisory(id, await request, query.package);
        }),
      );
      for (const [index, { query, id }] of batch.entries())
        messages.push(
          `${inline(query.package.name)}@${inline(query.version)} (${inline(query.package.ecosystem)}): ${inline(id)}`,
          ...(details[index] ?? []),
        );
    }
    throw new Error(
      `locked dependency advisories block this check (reachability has not been assessed):\n${messages.join("\n")}`,
    );
  }
  console.log(`No known OSV advisories for ${String(queries.length)} locked package identities.`);
}
