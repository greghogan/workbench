import { afterEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "smol-toml";
import { record } from "../scripts/values.mjs";
import { applyMaintenance, readMaintenancePlan } from "../scripts/maintenance/apply.mjs";
import { versionRequirement } from "../scripts/maintenance/edits.mjs";
import { nativeMaintenanceEdits } from "../scripts/maintenance/native.mjs";
import {
  compareVersions,
  latestRelease,
  MaintenanceSources,
  metadataRequests,
  stableVersion,
} from "../scripts/maintenance/sources.mjs";
import {
  type Release,
  MaintenanceKind,
  MaintenanceProvider,
  MaintenanceState,
  requestedVersion,
  type MaintenanceEntry,
  type MaintenanceTarget,
} from "../scripts/maintenance/contract.mjs";
import { developmentDiscovery, discoverMaintenance, maintenanceTargets } from "../scripts/maintenance/plan.mjs";
import { maintenanceMain } from "../scripts/maintenance/main.mjs";

const scratch: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "workbench-maintenance-test-"));
  scratch.push(root);
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, "state"));
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "cache"));
  const write = (path: string, contents: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  for (const [path, contents] of Object.entries({
    "workbench/projects.toml": '[[language_root]]\npath = "."\nlanguage = "typescript"\n',
    "workbench/config.toml": "schema_version = 1\n",
    "scripts/native-assets.json": "{}\n",
    "scripts/llvm-assets.json": "{}\n",
    ...files,
  }))
    write(path, contents);
  return { root, write, read: (path: string) => readFileSync(join(root, path), "utf8") };
}
const release = (version: string): Release => ({ version, reference: `https://example.test/releases/${version}` });
const noCommands = (): Promise<string> => Promise.reject(new Error("Unexpected external command"));

function registry() {
  const fetcher = vi.fn<typeof fetch>((input) => {
    assert.equal(input, "https://registry.npmjs.org/library");
    return Promise.resolve(new Response(JSON.stringify({ versions: { "2.0.0": {} } })));
  });
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  return fetcher;
}

test("maintainer commands plan without mutation and reacquire the selected release before applying", async () => {
  const data = fixture({ "package.json": '{"dependencies":{"library":"^1.0.0"}}\n' });
  const original = data.read("package.json"),
    plan = join(data.root, "reviewed-plan.json");
  const fetcher = registry();
  await maintenanceMain(["plan", "--kind", "dependencies", "--output", plan], data.root, noCommands);
  assert.equal(data.read("package.json"), original);
  assert.equal(fetcher.mock.calls.length, 1);
  await maintenanceMain(["apply", plan], data.root, noCommands);
  assert.deepEqual(JSON.parse(data.read("package.json")), { dependencies: { library: "^2.0.0" } });
  assert.equal(fetcher.mock.calls.length, 2);
});

test("a lock-manager failure leaves reviewed declaration changes and stops later commands", async () => {
  const data = fixture({ "package.json": '{"dependencies":{"library":"1.0.0"}}\n' });
  const plan = join(data.root, "reviewed-plan.json");
  registry();
  await maintenanceMain(["plan", "--kind", "dependencies", "--output", plan], data.root, noCommands);
  let commands = 0;
  await assert.rejects(
    maintenanceMain(["apply", plan, "--refresh-locks"], data.root, (command) => {
      commands++;
      assert.equal(command.command, process.execPath);
      assert.equal(command.cwd, data.root);
      return Promise.reject(new Error("fixture lock-manager failure"));
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /--resume/);
      assert.ok(error.cause instanceof Error);
      assert.equal(error.cause.message, "fixture lock-manager failure");
      return true;
    },
  );
  assert.equal(commands, 1);
  assert.deepEqual(JSON.parse(data.read("package.json")), { dependencies: { library: "2.0.0" } });
});

test("a cancelled maintainer plan neither acquires metadata nor publishes a plan", async () => {
  const data = fixture({ "package.json": '{"dependencies":{"library":"1.0.0"}}\n' });
  const plan = join(data.root, "cancelled-plan.json"),
    controller = new AbortController();
  const fetcher = registry();
  controller.abort();
  await assert.rejects(maintenanceMain(["plan", "--output", plan], data.root, noCommands, controller.signal), {
    name: "AbortError",
  });
  assert.equal(fetcher.mock.calls.length, 0);
  assert.equal(existsSync(plan), false);
});

