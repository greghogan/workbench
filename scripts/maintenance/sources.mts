import { metadataBytes } from "../metadata-http.mjs";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { JSDOM } from "jsdom";
import { satisfies, validRange } from "semver";
import { captureOwnedChild } from "../owned-child.mjs";
import { record, records, required, string } from "../values.mjs";

import type { Release } from "./contract.mjs";
export type MetadataRequest = (url: string, accept?: string) => Promise<string>;
export class ReleaseConstraint extends Error {}

export function stableVersion(value: string): string | undefined {
  const version = value.replace(/^v/, "").replaceAll("_", ".");
  return /^\d+(?:\.\d+)+(?:\+\d+)?(?:-jre|-android)?$/.test(version) ? version : undefined;
}
export function compareVersions(left: string, right: string): number {
  const a = left
    .replace(/-(?:jre|android)$/, "")
    .split(/[.+-]/)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : 0));
  const b = right
    .replace(/-(?:jre|android)$/, "")
    .split(/[.+-]/)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : 0));
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/** Credentials stay in request headers and are never persisted in plans or metadata. */
export function metadataRequests(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  limits = { cacheBytes: 32 * 1024 * 1024, responseBytes: 64 * 1024 * 1024, pending: 16 },
): MetadataRequest {
  if (
    !Number.isSafeInteger(limits.cacheBytes) ||
    limits.cacheBytes < 0 ||
    !Number.isSafeInteger(limits.responseBytes) ||
    limits.responseBytes < 1 ||
    !Number.isSafeInteger(limits.pending) ||
    limits.pending < 1
  )
    throw new Error("Invalid metadata capacity limits");
  const pending = new Map<string, Promise<string>>();
  const cache = new Map<string, { text: string; bytes: number }>();
  let retained = 0;
  let token: Promise<string | undefined> | undefined;
  const credential = () => {
    token ??= (async () => {
      const configured = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
      if (configured) return configured;
      const timeout = AbortSignal.timeout(60_000);
      const credentialSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const result = await captureOwnedChild(
        "gh",
        ["auth", "token", "--hostname", "github.com"],
        { cwd: process.cwd(), env: process.env, signal: credentialSignal },
        16 * 1024,
      );
      credentialSignal.throwIfAborted();
      return !result.error && result.status === 0 ? result.stdout.trim() || undefined : undefined;
    })();
    return token;
  };
  return (url, accept = "application/json") => {
    signal?.throwIfAborted();
    if (new URL(url).protocol !== "https:") throw new Error("Maintenance sources require HTTPS");
    const key = JSON.stringify([url, accept]);
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return Promise.resolve(cached.text);
    }
    const active = pending.get(key);
    if (active) return active;
    if (pending.size >= limits.pending)
      return Promise.reject(new Error("Maintenance metadata request capacity exhausted"));
    const request = (async () => {
      const headers: Record<string, string> = { Accept: accept, "User-Agent": "Workbench-maintenance" };
      if (new URL(url).hostname === "api.github.com") {
        const value = await credential();
        if (value) headers.Authorization = `Bearer ${value}`;
      }
      const timeout = AbortSignal.timeout(60_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      requestSignal.throwIfAborted();
      const response = await fetcher(url, { headers, redirect: "error", signal: requestSignal });
      requestSignal.throwIfAborted();
      const body = await metadataBytes(response, limits.responseBytes, url, requestSignal);
      const bytes = body.length,
        text = body.toString("utf8");
      if (bytes <= limits.cacheBytes) {
        while (retained + bytes > limits.cacheBytes) {
          const oldest = cache.entries().next().value;
          if (!oldest) break;
          cache.delete(oldest[0]);
          retained -= oldest[1].bytes;
        }
        cache.set(key, { text, bytes });
        retained += bytes;
      }
      return text;
    })().finally(() => {
      pending.delete(key);
    });
    pending.set(key, request);
    return request;
  };
}

