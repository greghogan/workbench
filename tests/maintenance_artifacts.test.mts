import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { MaintenanceSources } from "../scripts/maintenance/sources.mjs";
import { developmentDiscovery, discoverMaintenance } from "../scripts/maintenance/plan.mjs";
import { maintenanceMain } from "../scripts/maintenance/main.mjs";
import { applyMaintenance } from "../scripts/maintenance/apply.mjs";
import { MaintenanceKind, MaintenanceState, type MaintenanceCommand } from "../scripts/maintenance/contract.mjs";
import type { ToolAsset } from "../src/tool-downloads.js";
import { fixtureSignedToolAsset } from "./fixtures/tool-asset.mjs";
import { readNativeCatalogs } from "../scripts/maintenance/native.mjs";
import { bindPublication, recipeDigest } from "../scripts/maintenance/publication.mjs";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
const version = "8.5.1";
const sourceHash = "a".repeat(64),
  originalHash = "b".repeat(64),
  rebuiltHash = "c".repeat(64);
const windowsCatalog = "https://downloads.php.net/~windows/releases/releases.json";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-artifact-maintenance-"));
  temporary.push(root);
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, "state"));
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "cache"));
  const source = {
    url: `https://www.php.net/distributions/php-${version}.tar.xz`,
    sha256: sourceHash,
    format: "tar",
    strip: 1,
    bin: "bin",
    build: "php",
    signature: {
      url: `https://www.php.net/distributions/php-${version}.tar.xz.asc`,
      keys: "human-keyring.asc",
      signers: ["human-selected-signer"],
    },
  } satisfies ToolAsset;
  const windows = {
    url: `https://downloads.php.net/~windows/releases/php-${version}-nts-Win32-vs17-x64.zip`,
    sha256: originalHash,
    format: "zip",
    strip: 0,
    bin: ".",
    phpExtensions: ["curl", "openssl"],
    backupUrls: [`https://windows.php.net/downloads/releases/php-${version}-nts-Win32-vs17-x64.zip`],
    authenticationUnavailable: {
      source: windowsCatalog,
      checked: "2020-01-01",
      reason: "The publisher provides checksums without detached signatures.",
    },
  } satisfies ToolAsset;
  const catalog = {
    php: { [version]: { "linux-x64": source, "linux-arm64": source, "darwin-arm64": source, "win32-x64": windows } },
  };
  const write = (path: string, contents: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  write("workbench/projects.toml", '[[language_root]]\npath="."\nlanguage="php"\n');
  write("workbench/config.toml", "schema_version=1\n");
  write(".php-version", version + "\n");
  write("scripts/native-assets.json", JSON.stringify(catalog));
  return { root, catalog, write, read: (path: string) => readFileSync(join(root, path), "utf8") };
}
function metadata(
  options: {
    revision?: number;
    hash?: string;
    runtime?: string;
    feedVersion?: string;
    missing?: boolean;
    badPath?: boolean;
    proof?: boolean;
  } = {},
) {
  const revision = options.revision ?? 1;
  const runtime = options.runtime ?? options.feedVersion ?? version;
  const packageVersion = runtime + (revision ? `-${String(revision)}` : "");
  const windows = {
    "8.5": {
      version: packageVersion,
      ...(!options.missing
        ? {
            "nts-vs17-x64": {
              zip: {
                path: options.badPath ? "../unexpected.zip" : `php-${packageVersion}-nts-Win32-vs17-x64.zip`,
                sha256: options.hash ?? rebuiltHash,
                ...(options.proof ? { signature: "new-signature.asc" } : {}),
              },
            },
          }
        : {}),
    },
  };
  const releaseVersion = options.feedVersion ?? version;
  const release = {
    version: releaseVersion,
    source: [{ filename: `php-${releaseVersion}.tar.xz`, sha256: sourceHash }],
  };
  return (url: string) => {
    if (url === windowsCatalog) return Promise.resolve(JSON.stringify(windows));
    if (url === "https://www.php.net/releases/index.php?json&version=8")
      return Promise.resolve(JSON.stringify(release));
    throw new Error(`Unexpected metadata request: ${url}`);
  };
}
const planOptions = { kinds: [MaintenanceKind.Toolchains] };
const noCommands = () => Promise.reject(new Error("Artifact-only updates must not run package managers"));