test.each(["1.2.3", "v2.0.0", "25.0.5+8", "33.7.2-jre", "33.7.2-android"])(
  "accepts stable upstream version %s",
  (version) => {
    assert.ok(stableVersion(version));
  },
);
test.each(["1.3.0-rc1", "2.0.0beta1", "nightly", "v1.2.3-pre", ""])(
  "rejects prerelease or non-version %s",
  (version) => {
    assert.equal(stableVersion(version), undefined);
  },
);
test("orders numeric releases and respects selected runtime majors", () => {
  assert.ok(compareVersions("1.10.0", "1.9.99") > 0);
  assert.ok(compareVersions("25.0.5+8", "25.0.5+2") > 0);
  assert.equal(
    latestRelease([release("22.3.0"), release("24.1.0"), release("22.10.0")], "22.1.0", true).version,
    "22.10.0",
  );
  assert.throws(() => latestRelease([release("24.0.0")], "22.0.0", true), /No stable release/);
  assert.equal(requestedVersion("v0.0.0-20261014143641-f0251eb4aa3e"), "0.0.0-20261014143641-f0251eb4aa3e");
  assert.equal(versionRequirement("npm:@vendor/compiler@^6.2.0", "7.1.0"), "npm:@vendor/compiler@^7.1.0");
  assert.equal(versionRequirement("mypy>=2.0.0,<3", "2.4.1"), "mypy>=2.4.1,<3");
});

test("Python updates preserve package names and extras even with one-component bounds", async () => {
  const data = fixture({ "pyproject.toml": '[dependency-groups]\ndev = ["mypy[extra] >=2,<3"] # keep\n' });
  const discover = () => Promise.resolve([release("2.4.1")]);
  const plan = await discoverMaintenance(data.root, discover);
  assert.equal(plan.entries[0]?.state, MaintenanceState.Available);
  await applyMaintenance(data.root, plan, { discover, run: noCommands });
  assert.deepEqual(record(parse(data.read("pyproject.toml"))["dependency-groups"], "Missing group").dev, [
    "mypy[extra] >=2.4.1,<3",
  ]);
  assert.match(data.read("pyproject.toml"), /# keep/);
});

test.each([">=2,<3", ">=2.4.0,<3", ">=2,!=3.0.0", "~=2.4"])(
  "Python upgrades reject contradictory or unsupported remaining constraints: %s",
  async (requirement) => {
    const original = `[dependency-groups]\ndev = ["mypy${requirement}"]\n`;
    const data = fixture({ "pyproject.toml": original });
    const discover = () => Promise.resolve([release("3.0.0")]);
    const plan = await discoverMaintenance(data.root, discover);
    assert.equal(plan.entries[0]?.state, MaintenanceState.Constrained);
    assert.match(plan.entries[0].reason, /constraints/);
    const entry = plan.entries[0];
    assert.ok(entry);
    const forged = {
      ...plan,
      entries: plan.entries.map((item) =>
        item === entry ? { ...item, state: MaintenanceState.Available, selected: release("3.0.0") } : item,
      ),
    };
    await assert.rejects(applyMaintenance(data.root, forged, { discover, run: noCommands }), /constraints/);
    assert.equal(data.read("pyproject.toml"), original);
  },
);

test("Docker image upgrades replace every matching FROM without changing comments", async () => {
  const old = `sha256:${"a".repeat(64)}`;
  const next = `sha256:${"b".repeat(64)}`;
  const data = fixture({
    ".devcontainer/Dockerfile": `# previously used node:24@${old}\nFROM node:24@${old} AS first\nFROM --platform=linux/amd64 node:24@${old} AS second\n`,
  });
  const discover = () => Promise.resolve([release(next)]);
  const plan = await discoverMaintenance(data.root, discover);
  await applyMaintenance(data.root, plan, { discover, run: noCommands });
  assert.equal(
    data.read(".devcontainer/Dockerfile"),
    `# previously used node:24@${old}\nFROM node:24@${next} AS first\nFROM --platform=linux/amd64 node:24@${next} AS second\n`,
  );
});

test("metadata requests share reads, reject failures and insecure sources, and bound responses", async () => {
  let requests = 0;
  const request = metadataRequests(() => {
    requests++;
    return Promise.resolve(new Response('{"version":"1.0.0"}'));
  });
  assert.deepEqual(
    await Promise.all([
      request("https://registry.example.test/latest"),
      request("https://registry.example.test/latest"),
    ]),
    ['{"version":"1.0.0"}', '{"version":"1.0.0"}'],
  );
  assert.equal(requests, 1);
  assert.throws(() => request("http://registry.example.test/latest"), /HTTPS/);
  await assert.rejects(
    metadataRequests(() => Promise.resolve(new Response("unavailable", { status: 503 })))(
      "https://example.test/latest",
    ),
    /HTTP 503/,
  );
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(64 * 1024 * 1024 + 1));
      controller.close();
    },
  });
  await assert.rejects(
    metadataRequests(() => Promise.resolve(new Response(oversized)))("https://example.test/latest"),
    /exceeds 67108864 bytes/,
  );
});