export class MaintenanceSources {
  constructor(readonly request: MetadataRequest = metadataRequests()) {}
  async json(url: string, accept?: string): Promise<unknown> {
    return JSON.parse(await this.request(url, accept)) as unknown;
  }
  async github(repository: string, prefix = "v", perPage = 100): Promise<Release[]> {
    const url = `https://api.github.com/repos/${repository}/releases?per_page=${String(perPage)}`;
    const releases: Release[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch = records(
        await this.json(page === 1 ? url : `${url}&page=${String(page)}`),
        "Invalid GitHub release index",
      );
      releases.push(
        ...batch.flatMap((entry): Release[] => {
          const tag = string(entry.tag_name, "Missing GitHub release tag");
          if (entry.draft === true || entry.prerelease === true || !tag.startsWith(prefix)) return [];
          const version = stableVersion(tag.slice(prefix.length));
          if (!version) return [];
          return [
            {
              version,
              reference: string(entry.html_url, "Missing release reference"),
              assets: records(entry.assets, "Missing release assets").map((asset) => {
                const digest =
                  typeof asset.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(asset.digest)
                    ? asset.digest.slice(7)
                    : undefined;
                return {
                  name: string(asset.name, "Missing asset name"),
                  url: string(asset.browser_download_url, "Missing asset URL"),
                  ...(digest ? { sha256: digest } : {}),
                };
              }),
            },
          ];
        }),
      );
      if (batch.length < perPage) return releases;
    }
    throw new Error(`GitHub release index exceeds 20 pages: ${repository}; discovery is incomplete`);
  }
  async npm(name: string, major?: string): Promise<Release[]> {
    const base = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
    const value = record(await this.json(base, "application/vnd.npm.install-v1+json"), "Invalid npm metadata");
    return Object.entries(record(value.versions, "Missing npm versions")).flatMap(([version, metadata]) => {
      if (!stableVersion(version) || (major !== undefined && !version.startsWith(`${major}.`))) return [];
      const dist = record(record(metadata, "Invalid npm release").dist ?? {}, "Invalid npm distribution");
      return [
        {
          version,
          reference: base,
          ...(typeof dist.integrity === "string" ? { integrity: dist.integrity } : {}),
          ...(typeof dist.tarball === "string" ? { assets: [{ name: `${name}@${version}`, url: dist.tarball }] } : {}),
        },
      ];
    });
  }