test("the generated maintenance command starts without depending on emitted project source modules", () => {
  const f = fixture();
  const command = join(import.meta.dirname, "../scripts/maintenance/main.mjs");
  const result = spawnSync(process.execPath, [command, "--help"], { cwd: f.root, encoding: "utf8" });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("plan");
  expect(result.stdout).toContain("apply");
});

test("a Windows rebuild updates artifact metadata without rewriting the PHP runtime pin or Unix trust policy", async () => {
  const f = fixture(),
    sources = new MaintenanceSources(metadata());
  const plan = await discoverMaintenance(f.root, developmentDiscovery(sources, f.root), planOptions);
  const entry = plan.entries.find((entry) => entry.name === "php");
  expect(entry?.state).toBe(MaintenanceState.Available);
  expect(entry?.selected?.version).toBe(version);
  expect(entry?.reason).toMatch(/runtime version is unchanged/);
  await applyMaintenance(f.root, plan, { sources, run: noCommands });
  expect(f.read(".php-version")).toBe(version + "\n");
  const result = JSON.parse(f.read("scripts/native-assets.json")) as typeof f.catalog;
  const recipes = result.php[version];
  for (const platform of ["linux-x64", "linux-arm64", "darwin-arm64"] as const)
    expect(recipes[platform]).toEqual(f.catalog.php[version][platform]);
  expect(recipes["win32-x64"].sha256).toBe(rebuiltHash);
  expect(recipes["win32-x64"].url).toContain(`php-${version}-1-nts-Win32-vs17-x64.zip`);
  expect(recipes["win32-x64"].backupUrls[0]).toContain(`php-${version}-1-nts-Win32-vs17-x64.zip`);
  expect(recipes["win32-x64"].phpExtensions).toEqual(["curl", "openssl"]);
  const current = await discoverMaintenance(f.root, developmentDiscovery(sources, f.root), planOptions);
  expect(current.entries.find((entry) => entry.name === "php")?.state).toBe(MaintenanceState.Current);
});

test("formatting, key order, and prior proof-check dates do not make an unchanged artifact an update", async () => {
  const f = fixture();
  const sources = new MaintenanceSources(metadata({ revision: 0, hash: originalHash }));
  const initial = await discoverMaintenance(f.root, developmentDiscovery(sources, f.root), planOptions);
  const selected = initial.entries.find((entry) => entry.name === "php");
  if (!selected?.selected) throw new Error("Missing PHP publication");
  const object = f.catalog.php[version]["win32-x64"];
  f.catalog.php[version]["win32-x64"] = Object.fromEntries(Object.entries(object).reverse()) as typeof object;
  f.catalog.php[version]["win32-x64"].authenticationUnavailable.checked = "2021-02-03";
  f.write("scripts/native-assets.json", JSON.stringify(f.catalog, null, 4));
  const rebound = await bindPublication(readNativeCatalogs(f.root), selected, selected.selected, sources);
  expect(rebound.release.artifacts).toEqual(selected.selected.artifacts);
  const plan = await discoverMaintenance(f.root, developmentDiscovery(sources, f.root), planOptions);
  expect(plan.entries.find((entry) => entry.name === "php")?.state).toBe(MaintenanceState.Current);
});