test("release sources filter drafts and prereleases and preserve published verification data", async () => {
  const metadata = (url: string) => {
    if (url.includes("api.github.com") && url.includes("/releases"))
      return JSON.stringify([
        { tag_name: "v9.0.0", prerelease: true },
        { tag_name: "v8.0.0", draft: true },
        {
          tag_name: "v1.2.3",
          html_url: "https://github.com/example/tool/releases/tag/v1.2.3",
          assets: [
            {
              name: "tool.zip",
              browser_download_url: "https://github.com/example/tool/tool.zip",
              digest: `sha256:${"a".repeat(64)}`,
            },
          ],
        },
      ]);
    if (url.includes("/git/ref/")) return JSON.stringify({ object: { sha: "a".repeat(40) } });
    if (url.includes("registry.npmjs.org") && url.includes(encodeURIComponent("@types/node")))
      return JSON.stringify({ versions: { "22.1.0": {}, "26.0.0": {}, "22.2.0-rc.1": {} } });
    if (url.includes("registry.npmjs.org")) return JSON.stringify({ versions: { "7.0.2": {} } });
    if (url.includes("pypi.org")) return JSON.stringify({ releases: { "2.4.1": [{ yanked: false }] } });
    if (url.includes("rubygems.org")) return JSON.stringify([{ number: "1.2.3" }]);
    if (url.includes("packagist.org"))
      return JSON.stringify({ packages: { "vendor/package": [{ version: "v2.0.0" }, { version: "3.0.0-beta" }] } });
    if (url.includes("repo.maven.apache.org"))
      return "<metadata><versioning><versions><version>2.29</version><version>3.0-RC1</version></versions></versioning></metadata>";
    if (url.includes("nodejs.org")) return JSON.stringify([{ version: "v26.13.0" }, { version: "v27.0.0-rc1" }]);
    if (url.includes("go.dev"))
      return JSON.stringify([{ version: "go1.27.3", files: [{ filename: "go.tar.gz", sha256: "b".repeat(64) }] }]);
    if (url.includes("python.org"))
      return JSON.stringify([
        { name: "Python 3.15.1", pre_release: false },
        { name: "Python 3.16.0", pre_release: true },
      ]);
    if (url.includes("ruby-lang.org")) return '- version: "4.0.9"\n- version: "4.1.0-preview1"\n';
    if (url.includes("php.net")) return JSON.stringify({ "8.5.12": {}, "8.6.0RC1": {} });
    if (url.includes("rust-lang.org")) return 'date="2026-10-29"\n[pkg.rust]\nversion="1.99.1 (build)"\n';
    throw new Error(`Unexpected source ${url}`);
  };
  const sources = new MaintenanceSources((url) => Promise.resolve(metadata(url)));
  assert.equal((await sources.github("example/tool"))[0]?.assets?.[0]?.sha256, "a".repeat(64));
  assert.equal((await sources.branch("example/tool", "main"))[0]?.version, "a".repeat(40));
  assert.deepEqual(
    (await sources.npm("@types/node", "22")).map((entry) => entry.version),
    ["22.1.0"],
  );
  assert.equal((await sources.npm("typescript"))[0]?.version, "7.0.2");
  assert.equal((await sources.pypi("mypy"))[0]?.version, "2.4.1");
  assert.equal((await sources.gem("rake"))[0]?.version, "1.2.3");
  assert.deepEqual(
    (await sources.composer("vendor/package")).map((entry) => entry.version),
    ["2.0.0"],
  );
  assert.deepEqual(
    (await sources.maven("com.spotify.fmt", "fmt-maven-plugin")).map((entry) => entry.version),
    ["2.29"],
  );
  assert.deepEqual(
    (await sources.node()).map((entry) => entry.version),
    ["26.13.0"],
  );
  assert.equal((await sources.go())[0]?.assets?.[0]?.sha256, "b".repeat(64));
  assert.deepEqual(
    (await sources.python()).map((entry) => entry.version),
    ["3.15.1"],
  );
  assert.deepEqual(
    (await sources.ruby()).map((entry) => entry.version),
    ["4.0.9"],
  );
  assert.deepEqual(
    (await sources.php()).map((entry) => entry.version),
    ["8.5.12"],
  );
  assert.equal((await sources.rust())[0]?.version, "1.99.1");
  assert.equal((await sources.rust("nightly"))[0]?.version, "nightly-2026-10-29");
});

