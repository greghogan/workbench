import type { MavenAuthentication } from "../src/maven-policy.ts";
import { describeError } from "../scripts/diagnostic-errors.mjs";
import { retryableNetworkFailure } from "../scripts/network-retry.mts";
import { createHash } from "node:crypto";
import type { MaintenanceCommand } from "../scripts/maintenance/contract.mjs";
import { deriveManagedInputs } from "../scripts/managed-inputs.mjs";
import { promised } from "./fixtures/promised.mjs";
import { record } from "../scripts/values.mjs";
import { afterEach, test, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fork } from "node:child_process";
import { pathToFileURL } from "node:url";
import { maintenanceMain } from "../scripts/maintenance/main.mjs";
import { MaintenanceSources, metadataRequests } from "../scripts/maintenance/sources.mjs";
import { developmentDiscovery, discoverMaintenance, maintenanceTargets } from "../scripts/maintenance/plan.mjs";
import { applyMaintenance } from "../scripts/maintenance/apply.mjs";
import { publishDeclarations, withMaintenanceOperation } from "../scripts/maintenance/operation.mjs";
import {
  editJsonFields,
  mavenVersions,
  editTokens,
  actionPins,
  dockerBases,
  goModules,
  guixCommit,
} from "../scripts/maintenance/syntax.mjs";
import { MaintenanceState, MaintenanceKind, MaintenanceProvider } from "../scripts/maintenance/contract.mjs";
import { nativeMaintenanceEdits } from "../scripts/maintenance/native.mjs";
import { maintenanceLockSelection, maintenanceLockCommands } from "../scripts/maintenance/locks.mjs";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "workbench-maintenance-workflow-"));
  temporary.push(root);
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, "state"));
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "cache"));
  for (const [path, text] of Object.entries({
    "workbench/projects.toml": '[[language_root]]\npath = "."\nlanguage = "typescript"\n',
    "workbench/config.toml": "schema_version = 1\n",
    "scripts/native-assets.json": "{}\n",
    ...files,
  })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return { root, read: (path: string) => readFileSync(join(root, path), "utf8") };
}
test("a toolchain authority refreshes its root's dependency locks without selecting unrelated roots", () => {
  const f = fixture({
    "workbench/projects.toml":
      '[[language_root]]\npath="."\nlanguage="typescript"\n[[language_root]]\npath="other"\nlanguage="typescript"\n',
    "package.json": '{"dependencies":{"library":"1.0.0"}}',
    ".node-version": "22.1.0",
    "other/package.json": '{"dependencies":{"other-library":"1.0.0"}}',
  });
  const inventory = maintenanceTargets(f.root).map((target) => ({
    ...target,
    state: MaintenanceState.Current as const,
  }));
  const selection = maintenanceLockSelection(f.root, inventory, [".node-version"]);
  expect(selection.some((entry) => entry.name === "library")).toBe(true);
  expect(selection.some((entry) => entry.name === "other-library")).toBe(false);
});
test("an interrupted lock refresh resumes without rediscovering releases or reapplying declarations", async () => {
  const f = fixture({ "package.json": '{ "dependencies": { "library": "1.0.0" } }\n' });
  const fetcher = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ versions: { "2.0.0": {} } }))));
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const plan = join(f.root, "plan.json");
  await maintenanceMain(["plan", "--output", plan], f.root, () => promised(() => ""));
  let completedCommand: string | undefined;
  await expect(
    maintenanceMain(["apply", plan, "--refresh-locks"], f.root, (command) =>
      promised(() => {
        if (!completedCommand) {
          completedCommand = JSON.stringify(command);
          return "";
        }
        throw new Error("manager interrupted");
      }),
    ),
  ).rejects.toThrow(/--resume/);
  expect(f.read("package.json")).toBe('{ "dependencies": { "library": "2.0.0" } }\n');
  const requests = fetcher.mock.calls.length;
  let commands = 0;
  await maintenanceMain(["apply", plan, "--refresh-locks", "--resume"], f.root, (command) =>
    promised(() => {
      if (JSON.stringify(command) === completedCommand) throw new Error("Completed command replayed");
      commands++;
      return "";
    }),
  );
  expect(commands).toBeGreaterThan(0);
  expect(fetcher.mock.calls).toHaveLength(requests);
  expect(record(JSON.parse(f.read("plan.json.progress.json")), "Progress").phase).toBe("complete");
  await maintenanceMain(["apply", plan, "--refresh-locks", "--resume"], f.root, () =>
    promised(() => {
      throw new Error("already completed");
    }),
  );
});
test("resume preserves an intervening human edit and rejects a different scope", async () => {
  const f = fixture({ "package.json": '{"dependencies":{"library":"1.0.0"}}\n' });
  vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify({ versions: { "2.0.0": {} } }))));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const plan = join(f.root, "plan.json");
  await maintenanceMain(["plan", "--output", plan], f.root, () => promised(() => ""));
  await expect(
    maintenanceMain(["apply", plan, "--refresh-locks"], f.root, () =>
      promised(() => {
        throw new Error("interrupted");
      }),
    ),
  ).rejects.toThrow(/--resume/);
  await expect(
    maintenanceMain(["apply", plan, "--refresh-locks", "--resume", "--lock-scope", "selected"], f.root, () =>
      promised(() => ""),
    ),
  ).rejects.toThrow(/scope/);
  writeFileSync(join(f.root, "workbench/config.toml"), "# human edit\nschema_version = 1\n");
  await expect(
    maintenanceMain(["apply", plan, "--refresh-locks", "--resume"], f.root, () => promised(() => "")),
  ).rejects.toThrow(/changed since/);
  expect(f.read("workbench/config.toml")).toContain("human edit");
});
test("project maintenance admission is exclusive, cancellable, and releases ownership", async () => {
  const f = fixture(),
    entered = Promise.withResolvers<undefined>(),
    release = Promise.withResolvers<undefined>();
  const first = withMaintenanceOperation(f.root, async () => {
    entered.resolve(undefined);
    await release.promise;
  });
  await entered.promise;
  let secondEntered = false;
  const controller = new AbortController();
  const second = withMaintenanceOperation(
    f.root,
    () =>
      promised(() => {
        secondEntered = true;
      }),
    controller.signal,
  );
  controller.abort();
  await expect(second).rejects.toThrow();
  expect(secondEntered).toBe(false);
  release.resolve(undefined);
  await first;
  await expect(withMaintenanceOperation(f.root, () => promised(() => "released"))).resolves.toBe("released");
});