test("rendering publishes exactly the reviewed payload even if upstream changes after apply resolves it", async () => {
  const f = fixture();
  let upstream = metadata();
  let onArchiveRead = () => undefined;
  const sources = new MaintenanceSources(async (url) => {
    const payload = await upstream(url);
    if (url === windowsCatalog) onArchiveRead();
    return payload;
  });
  const plan = await discoverMaintenance(f.root, developmentDiscovery(sources, f.root), planOptions);
  // Start apply with the reviewed publication, then advance the publisher as soon as that response has been captured.
  onArchiveRead = () => {
    upstream = metadata({ revision: 2, hash: "d".repeat(64) });
  };
  await applyMaintenance(f.root, plan, { sources, run: noCommands });
  const catalog = JSON.parse(f.read("scripts/native-assets.json")) as typeof f.catalog;
  for (const identity of plan.entries.find((entry) => entry.name === "php")?.selected?.artifacts ?? []) {
    const recipe = catalog.php[version][identity.platform as keyof (typeof catalog.php)[typeof version]];
    expect(recipeDigest(recipe)).toBe(identity.recipeSHA256);
    expect(recipe.sha256).toBe(identity.sha256);
  }
  expect(catalog.php[version]["win32-x64"].url).toContain(`php-${version}-1-nts`);
  expect(catalog.php[version]["win32-x64"].sha256).toBe(rebuiltHash);
});

test("batched same-version artifact updates verify independently and preserve both runtime pins", async () => {
  const f = fixture();
  const nodeVersion = "22.1.0",
    filename = `node-v${nodeVersion}-linux-x64.tar.gz`;
  const nodeRecipe = {
    ...fixtureSignedToolAsset("node", nodeVersion),
    url: `https://nodejs.org/dist/v${nodeVersion}/${filename}`,
    sha256: "e".repeat(64),
    signature: {
      url: "https://nodejs.org/SHASUMS256.txt.sig",
      keys: "human-selected-node-keys.asc",
      signers: ["a".repeat(40)],
    },
  } satisfies ToolAsset;
  f.write(".node-version", nodeVersion + "\n");
  f.write(
    "scripts/native-assets.json",
    JSON.stringify({ ...f.catalog, node: { [nodeVersion]: { "linux-x64": nodeRecipe } } }),
  );
  const php = metadata();
  const sources = new MaintenanceSources((url) => {
    if (url === "https://nodejs.org/dist/index.json")
      return Promise.resolve(JSON.stringify([{ version: `v${nodeVersion}` }]));
    if (url.endsWith("/SHASUMS256.txt")) return Promise.resolve(`${"f".repeat(64)}  ${filename}\n`);
    return php(url);
  });
  const plan = await discoverMaintenance(f.root, developmentDiscovery(sources, f.root), planOptions);
  expect(
    plan.entries
      .filter((entry) => entry.state === MaintenanceState.Available)
      .map((entry) => entry.name)
      .sort(),
  ).toEqual(["node", "php"]);
  await applyMaintenance(f.root, plan, { sources, run: noCommands });
  const result = JSON.parse(f.read("scripts/native-assets.json")) as typeof f.catalog & {
    node: Record<string, Record<string, typeof nodeRecipe>>;
  };
  expect(result.node[nodeVersion]?.["linux-x64"]?.sha256).toBe("f".repeat(64));
  expect(result.node[nodeVersion]?.["linux-x64"]?.signature).toEqual(nodeRecipe.signature);
  expect(result.php[version]["win32-x64"].sha256).toBe(rebuiltHash);
  expect(f.read(".php-version")).toBe(version + "\n");
  expect(f.read(".node-version")).toBe(nodeVersion + "\n");
});

test("a changed checksum is detected even when the upstream filename and runtime version stay unchanged", async () => {
  const f = fixture(),
    sources = new MaintenanceSources(metadata({ revision: 0 }));
  const plan = await discoverMaintenance(f.root, developmentDiscovery(sources, f.root), planOptions);
  expect(plan.entries.find((entry) => entry.name === "php")?.state).toBe(MaintenanceState.Available);
  await applyMaintenance(f.root, plan, { sources, run: noCommands });
  expect(f.read(".php-version")).toBe(version + "\n");
  expect((JSON.parse(f.read("scripts/native-assets.json")) as typeof f.catalog).php[version]["win32-x64"].sha256).toBe(
    rebuiltHash,
  );
});