  async pypi(name: string): Promise<Release[]> {
    const url = `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
    const value = record(await this.json(url), "Invalid PyPI metadata");
    return Object.entries(record(value.releases, "Missing Python releases")).flatMap(([version, raw]) => {
      if (!stableVersion(version)) return [];
      const files = records(raw, "Invalid Python release files").filter((file) => file.yanked !== true);
      if (!files.length) return [];
      const assets = files.flatMap((file) => {
        if (typeof file.filename !== "string" || typeof file.url !== "string") return [];
        const digest = record(file.digests ?? {}, "Invalid Python distribution hashes").sha256;
        return [{ name: file.filename, url: file.url, ...(typeof digest === "string" ? { sha256: digest } : {}) }];
      });
      return [{ version, reference: url, ...(assets.length ? { assets } : {}) }];
    });
  }
  async gem(name: string): Promise<Release[]> {
    const url = `https://rubygems.org/api/v1/versions/${encodeURIComponent(name)}.json`;
    const releases = new Map<string, Release>();
    for (const entry of records(await this.json(url), "Invalid RubyGems metadata")) {
      const version = stableVersion(string(entry.number, "Missing gem version"));
      if (!version || entry.prerelease === true) continue;
      const release: Release = releases.get(version) ?? { version, reference: url };
      if (typeof entry.sha === "string") {
        if (!/^[a-f0-9]{64}$/i.test(entry.sha)) throw new Error("Invalid RubyGems SHA-256");
        const platform = typeof entry.platform === "string" ? entry.platform : "ruby";
        const abi = typeof entry.ruby_abi === "string" ? entry.ruby_abi : "default";
        const portable = platform === "ruby" && abi === "default";
        const nameInRegistry = portable ? `${name}-${version}.gem` : `${name}@${version}[${platform};${abi}]`;
        const assets = (release.assets ??= []);
        const previous = assets.find((asset) => asset.name === nameInRegistry);
        if (previous && previous.sha256 !== entry.sha.toLowerCase())
          throw new Error(`Ambiguous RubyGems artifact: ${nameInRegistry}`);
        if (!previous)
          assets.push({
            name: nameInRegistry,
            sha256: entry.sha.toLowerCase(),
            ...(portable ? { url: `https://rubygems.org/downloads/${name}-${version}.gem` } : {}),
          });
      }
      releases.set(version, release);
    }
    return [...releases.values()];
  }
  async composer(name: string, php?: string, minimum?: string): Promise<Release[]> {
    if (php) {
      const url = `https://packagist.org/packages/${name}.json`;
      const value = record(
        record(await this.json(url), "Invalid Packagist response").package,
        "Missing package metadata",
      );
      return Object.values(record(value.versions, "Missing package versions")).flatMap((raw) => {
        const entry = record(raw, "Invalid Composer release");
        const version = stableVersion(string(entry.version, "Missing Composer version"));
        if (!version || (minimum && compareVersions(version, minimum) < 0)) return [];
        const requirements = record(entry.require ?? {}, "Invalid Composer requirements");
        const requirement =
          requirements.php === undefined
            ? "*"
            : string(requirements.php, "Invalid PHP requirement")
                .replace(/\s*\|{1,2}\s*/g, " || ")
                // Composer's ~8.1 includes the entire major; npm's ~8.1 only includes the minor.
                .replace(
                  /(^|[\s|])~\s*(\d+)\.(\d+)(?=$|[\s|])/g,
                  (_match, before: string, major: string, minor: string) =>
                    `${before}>=${major}.${minor}.0 <${String(Number(major) + 1)}.0.0`,
                );
        if (!validRange(requirement)) throw new Error(`Unsupported Composer PHP constraint: ${requirement}`);
        return satisfies(php, requirement) ? [{ version, reference: url }] : [];
      });
    }
    const url = `https://repo.packagist.org/p2/${name}.json`;
    const packages = record(
      record(await this.json(url), "Invalid Packagist metadata").packages,
      "Missing package index",
    );
    return records(packages[name], "Missing Composer package").flatMap((entry) => {
      const version = stableVersion(string(entry.version, "Missing Composer version"));
      return version ? [{ version, reference: url }] : [];
    });
  }
  async maven(group: string, artifact: string): Promise<Release[]> {
    const url = `https://repo.maven.apache.org/maven2/${group.replaceAll(".", "/")}/${artifact}/maven-metadata.xml`;
    const dom = new JSDOM(await this.request(url, "application/xml"), { contentType: "text/xml" });
    try {
      return [...dom.window.document.querySelectorAll("versioning > versions > version")].flatMap((entry) => {
        const version = stableVersion(entry.textContent);
        return version ? [{ version, reference: url }] : [];
      });
    } finally {
      dom.window.close();
    }
  }
  async branch(repository: string, branch: string): Promise<Release[]> {
    const url = `https://api.github.com/repos/${repository}/git/ref/heads/${branch}`;
    const value = record(record(await this.json(url), "Invalid GitHub ref").object, "Missing GitHub commit");
    const version = string(value.sha, "Missing Git revision");
    if (!/^[a-f0-9]{40}$/.test(version)) throw new Error("Invalid Git revision");
    return [{ version, reference: url }];
  }
  async tagRevision(repository: string, tag: string): Promise<string> {
    let url = `https://api.github.com/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`;
    for (let depth = 0; depth < 8; depth++) {
      const value = record(record(await this.json(url), "Invalid GitHub tag").object, "Missing tag object");
      const sha = string(value.sha, "Missing tag revision");
      if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid tag revision");
      if (value.type === "commit") return sha;
      if (value.type !== "tag") throw new Error("Release tag does not identify a commit");
      url = `https://api.github.com/repos/${repository}/git/tags/${sha}`;
    }
    throw new Error("Release tag indirection exceeds eight levels");
  }
  async docker(image: string, platform?: string): Promise<Release[]> {
    const match = /^(?:docker\.io\/)?([a-z0-9_-]+(?:\/[a-z0-9_.-]+)?)(?::([A-Za-z0-9_.-]+))?$/.exec(image);
    const repository = required(match?.[1], `No public Docker Hub metadata adapter for ${image}`);
    const name = repository.includes("/") ? repository : `library/${repository}`;
    const url = `https://hub.docker.com/v2/repositories/${name}/tags/${match?.[2] ?? "latest"}`;
    const value = record(await this.json(url), "Invalid Docker Hub tag metadata");
    let selected = value;
    if (platform !== undefined) {
      const targets: Record<string, { os: string; architecture: string }> = {
        "linux-x64": { os: "linux", architecture: "amd64" },
        "linux-arm64": { os: "linux", architecture: "arm64" },
      };
      const target = required(targets[platform], `No Docker image adapter for platform ${platform}`);
      const matching = records(value.images, "Missing Docker image platform metadata").filter(
        (image) => image.os === target.os && image.architecture === target.architecture,
      );
      if (matching.length !== 1) throw new Error(`Docker tag has no unique image for ${platform}: ${url}`);
      selected = required(matching[0], "Missing selected image platform");
    }
    const version = string(selected.digest, "Missing image digest");
    if (!/^sha256:[a-f0-9]{64}$/.test(version)) throw new Error("Invalid image manifest digest");
    return [{ version, reference: url }];
  }
  async node(): Promise<Release[]> {
    const url = "https://nodejs.org/dist/index.json";
    return records(await this.json(url), "Invalid Node release index").flatMap((entry) => {
      const version = stableVersion(string(entry.version, "Missing Node version"));
      return version ? [{ version, reference: url }] : [];
    });
  }
  async go(): Promise<Release[]> {
    const url = "https://go.dev/dl/?mode=json&include=all";
    return records(await this.json(url), "Invalid Go release index").flatMap((entry) => {
      const version = stableVersion(string(entry.version, "Missing Go version").replace(/^go/, ""));
      return version
        ? [
            {
              version,
              reference: url,
              assets: records(entry.files, "Missing Go release files").map((file) => ({
                name: string(file.filename, "Missing Go filename"),
                url: `https://go.dev/dl/${string(file.filename, "Missing Go filename")}`,
                sha256: string(file.sha256, "Missing Go digest"),
              })),
            },
          ]
        : [];
    });
  }
  async python(): Promise<Release[]> {
    const url = "https://www.python.org/api/v2/downloads/release/?is_published=true";
    return records(await this.json(url), "Invalid Python release index").flatMap((entry) => {
      if (entry.pre_release === true) return [];
      const version = stableVersion(string(entry.name, "Missing Python release name").replace(/^Python /, ""));
      return version ? [{ version, reference: url }] : [];
    });
  }
  async ruby(): Promise<Release[]> {
    const url = "https://raw.githubusercontent.com/ruby/www.ruby-lang.org/master/_data/releases.yml";
    return records(parseYaml(await this.request(url, "text/plain")) as unknown, "Invalid Ruby release index").flatMap(
      (entry) => {
        const version = stableVersion(string(entry.version, "Missing Ruby version"));
        return version ? [{ version, reference: url }] : [];
      },
    );
  }
  async php(): Promise<Release[]> {
    const url = "https://www.php.net/releases/index.php?json&version=8";
    const value = record(await this.json(url), "Invalid PHP release index");
    if (typeof value.version === "string")
      return [{ version: required(stableVersion(value.version), "Missing stable PHP release"), reference: url }];
    return Object.keys(value).flatMap((version) => (stableVersion(version) ? [{ version, reference: url }] : []));
  }
  async rust(channel = "stable", requiredTargets: readonly string[] = []): Promise<Release[]> {
    const url = `https://static.rust-lang.org/dist/channel-rust-${channel}.toml`;
    const value = parseToml(await this.request(url, "text/plain"));
    const packages = record(value.pkg, "Missing Rust packages");
    const rust = record(packages.rust, "Missing Rust toolchain");
    if (channel === "nightly" && requiredTargets.length) {
      const miri = record(record(packages["miri-preview"], "Missing Miri component").target, "Missing Miri targets");
      for (const target of requiredTargets)
        if (record(miri[target] ?? {}, "Invalid Miri target").available !== true)
          throw new ReleaseConstraint(
            `The published nightly has no Miri component for ${target}; retain the selected nightly`,
          );
      const source = record(
        record(packages["rust-src"], "Missing Rust source component").target,
        "Missing Rust source targets",
      );
      if (record(source["*"] ?? {}, "Invalid Rust source component").available !== true)
        throw new ReleaseConstraint(
          "The published nightly lacks rust-src required by Miri; retain the selected nightly",
        );
    }
    const version =
      channel === "nightly"
        ? `nightly-${string(value.date, "Missing nightly date")}`
        : string(rust.version, "Missing Rust version").split(" ")[0];
    if (!version) throw new Error("Missing Rust version");
    return [{ version, reference: url }];
  }
  async gcc(): Promise<Release[]> {
    const url = "https://gcc.gnu.org/pub/gcc/releases/";
    const dom = new JSDOM(await this.request(url, "text/html"));
    try {
      return [...dom.window.document.querySelectorAll("a[href]")].flatMap((anchor) => {
        const version = stableVersion((anchor.getAttribute("href") ?? "").replace(/^gcc-/, "").replace(/\/$/, ""));
        return version ? [{ version, reference: url }] : [];
      });
    } finally {
      dom.window.close();
    }
  }
  async rustup(): Promise<Release[]> {
    const url = "https://static.rust-lang.org/rustup/release-stable.toml";
    return [
      {
        version: string(parseToml(await this.request(url, "text/plain")).version, "Missing Rustup release"),
        reference: url,
      },
    ];
  }
  async playwrightBrowser(version: string): Promise<Release> {
    const url = `https://raw.githubusercontent.com/microsoft/playwright/v${version}/packages/playwright-core/browsers.json`;
    const data = record(await this.json(url), "Invalid browser compatibility metadata");
    const browser = records(data.browsers, "Missing browser index").find(
      (browser) => browser.name === "chromium-headless-shell",
    );
    return { version: string(browser?.browserVersion, "Missing paired browser version"), reference: url };
  }
}

export function latestRelease(releases: Release[], current: string, sameMajor = false): Release {
  const suitable = releases.filter((entry) => !sameMajor || entry.version.split(".")[0] === current.split(".")[0]);
  return required(
    suitable.sort((a, b) => compareVersions(b.version, a.version))[0],
    `No stable release for ${current}`,
  );
}