test("maintenance can recover a crashed writer after its process is reaped", async () => {
  const f = fixture(),
    entry = join(f.root, "writer.mjs");
  const module = pathToFileURL(join(import.meta.dirname, "../scripts/maintenance/operation.mjs")).href;
  writeFileSync(
    entry,
    `import {withMaintenanceOperation} from ${JSON.stringify(module)};\nsetInterval(() => {},1000);\nawait withMaintenanceOperation(${JSON.stringify(f.root)},async () => {process.send("entered");await new Promise(() => {});});\n`,
  );
  const child = fork(entry, [], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let diagnostic = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString("utf8")).slice(-16384);
  });
  const exited = new Promise<undefined>((resolve) => {
    child.once("exit", () => {
      resolve(undefined);
    });
  });
  try {
    await new Promise<undefined>((resolve, reject) => {
      child.once("message", (message: unknown) => {
        if (message === "entered") resolve(undefined);
        else reject(new Error("Unexpected writer protocol"));
      });
      child.once("error", reject);
      child.once("exit", () => {
        reject(new Error(`Writer exited before admission: ${diagnostic}`));
      });
    });
    child.kill("SIGKILL");
    await exited;
    await expect(withMaintenanceOperation(f.root, () => promised(() => "recovered"))).resolves.toBe("recovered");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
});
test("a mid-publication conflict preserves human work and identifies the published files", () => {
  const f = fixture({ "a.json": "old-a", "b.json": "old-b" });
  expect(() => {
    publishDeclarations(
      f.root,
      [
        ["a.json", "new-a"],
        ["b.json", "new-b"],
      ],
      (published = {}) => {
        if (published["a.json"]) writeFileSync(join(f.root, "b.json"), "human edit");
      },
    );
  }).toThrow(/published files: a.json/);
  expect(f.read("a.json")).toBe("new-a");
  expect(f.read("b.json")).toBe("human edit");
});
test("JSON version edits retain unrelated whitespace, escaped keys, and numeric arrays", () => {
  const original = '{\n\t"a.b": [ "keep", "old" ], "untouched":true\n}\n';
  expect(editJsonFields(original, [{ path: ["a.b", "1"], value: "new" }])).toBe(original.replace('"old"', '"new"'));
  expect(() => editJsonFields('{"x":"a","x":"b"}', [{ path: ["x"], value: "c" }])).toThrow(/ambiguous/);
  expect(() => editJsonFields(original, [{ path: ["missing"], value: "x" }])).toThrow(/Missing string field/);
});
test("Maven token discovery and editing accept reordered fields and ignore comment lookalikes", () => {
  const original =
    "<project><!-- <version>fake</version> --><dependency><artifactId>lib</artifactId><!-- keep --><version> 1.0 </version><groupId>org.example</groupId></dependency></project>";
  const tokens = mavenVersions(original);
  expect(tokens.map(({ name, current }) => ({ name, current }))).toEqual([{ name: "org.example:lib", current: "1.0" }]);
  expect(
    editTokens(
      original,
      tokens.map((token) => ({ ...token, value: "2.0" })),
    ),
  ).toBe(original.replace(" 1.0 ", " 2.0 "));
});