test("discovery distinguishes available, failed, constrained, and current targets without treating failures as fresh", async () => {
  const data = fixture({
    "package.json": JSON.stringify({
      dependencies: { current: "1.0.0", newer: "1.0.0", older: "3.0.0", failed: "1.0.0" },
    }),
  });
  const plan = await discoverMaintenance(data.root, (target) => {
    if (target.name === "failed") throw new Error("registry unavailable");
    return Promise.resolve([release(target.name === "newer" ? "2.0.0" : "1.0.0")]);
  });
  assert.deepEqual(
    plan.entries.map((entry) => entry.state),
    [MaintenanceState.Current, MaintenanceState.Available, MaintenanceState.Constrained, MaintenanceState.Unavailable],
  );
  assert.match(plan.entries[3]?.reason ?? "", /registry unavailable/);
  await assert.rejects(
    discoverMaintenance(data.root, () => Promise.resolve([]), { concurrency: 0 }),
    /positive/,
  );
});

test("Composer updates respect the declared PHP platform and Maven keeps the chosen artifact flavor", async () => {
  const data = fixture({
    "composer.json": JSON.stringify({
      "require-dev": { "vendor/tool": "1.0.0" },
      config: { platform: { php: "8.2.0" } },
    }),
    "pom.xml":
      "<project><dependencies><dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId><version>32.0.0-jre</version></dependency></dependencies></project>",
  });
  const metadata = new MaintenanceSources((url) =>
    Promise.resolve(
      url.includes("packagist.org")
        ? JSON.stringify({
            package: {
              versions: {
                "v3.0.0": { version: "v3.0.0", require: { php: ">=8.4.0" } },
                "v2.0.0": { version: "v2.0.0", require: { php: "^8.2 || ^8.3" } },
                "v1.1.0": { version: "v1.1.0", require: { php: ">=8.1.0" } },
              },
            },
          })
        : "<metadata><versioning><versions><version>33.7.2-android</version><version>33.7.2-jre</version></versions></versioning></metadata>",
    ),
  );
  const plan = await discoverMaintenance(data.root, developmentDiscovery(metadata, data.root));
  assert.equal(
    plan.entries.find((entry) => entry.provider === MaintenanceProvider.Composer)?.selected?.version,
    "2.0.0",
  );
  assert.equal(
    plan.entries.find((entry) => entry.provider === MaintenanceProvider.Maven)?.selected?.version,
    "33.7.2-jre",
  );
});