test("older package revisions are rejected while newer PHP runtimes may start a fresh package revision", async () => {
  const f = fixture();
  const windows = f.catalog.php[version]["win32-x64"];
  windows.url = windows.url.replace(`php-${version}-nts`, `php-${version}-2-nts`);
  f.write("scripts/native-assets.json", JSON.stringify(f.catalog));
  const stale = new MaintenanceSources(metadata());
  const declined = await discoverMaintenance(f.root, developmentDiscovery(stale, f.root), planOptions);
  expect(declined.entries.find((entry) => entry.name === "php")?.state).toBe(MaintenanceState.Constrained);
  expect(declined.entries.find((entry) => entry.name === "php")?.reason).toContain("no downgrade");
  const newer = "8.5.2",
    sources = new MaintenanceSources(metadata({ feedVersion: newer, revision: 0 }));
  const plan = await discoverMaintenance(f.root, developmentDiscovery(sources, f.root), planOptions);
  expect(plan.entries.find((entry) => entry.name === "php")?.state).toBe(MaintenanceState.Available);
  await applyMaintenance(f.root, plan, { sources, run: noCommands });
  expect(f.read(".php-version")).toBe(newer + "\n");
  const catalog = JSON.parse(f.read("scripts/native-assets.json")) as {
    php: Record<string, (typeof f.catalog.php)[typeof version]>;
  };
  expect(catalog.php[newer]?.["win32-x64"].url).toContain(`php-${newer}-nts-Win32-vs17-x64.zip`);
  expect(catalog.php[newer]?.["linux-x64"].signature.keys).toBe("human-keyring.asc");
});

test("a second upstream rebuild invalidates a reviewed plan before any project file changes", async () => {
  const f = fixture();
  let upstream = metadata();
  const sources = new MaintenanceSources((url) => upstream(url));
  const plan = await discoverMaintenance(f.root, developmentDiscovery(sources, f.root), planOptions);
  const original = f.read("scripts/native-assets.json");
  upstream = metadata({ revision: 2, hash: "d".repeat(64) });
  await expect(applyMaintenance(f.root, plan, { sources, run: noCommands })).rejects.toThrow(
    /publication identity changed/,
  );
  expect(f.read("scripts/native-assets.json")).toBe(original);
  expect(f.read(".php-version")).toBe(version + "\n");
});

test.each([
  [{ missing: true }, /no nts-vs17-x64 package/],
  [{ badPath: true }, /does not match/],
  [{ runtime: "8.5.0" }, /does not provide runtime/],
  [{ hash: "not-a-checksum" }, /SHA-256/],
  [{ proof: true }, /authentication evidence/],
] as const)(
  "unverifiable Windows packages are not reported current or allowed to weaken authentication: %j",
  async (options, diagnostic) => {
    const f = fixture(),
      original = f.read("scripts/native-assets.json"),
      sources = new MaintenanceSources(metadata(options));
    const plan = await discoverMaintenance(f.root, developmentDiscovery(sources, f.root), planOptions);
    const entry = plan.entries.find((entry) => entry.name === "php");
    expect([MaintenanceState.Constrained, MaintenanceState.Unavailable]).toContain(entry?.state);
    expect(entry?.reason).toMatch(diagnostic);
    expect(f.read("scripts/native-assets.json")).toBe(original);
  },
);