test("workflow discovery ignores commented uses and retains quoted action token ranges", () => {
  const revision = "a".repeat(40);
  const source = `# uses: ignored/action@${revision} # v9.0.0\nsteps:\n  - uses: 'example/action@${revision}' # v1.0.0 keep\n`;
  const pins = actionPins(source);
  expect(pins).toHaveLength(1);
  expect(pins[0]?.name).toBe("example/action");
  expect(source.slice(pins[0]?.start, pins[0]?.end)).toBe(`'example/action@${revision}'`);
  const docker = `# FROM ignored:tag@sha256:${"b".repeat(64)}\nFROM --platform=linux/arm64 example:tag@sha256:${"c".repeat(64)} AS build\n`;
  const bases = dockerBases(docker);
  expect(bases).toHaveLength(1);
  expect(docker.slice(bases[0]?.start, bases[0]?.end)).toBe(`example:tag@sha256:${"c".repeat(64)}`);
});

test("Go and Guix edits retain comment lookalikes and reject ambiguous channel pins", () => {
  const go =
    "module example.test/app\n//example.test/old v9.0.0\nrequire (\n  example.test/lib v1.0.0 // retained\n)\n";
  const modules = goModules(go);
  expect(modules.map((entry) => entry.name)).toEqual(["example.test/lib"]);
  expect(
    editTokens(
      go,
      modules.map((entry) => ({ ...entry, value: "v2.0.0" })),
    ),
  ).toBe(go.replace("v1.0.0", "v2.0.0"));
  const old = "a".repeat(40),
    next = "b".repeat(40);
  const scheme = `; (commit "${next}")\n#| outer #| (commit "${next}") |# comment |#\n(list (channel (name 'guix) (commit "${old}")))\n`;
  const pin = guixCommit(scheme);
  expect(pin.current).toBe(old);
  expect(editTokens(scheme, [{ ...pin, value: next }])).toBe(scheme.replace(`(commit "${old}")`, `(commit "${next}")`));
  expect(() => guixCommit(`(list (commit "${old}") (commit "${next}"))`)).toThrow(/unambiguous/);
  expect(() => guixCommit(`#;(commit "${old}")`)).toThrow(/explicit pin review/);
});