test("applying a plan preserves package aliases, dependency groups, source comments, and support declarations", async () => {
  const data = fixture({
    "package.json": JSON.stringify({
      engines: { node: ">=22" },
      dependencies: { compiler: "npm:@vendor/compiler@^1.0.0" },
      devDependencies: { lint: "~1.0.0" },
    }),
    "pyproject.toml":
      '# Build tools\n[build-system]\nrequires=["setuptools==1.0.0"] # retain\n[project]\nrequires-python=">=3.11"\n[dependency-groups]\ndev=["mypy>=1.0.0,<3"] # tools\n',
    "Cargo.toml":
      '[package]\nrust-version="1.93"\n[dependencies]\nclap={version="1.0.0", features=["derive"]} # features\n',
    Gemfile: 'source "https://rubygems.org"\ngem "rake", "1.0.0" # pinned\n',
    "go.mod": "module example.test/demo\n\ngo 1.25.0\nrequire example.test/tool v1.0.0 // indirect\n",
    "pom.xml":
      "<project><properties><tool.version>1.0.0</tool.version></properties><dependencies><!-- retained --><dependency><groupId>example</groupId><artifactId>tool</artifactId><version>${tool.version}</version></dependency></dependencies></project>",
  });
  const discover = () => Promise.resolve([release("2.0.0")]);
  const plan = await discoverMaintenance(data.root, discover, { kinds: [MaintenanceKind.Dependencies] });
  const updated = await applyMaintenance(data.root, plan, { discover, run: noCommands });
  assert.equal(updated.length, plan.entries.length);
  const manifest: unknown = JSON.parse(data.read("package.json"));
  assert.deepEqual(manifest, {
    engines: { node: ">=22" },
    dependencies: { compiler: "npm:@vendor/compiler@^2.0.0" },
    devDependencies: { lint: "~2.0.0" },
  });
  assert.deepEqual(
    parse(data.read("pyproject.toml"))["dependency-groups"],
    parse('[dependency-groups]\ndev=["mypy>=2.0.0,<3"]')["dependency-groups"],
  );
  for (const comment of ["# Build tools", "# retain", "# tools"])
    assert.ok(data.read("pyproject.toml").includes(comment));
  assert.match(data.read("Cargo.toml"), /features=\["derive"\].*# features/);
  assert.match(data.read("Cargo.toml"), /rust-version="1.93"/);
  assert.match(data.read("Gemfile"), /gem "rake", "2.0.0" # pinned/);
  assert.match(data.read("go.mod"), /go 1.25.0\nrequire example.test\/tool v2.0.0 \/\/ indirect/);
  assert.match(data.read("pom.xml"), /<tool.version>2.0.0<\/tool.version>/);
  assert.match(data.read("pom.xml"), /<!-- retained -->/);
  assert.throws(() => readMaintenancePlan(data.root, plan), /changed/);
});

test("a stale or forged plan cannot overwrite work or choose output paths", async () => {
  const data = fixture({ "package.json": '{"dependencies":{"test":"1.0.0"}}\n' });
  const discover = () => Promise.resolve([release("2.0.0")]);
  const plan = await discoverMaintenance(data.root, discover);
  assert.throws(
    () => readMaintenancePlan(data.root, { ...plan, entries: [...plan.entries, ...plan.entries] }),
    /inventory/,
  );
  assert.throws(
    () =>
      readMaintenancePlan(data.root, {
        ...plan,
        entries: plan.entries.map((entry) => ({ ...entry, path: "../elsewhere" })),
      }),
    /changed/,
  );
  assert.throws(() => readMaintenancePlan(data.root, { ...plan, inputs: { "../secret": "hash" } }), /changed/);
  await assert.rejects(
    applyMaintenance(data.root, plan, { discover: () => Promise.resolve([]), run: noCommands }),
    /no longer published/,
  );
  assert.equal(data.read("package.json"), '{"dependencies":{"test":"1.0.0"}}\n');
  await assert.rejects(
    applyMaintenance(data.root, plan, {
      discover: () => {
        data.write("package.json", '{"dependencies":{"test":"1.0.0"},"description":"human edit"}\n');
        return Promise.resolve([release("2.0.0")]);
      },
      run: noCommands,
    }),
    /inputs have changed/,
  );
  assert.match(data.read("package.json"), /human edit/);
});

test("native pin updates require every prior platform's checksum and retain signature verification", async () => {
  const platforms = ["linux-x64", "darwin-arm64"];
  const data = fixture({
    "scripts/native-assets.json": JSON.stringify({
      node: {
        "22.1.0": Object.fromEntries(
          platforms.map((platform) => [
            platform,
            {
              url: `https://nodejs.org/dist/v22.1.0/node-v22.1.0-${platform}.tar.gz`,
              sha256: "a".repeat(64),
              signature: { url: "https://nodejs.org/dist/v22.1.0/SHASUMS256.txt.sig", key: "keys/node.asc" },
            },
          ]),
        ),
      },
    }),
    ".node-version": "22.1.0\n",
  });
  const target = maintenanceTargets(data.root).find((entry) => entry.name === "node");
  assert.ok(target);
  const entry: MaintenanceEntry = { ...target, state: MaintenanceState.Available, selected: release("22.2.0") };
  const sources = new MaintenanceSources(() =>
    Promise.resolve(platforms.map((platform) => `${"b".repeat(64)}  node-v22.2.0-${platform}.tar.gz`).join("\n")),
  );
  const edits = await nativeMaintenanceEdits(data.root, [entry], sources);
  const value = record(JSON.parse(edits[0]?.[1] ?? "{}"), "Missing native replacement");
  const recipes = record(record(value.node, "Missing Node inventory")["22.2.0"], "Missing selected Node recipes");
  assert.deepEqual(Object.keys(recipes), platforms);
  for (const platform of platforms)
    assert.deepEqual(recipes[platform], {
      url: `https://nodejs.org/dist/v22.2.0/node-v22.2.0-${platform}.tar.gz`,
      sha256: "b".repeat(64),
      signature: { url: "https://nodejs.org/dist/v22.2.0/SHASUMS256.txt.sig", key: "keys/node.asc" },
    });
  const updated = edits[0]?.[1] ?? "";
  assert.match(updated, /keys\/node.asc/);
  assert.match(updated, /SHASUMS256.txt.sig/);
  for (const platform of platforms) assert.ok(updated.includes(`node-v22.2.0-${platform}`));
  await assert.rejects(
    nativeMaintenanceEdits(data.root, [entry], new MaintenanceSources(() => Promise.resolve(""))),
    /Missing Node checksum/,
  );
  assert.equal(data.read(".node-version"), "22.1.0\n");
});

test("a changed flake source declaration invalidates a previously generated environment plan", async () => {
  const data = fixture({ "flake.nix": '{ inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable"; }' });
  const discover = () => Promise.resolve([release("1.0.0")]);
  const plan = await discoverMaintenance(data.root, discover);
  data.write("flake.nix", '{ inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-stable"; }');
  await assert.rejects(applyMaintenance(data.root, plan, { discover, run: noCommands }), /inputs have changed/);
});

test("Nix updates keep the original branch authority and require explicit environment selection", async () => {
  const old = "a".repeat(40),
    next = "b".repeat(40);
  const original = { type: "github", owner: "NixOS", repo: "nixpkgs", ref: "nixos-unstable" };
  const data = fixture({
    "flake.lock": JSON.stringify({
      nodes: { nixpkgs: { original, locked: { ...original, rev: old, narHash: "sha256-old=" } } },
      root: "root",
      version: 7,
    }),
    "workbench/config.toml": `[checks]\nnix_docker_image="nixos/nix@sha256:${"c".repeat(64)}"\n`,
  });
  const plan = await discoverMaintenance(data.root, () => Promise.resolve([release(next)]), {
    kinds: [MaintenanceKind.Environments],
  });
  const discover = () => Promise.resolve([release(next)]);
  await assert.rejects(applyMaintenance(data.root, plan, { discover, run: noCommands }), /--environments/);
  await applyMaintenance(data.root, plan, {
    discover,
    environments: true,
    run: () =>
      Promise.resolve(
        JSON.stringify({
          locked: {
            __final: true,
            type: "github",
            owner: "NixOS",
            repo: "nixpkgs",
            rev: next,
            narHash: `sha256-${Buffer.alloc(32).toString("base64")}`,
            lastModified: 42,
          },
        }),
      ),
  });
  assert.match(data.read("flake.lock"), new RegExp(next));
  assert.match(data.read("flake.lock"), /nixos-unstable/);
  assert.deepEqual(
    record(record(JSON.parse(data.read("flake.lock")), "Invalid flake lock").nodes, "Missing flake nodes").nixpkgs,
    {
      original,
      locked: {
        type: "github",
        owner: "NixOS",
        repo: "nixpkgs",
        rev: next,
        narHash: `sha256-${Buffer.alloc(32).toString("base64")}`,
        lastModified: 42,
      },
    },
  );
});

test("development adapters report unknown tool sources explicitly and route package aliases to their actual registry", async () => {
  const data = fixture({
    "package.json": '{"dependencies":{"compiler":"npm:@vendor/compiler@1.0.0"}}',
    ".tool-versions": "unknown-tool 1.0.0\n",
  });
  const targets = maintenanceTargets(data.root);
  const urls: string[] = [];
  const discover = developmentDiscovery(
    new MaintenanceSources((url) => {
      urls.push(url);
      return Promise.resolve('{"version":"2.0.0"}');
    }),
  );
  const plan = await discoverMaintenance(data.root, discover);
  assert.ok(urls.some((url) => url.includes(encodeURIComponent("@vendor/compiler"))));
  assert.equal(plan.entries.find((entry) => entry.name === "unknown-tool")?.state, MaintenanceState.Unavailable);
  assert.match(plan.entries.find((entry) => entry.name === "unknown-tool")?.reason ?? "", /not assumed current/);
  assert.throws(
    () =>
      readMaintenancePlan(data.root, {
        ...plan,
        entries: plan.entries.map((entry) => ({ ...entry, state: MaintenanceState.Available, selected: undefined })),
      }),
    /Missing selected release/,
  );
  assert.equal(targets[0]?.provider, MaintenanceProvider.Npm);
});

test("automation updates resolve annotated tags to immutable commits and retain container tag choices", async () => {
  const old = "a".repeat(40),
    selected = "b".repeat(40),
    tag = "c".repeat(40);
  const oldDigest = `sha256:${"d".repeat(64)}`,
    digest = `sha256:${"e".repeat(64)}`;
  const data = fixture({
    ".github/workflows/checks.yml": `jobs:\n  check:\n    steps:\n      - uses: example/action@${old} # v1.0.0\n`,
    ".devcontainer/Dockerfile": `# keep the base family\nFROM node:24-trixie@${oldDigest} AS bootstrap\n`,
  });
  const sources = new MaintenanceSources((url) => {
    if (url.includes("/releases?"))
      return Promise.resolve(
        JSON.stringify([
          { tag_name: "v2.0.0", html_url: "https://github.com/example/action/releases/tag/v2.0.0", assets: [] },
        ]),
      );
    if (url.includes("/git/ref/tags/")) return Promise.resolve(JSON.stringify({ object: { type: "tag", sha: tag } }));
    if (url.endsWith(`/git/tags/${tag}`))
      return Promise.resolve(JSON.stringify({ object: { type: "commit", sha: selected } }));
    if (url.includes("hub.docker.com")) return Promise.resolve(JSON.stringify({ digest }));
    return Promise.reject(new Error(`Unexpected source ${url}`));
  });
  const plan = await discoverMaintenance(data.root, developmentDiscovery(sources, data.root), {
    kinds: [MaintenanceKind.Automation],
  });
  assert.equal(plan.entries.length, 2);
  await applyMaintenance(data.root, plan, { sources, run: noCommands });
  assert.equal(
    data.read(".github/workflows/checks.yml"),
    `jobs:\n  check:\n    steps:\n      - uses: example/action@${selected} # v2.0.0\n`,
  );
  assert.equal(
    data.read(".devcontainer/Dockerfile"),
    `# keep the base family\nFROM node:24-trixie@${digest} AS bootstrap\n`,
  );
});

test("renewing an unsigned Ruby recipe examines the actual release announcement and refuses newly available signatures", async () => {
  const old = "4.0.7",
    next = "4.0.9",
    digest = "b".repeat(64);
  const data = fixture({
    ".ruby-version": `${old}\n`,
    "scripts/native-assets.json": JSON.stringify({
      ruby: {
        [old]: {
          "linux-x64": {
            url: `https://cache.ruby-lang.org/pub/ruby/4.0/ruby-${old}.tar.gz`,
            sha256: "a".repeat(64),
            authenticationUnavailable: {
              reason: "Release announcement publishes digests without signatures",
              source: "https://www.ruby-lang.org/en/downloads/",
              checked: "2000-01-01",
            },
          },
        },
      },
    }),
  });
  const target = maintenanceTargets(data.root).find((entry) => entry.name === "ruby");
  assert.ok(target);
  const entry: MaintenanceEntry = { ...target, state: MaintenanceState.Available, selected: release(next) };
  const announcement = "/en/news/2026/10/23/ruby-4-0-9-released/";
  const metadata = (page: string) =>
    new MaintenanceSources((url) =>
      Promise.resolve(
        url.endsWith(".yml")
          ? `- version: ${next}\n  post: ${announcement}\n  url:\n    gz: https://cache.ruby-lang.org/pub/ruby/4.0/ruby-${next}.tar.gz\n  sha256:\n    gz: ${digest}\n`
          : page,
      ),
    );
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
  try {
    const edits = await nativeMaintenanceEdits(data.root, [entry], metadata(`<pre>${digest}</pre>`));
    const recipes = record(
      record(record(JSON.parse(edits[0]?.[1] ?? "{}"), "Missing inventory").ruby, "Missing Ruby")[next],
      "Missing release",
    );
    assert.deepEqual(record(recipes["linux-x64"], "Missing platform").authenticationUnavailable, {
      reason: "Release announcement publishes digests without signatures",
      source: `https://www.ruby-lang.org${announcement}`,
      checked: "2026-10-29",
    });
    await assert.rejects(
      nativeMaintenanceEdits(
        data.root,
        [entry],
        metadata(`<pre>${digest}</pre><a href="ruby.tar.gz.asc">signature</a>`),
      ),
      /provides authentication evidence/,
    );
    await assert.rejects(
      nativeMaintenanceEdits(data.root, [entry], metadata("<p>Unrelated announcement</p>")),
      /does not confirm/,
    );
    assert.equal(data.read(".ruby-version"), `${old}\n`);
  } finally {
    vi.useRealTimers();
  }
});

test("release image edits retain per-target platforms, commands and baselines while BuildKit updates its version and digest together", async () => {
  const before = `sha256:${"a".repeat(64)}`;
  const next = `sha256:${"b".repeat(64)}`;
  const arm = `sha256:${"c".repeat(64)}`;
  const x64 = `sha256:${"d".repeat(64)}`;
  const commands = [{ argv: ["sample", "20", "22"], stdout: "42\n" }];
  const target = (platform: string, baseline: string) => ({
    platform,
    cpu_baseline: baseline,
    kernel_baseline: "6.1",
    verification_images: [`ubuntu:26.04@${before}`, `alpine:3.23@${before}`],
  });
  const data = fixture({
    "managed-release-check.json": JSON.stringify({ image: `node:24-bookworm@${before}`, commands }),
    "scripts/container-tools/buildkit-image.txt": `docker.io/moby/buildkit:v0.34.1@${before}\n`,
    "release-musl.json": JSON.stringify({
      cross_version: "0.2.5",
      cross_revision: "a".repeat(40),
      targets: {
        "x86_64-unknown-linux-musl": target("linux-x64", "x86-64"),
        "aarch64-unknown-linux-musl": target("linux-arm64", "armv8-a"),
      },
    }),
  });
  const discover = (entry: MaintenanceTarget) =>
    Promise.resolve([
      entry.name === "buildkit"
        ? { ...release("0.34.2"), revision: next }
        : entry.name === "cross"
          ? release("b".repeat(40))
          : release(entry.platform === "linux-x64" ? x64 : entry.platform === "linux-arm64" ? arm : next),
    ]);
  const plan = await discoverMaintenance(data.root, discover);
  await applyMaintenance(data.root, plan, { discover, run: noCommands });
  assert.deepEqual(JSON.parse(data.read("managed-release-check.json")), {
    image: `node:24-bookworm@${next}`,
    commands,
  });
  assert.equal(data.read("scripts/container-tools/buildkit-image.txt"), `docker.io/moby/buildkit:v0.34.2@${next}\n`);
  const result = record(JSON.parse(data.read("release-musl.json")), "Missing musl config");
  assert.equal(result.cross_revision, "b".repeat(40));
  const targets = record(result.targets, "Missing targets");
  assert.deepEqual(targets["x86_64-unknown-linux-musl"], {
    ...target("linux-x64", "x86-64"),
    verification_images: [`ubuntu:26.04@${next}`, `alpine:3.23@${x64}`],
  });
  assert.deepEqual(targets["aarch64-unknown-linux-musl"], {
    ...target("linux-arm64", "armv8-a"),
    verification_images: [`ubuntu:26.04@${next}`, `alpine:3.23@${arm}`],
  });
});