test("same-version LLVM artifacts are checked and verified alongside other native updates", async () => {
  const f = fixture(),
    llvmVersion = "23.1.3",
    filename = `clang+llvm-${llvmVersion}-linux-x64.tar.xz`;
  f.write(".llvm-version", llvmVersion + "\n");
  const recipe = {
    name: filename,
    sha256: "e".repeat(64),
    attestation: `example/llvm@refs/tags/llvmorg-${llvmVersion}`,
  };
  f.write("scripts/llvm-assets.json", JSON.stringify({ [llvmVersion]: { "linux-x64": recipe } }));
  const php = metadata();
  const sources = new MaintenanceSources((url) => {
    if (url.startsWith("https://api.github.com/repos/llvm/llvm-project/releases?"))
      return Promise.resolve(
        JSON.stringify([
          {
            tag_name: `llvmorg-${llvmVersion}`,
            html_url: `https://github.com/llvm/llvm-project/releases/tag/llvmorg-${llvmVersion}`,
            assets: [
              {
                name: filename,
                browser_download_url: `https://github.com/llvm/llvm-project/releases/download/llvmorg-${llvmVersion}/${filename}`,
                digest: `sha256:${"f".repeat(64)}`,
              },
            ],
          },
        ]),
      );
    return php(url);
  });
  const plan = await discoverMaintenance(f.root, developmentDiscovery(sources, f.root), planOptions);
  expect(plan.entries.find((entry) => entry.name === "llvm")?.state).toBe(MaintenanceState.Available);
  await applyMaintenance(f.root, plan, { sources, run: noCommands });
  const catalog = JSON.parse(f.read("scripts/llvm-assets.json")) as Record<string, Record<string, typeof recipe>>;
  expect(catalog[llvmVersion]?.["linux-x64"]).toEqual({ ...recipe, sha256: "f".repeat(64) });
  expect(f.read(".llvm-version")).toBe(llvmVersion + "\n");
});

test.each([false, true])(
  "artifact-only preparation matches its preview, preserves dependency selections, and resumes: %s",
  async (interrupt) => {
    const f = fixture();
    f.write("composer.json", JSON.stringify({ require: { "example/library": "1.0.0" } }));
    f.write("composer.lock", "locked dependency fixture\n");
    const messages: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message: string) => {
      messages.push(message);
    });
    const publisher = metadata();
    vi.stubGlobal("fetch", (url: string) => publisher(url).then((text) => new Response(text)));
    const path = join(f.root, "plan.json");
    await maintenanceMain(["plan", "--kind", "toolchains", "--output", path], f.root, noCommands);
    const executed: MaintenanceCommand[] = [];
    let stop = interrupt;
    const run = (command: MaintenanceCommand) => {
      if (stop && command.arguments.includes("setup")) {
        stop = false;
        return Promise.reject(new Error("interrupted setup"));
      }
      executed.push(command);
      return Promise.resolve("");
    };
    if (interrupt) {
      await expect(maintenanceMain(["apply", path, "--refresh-locks"], f.root, run)).rejects.toThrow(/--resume/);
      await maintenanceMain(["apply", path, "--refresh-locks", "--resume"], f.root, run);
    } else await maintenanceMain(["apply", path, "--refresh-locks"], f.root, run);
    const preview = messages.find((message) => message.startsWith("Lock refresh (changed):\n"));
    if (!preview) throw new Error("Missing preparation preview");
    const commands = executed.filter((command) => !command.arguments.includes("cache-auto-prune"));
    expect(
      commands.map((command) => JSON.stringify([command.cwd, command.command, ...command.arguments])).join("\n"),
    ).toBe(preview.split("\n").slice(1).join("\n"));
    expect(
      commands.some((command) => command.arguments.includes("install") && command.arguments.includes("tools")),
    ).toBe(true);
    expect(commands.some((command) => command.arguments.includes("check") && command.arguments.includes("setup"))).toBe(
      true,
    );
    expect(
      commands.some((command) =>
        command.arguments.some((argument) => ["update", "--upgrade", "dependency-lock"].includes(argument)),
      ),
    ).toBe(false);
    expect(f.read("composer.json")).toBe(JSON.stringify({ require: { "example/library": "1.0.0" } }));
    expect(f.read("composer.lock")).toBe("locked dependency fixture\n");
    expect(f.read(".php-version")).toBe(version + "\n");
  },
);