test("Go pseudo-version pins remain exact during lock refresh and compare below their stable release", async () => {
  const pseudo = "v1.2.4-0.20251029000000-abcdef123456";
  const f = fixture({ "go.mod": `module example.test/app\ngo 1.26.4\nrequire example.test/lib ${pseudo}\n` });
  const inventory = maintenanceTargets(f.root).map((target) => ({
    ...target,
    state: MaintenanceState.Current as const,
  }));
  expect(
    maintenanceLockCommands(f.root, inventory, ["go.mod"]).some((command) =>
      command.arguments.includes(`example.test/lib@${pseudo}`),
    ),
  ).toBe(true);
  const plan = await discoverMaintenance(f.root, () =>
    Promise.resolve([{ version: "1.2.4", reference: "https://example.test/version" }]),
  );
  expect(plan.entries[0]?.state).toBe(MaintenanceState.Available);
  await applyMaintenance(f.root, plan, {
    discover: () => Promise.resolve([{ version: "1.2.4", reference: "https://example.test/version" }]),
    run: () => Promise.resolve(""),
  });
  expect(f.read("go.mod")).toContain("example.test/lib v1.2.4");
});

test("browser constraints select a compatible patch without inspecting irrelevant historical releases", async () => {
  const f = fixture({
    "package.json": '{"devDependencies":{"playwright-core":"1.1.0"}}\n',
    ".tool-versions": "chromium-headless-shell 100.0.0\n",
  });
  const requests: string[] = [];
  const sources = new MaintenanceSources((url) => {
    requests.push(url);
    if (url.includes("registry.npmjs.org"))
      return Promise.resolve(JSON.stringify({ versions: { "1.0.0": {}, "1.1.0": {}, "1.1.1": {}, "2.0.0": {} } }));
    return Promise.resolve(
      JSON.stringify({
        browsers: [
          { name: "chromium-headless-shell", browserVersion: url.includes("/v2.0.0/") ? "101.0.0" : "100.0.0" },
        ],
      }),
    );
  });
  const plan = await discoverMaintenance(f.root, developmentDiscovery(sources, f.root), {
    kinds: [MaintenanceKind.Dependencies],
  });
  expect(plan.entries[0]?.selected?.version).toBe("1.1.1");
  expect(plan.entries[0]?.latest).toBe("2.0.0");
  expect(requests.some((url) => url.includes("/v1.0.0/"))).toBe(false);
});
test("metadata cleanup retains the original error and cache eviction bounds retained results", async () => {
  const request = metadataRequests(
    () =>
      promised(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(3));
              },
              cancel() {
                throw new Error("cleanup failed");
              },
            }),
          ),
      ),
    undefined,
    { cacheBytes: 4, responseBytes: 2, pending: 1 },
  );
  try {
    await request("https://example.test/failure");
    expect.unreachable();
  } catch (error) {
    const explanation = describeError(error);
    expect(explanation).toMatch(/metadata exceeds/);
    expect(explanation).toContain("cleanup failed");
    expect(retryableNetworkFailure(error)).toBe(false);
  }
  let acquisitions = 0;
  const cached = metadataRequests(
    () =>
      promised(() => {
        acquisitions++;
        return new Response("1234");
      }),
    undefined,
    { cacheBytes: 4, responseBytes: 8, pending: 2 },
  );
  await cached("https://example.test/a");
  await cached("https://example.test/a");
  expect(acquisitions).toBe(1);
  await cached("https://example.test/b");
  await cached("https://example.test/a");
  expect(acquisitions).toBe(3);
});
test("discovery selects the newest eligible release and separately reports a newer blocked line", async () => {
  const f = fixture({ ".node-version": "22.0.0\n" });
  const plan = await discoverMaintenance(f.root, () =>
    promised(() =>
      ["24.0.0", "22.1.0", "22.0.0"].map((version) => ({ version, reference: "https://example.test/releases" })),
    ),
  );
  expect(plan.entries[0]?.selected?.version).toBe("22.1.0");
  expect(plan.entries[0]?.latest).toBe("24.0.0");
});

test("Bundler uses release history and retains the digest for the eligible maintained line", async () => {
  const f = fixture({ "Gemfile.lock": "BUNDLED WITH\n   3.1.0\n" });
  const sources = new MaintenanceSources(() =>
    Promise.resolve(
      JSON.stringify([
        { number: "4.0.0", platform: "ruby", sha: "a".repeat(64) },
        { number: "3.1.1", platform: "ruby", sha: "b".repeat(64) },
        { number: "3.1.1", platform: "arm64-linux", ruby_abi: "4.0", sha: "c".repeat(64) },
      ]),
    ),
  );
  const plan = await discoverMaintenance(f.root, developmentDiscovery(sources, f.root));
  const entry = plan.entries.find((entry) => entry.name === "bundler");
  expect(entry?.selected?.version).toBe("3.1.1");
  expect(entry?.selected?.assets?.[0]?.sha256).toBe("b".repeat(64));
  expect(entry?.latest).toBe("4.0.0");
  expect(entry?.selected?.assets?.some((asset) => asset.url === undefined && asset.sha256 === "c".repeat(64))).toBe(
    true,
  );
  await applyMaintenance(f.root, plan, { sources, run: () => Promise.resolve("") });
  expect(f.read("Gemfile.lock")).toContain("3.1.1");
});
test("a retagged action cannot change the reviewed publication at apply", async () => {
  const f = fixture({ ".github/workflows/ci.yml": `steps:\n  - uses: example/action@${"a".repeat(40)} # v1.0.0\n` });
  let revision = "b".repeat(40);
  const sources = new MaintenanceSources((url) =>
    promised(() =>
      JSON.stringify(
        url.includes("releases?")
          ? [{ tag_name: "v2.0.0", html_url: "https://example.test/v2", assets: [] }]
          : { object: { type: "commit", sha: revision } },
      ),
    ),
  );
  const plan = await discoverMaintenance(f.root, developmentDiscovery(sources, f.root), {
    kinds: [MaintenanceKind.Automation],
  });
  revision = "c".repeat(40);
  await expect(applyMaintenance(f.root, plan, { sources, run: () => promised(() => "") })).rejects.toThrow(
    /publication identity changed/,
  );
  expect(f.read(".github/workflows/ci.yml")).toContain("a".repeat(40));
});
test.each(["v", "releases/tool-"])(
  "native version edits preserve opaque trust material and exact %s release selectors",
  async (prefix) => {
    const old = "1.1.1",
      next = "1.1.10";
    const f = fixture({
      "scripts/native-assets.json": JSON.stringify({
        cmake: {
          [old]: {
            "linux-x64": {
              url: `https://example.test/cmake-${old}.tar.gz`,
              sha256: "a".repeat(64),
              format: "tar",
              strip: 1,
              bin: "bin",
              signature: {
                url: `https://example.test/cmake-${old}.sig`,
                keys: `Trust anchor ${old}`,
                signers: [`Signer ${old}`],
              },
              attestation: {
                url: `https://example.test/${prefix}${old}/proof.jsonl`,
                signer: `https://example.test/workflow@refs/tags/${prefix}${old}`,
                subject: `cmake-${old}.tar.gz`,
                roots: `Trust roots ${old}`,
                release: { repository: "example/tool", tag: `${prefix}${old}` },
              },
            },
          },
        },
      }),
    });
    const edits = await nativeMaintenanceEdits(
      f.root,
      [
        {
          id: "cmake",
          kind: MaintenanceKind.Toolchains,
          provider: MaintenanceProvider.Tool,
          path: ".tool-versions",
          name: "cmake",
          current: old,
          state: MaintenanceState.Available,
          selected: {
            version: next,
            reference: "https://example.test/release",
            assets: [
              {
                name: `cmake-${next}.tar.gz`,
                url: `https://example.test/cmake-${next}.tar.gz`,
                sha256: "b".repeat(64),
              },
            ],
          },
        },
      ],
      new MaintenanceSources(() =>
        promised(() => {
          throw new Error("unexpected acquisition");
        }),
      ),
    );
    const inventory = record(JSON.parse(edits[0]?.[1] ?? "{}"), "Native recipes");
    const recipe = record(
      record(record(inventory.cmake, "CMake versions")[next], "New platforms")["linux-x64"],
      "New recipe",
    );
    const signature = record(recipe.signature, "Signature");
    expect(signature.keys).toBe(`Trust anchor ${old}`);
    expect(signature.signers).toEqual([`Signer ${old}`]);
    expect(signature.url).toContain(next);
    const attestation = record(recipe.attestation, "Attestation");
    expect(attestation.url).toContain(next);
    expect(attestation.signer).toBe(`https://example.test/workflow@refs/tags/${prefix}${next}`);
    expect(attestation.roots).toBe(`Trust roots ${old}`);
    expect(existsSync(join(f.root, ".tool-versions"))).toBe(false);
  },
);

test("toolchain preparation keeps container dependencies locked unless their update was selected", () => {
  const f = fixture({
    ".node-version": "22.1.0\n",
    "scripts/container-tools/package.json": '{"dependencies":{"container-check":"1.0.0"}}',
  });
  const inventory = maintenanceTargets(f.root).map((target) => ({
    ...target,
    state: MaintenanceState.Current as const,
  }));
  const selection = maintenanceLockSelection(f.root, inventory, [".node-version"]);
  const frozen = maintenanceLockCommands(f.root, selection);
  const selected = maintenanceLockCommands(f.root, selection, ["scripts/container-tools/package.json"]);
  expect(frozen.some((command) => command.arguments.includes("npm") && command.arguments.includes("ci"))).toBe(true);
  expect(frozen.some((command) => command.arguments.includes("--package-lock-only"))).toBe(false);
  expect(
    selected.some((command) => command.arguments.includes("npm") && command.arguments.includes("--package-lock-only")),
  ).toBe(true);
});

test("Maven refresh requires proposal acceptance, freezes checksums, and resumes interrupted qualification", async () => {
  const f = fixture({
    "workbench/projects.toml":
      '[[language_root]]\npath="."\nlanguage="java"\nci_environments=["native","guix","nix"]\n',
    "pom.xml":
      "<project><dependency><groupId>example.test</groupId><artifactId>library</artifactId><version>1.0.0</version></dependency></project>",
    ".mvn/checksums/checksums.sha256": `${"e".repeat(64)}  org/example/library/1/library-1.jar\n`,
  });
  const acquisition = { resolver: "org.apache.maven.plugins:maven-dependency-plugin:3.11.0:go-offline", trust: [] };
  writeFileSync(join(f.root, ".mvn/acquisition.json"), JSON.stringify(acquisition));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", () =>
    promised(
      () => new Response("<metadata><versioning><versions><version>2.0.0</version></versions></versioning></metadata>"),
    ),
  );
  const plan = join(f.root, "plan.json");
  const qualified: string[] = [];
  const previousIndex = f.read(".mvn/checksums/checksums.sha256");
  let interrupt = true,
    accepted = false;
  const run = (command: MaintenanceCommand): Promise<string> =>
    promised(() => {
      if (
        command.arguments.includes("--path") &&
        command.arguments.some((part) => /[\\/]scripts[\\/]managed-inputs\.mjs$/.test(part))
      ) {
        for (const [path, contents] of deriveManagedInputs(f.root, ".")) writeFileSync(path, contents);
      }
      if (command.arguments.includes("maven-lock") && !accepted) throw new Error("Maven proposal requires acceptance");
      if (command.checksums) {
        const environment = command.checksums.environment;
        if (environment !== "native") {
          const declaration = JSON.parse(f.read("managed-check-inputs.json")) as {
            source_hashes: Record<string, string>;
          };
          expect(declaration.source_hashes[".mvn/checksums/checksums.sha256"]).toBe(
            createHash("sha256").update(f.read(".mvn/checksums/checksums.sha256")).digest("hex"),
          );
        }
        qualified.push(environment);
        if (environment === "nix" && interrupt) {
          interrupt = false;
          writeFileSync(command.checksums.path, `${"f".repeat(64)}  org/example/library/1/library-1.jar\n`);
        }
      }
      return "";
    });
  await maintenanceMain(["plan", "--kind", "dependencies", "--output", plan], f.root, run);
  await expect(maintenanceMain(["apply", plan, "--refresh-locks"], f.root, run)).rejects.toThrow(/--resume/);
  expect(qualified).toEqual([]);
  accepted = true;
  const acceptedIndex = `${"a".repeat(64)}  org/example/library/2.0.0/library-2.0.0.jar\n`;
  writeFileSync(join(f.root, ".mvn/checksums/checksums.sha256"), acceptedIndex);
  const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
  const authentication: MavenAuthentication = {
    schema: 1,
    pom: hash(f.read("pom.xml")),
    policy: hash(JSON.stringify({ config: acquisition, keys: [] })),
    checksumSHA256: hash(acceptedIndex),
    resolver: acquisition.resolver,
    preparedAt: "2026-01-01T00:00:00Z",
    previousChecksums: hash(previousIndex),
    artifacts: [
      {
        path: "org/example/library/2.0.0/library-2.0.0.jar",
        sha256: "a".repeat(64),
        identity: "Previously reviewed project checksum",
        authentication: "reviewed-pin",
      },
    ],
  };
  writeFileSync(join(f.root, ".mvn/checksums/authentication.json"), JSON.stringify(authentication));
  const changed = await maintenanceMain(["apply", plan, "--refresh-locks", "--resume"], f.root, run).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(describeError(changed)).toMatch(/Frozen Maven qualification changed reviewed checksums/);
  const unrepaired = await maintenanceMain(["apply", plan, "--refresh-locks", "--resume"], f.root, run).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(describeError(unrepaired)).toMatch(/inputs differ from the accepted proposal/);
  writeFileSync(join(f.root, ".mvn/checksums/checksums.sha256"), acceptedIndex);
  await maintenanceMain(["apply", plan, "--refresh-locks", "--resume"], f.root, run);
  expect(qualified).toEqual(["native", "guix", "nix", "nix"]);
  expect(f.read(".mvn/checksums/checksums.sha256")).toBe(acceptedIndex);
});

test("workflow pin enforcement rejects mutable references and preserves sub-action identities", () => {
  expect(() => actionPins("steps:\n  - uses: example/action@main\n", true)).toThrow(/immutable/);
  expect(() => actionPins(`steps:\n  - uses: example/action@${"a".repeat(40)}\n`, true)).toThrow(/version comments/);
  expect(actionPins(`steps:\n  - uses: example/action/setup@${"a".repeat(40)} # v1.0.0\n`, true)[0]).toMatchObject({
    name: "example/action",
    component: "example/action/setup",
  });
});

test("workflow pin enforcement distinguishes component uses from ordinary environment or input keys", () => {
  const source = `jobs:\n  check:\n    env: {uses: arbitrary text}\n    steps:\n      - uses: example/action@${"a".repeat(40)} # v1.0.0\n        with: {uses: arbitrary input}\n`;
  expect(actionPins(source, true)).toHaveLength(1);
});
