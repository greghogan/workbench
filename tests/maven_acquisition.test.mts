import { afterEach, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import * as native from "../src/native-tools.ts";
import * as execution from "../src/tool-execution.ts";
import { prepareMavenDependencies, checkMavenAcquisitionPom } from "../src/maven-acquisition.ts";
import { acceptMavenDependencies, requireMavenProposalAcceptance } from "../src/maven-proposal.ts";
import { decodeMavenAcquisition, decodeMavenAuthentication } from "../src/maven-policy.ts";
import { mavenDigest } from "../src/maven-artifacts.ts";
import * as policy from "../src/maven-policy.ts";
import * as children from "../scripts/owned-child.mjs";
import * as fs from "node:fs";
vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));

const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
const authentication = (directory: string) =>
  decodeMavenAuthentication(JSON.parse(readFileSync(join(directory, "authentication.json"), "utf8")));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-maven-prepare-"));
  temporary.push(root);
  mkdirSync(join(root, ".mvn/checksums"), { recursive: true });
  writeFileSync(
    join(root, "pom.xml"),
    "<project><modelVersion>4.0.0</modelVersion><groupId>org.example</groupId><artifactId>app</artifactId><version>1</version></project>",
  );
  const config = {
    resolver: "org.apache.maven.plugins:maven-dependency-plugin:3.11.0:go-offline",
    trust: [
      {
        prefix: "org/example/",
        identity: "Unsigned integration fixture owner",
        unavailable: "Local fixture has no signing authority",
      },
    ],
  };
  writeFileSync(join(root, ".mvn/acquisition.json"), JSON.stringify(config));
  const path = "org/example/library/1/library-1.jar",
    bytes = Buffer.from("candidate library bytes");
  const client = join(import.meta.dirname, "fixtures/maven-client.mts"),
    scenario = join(root, "scenario.json");
  const requests = (paths: string[]) => {
    writeFileSync(scenario, JSON.stringify({ requests: paths }));
  };
  requests([path]);
  const result = () =>
    JSON.parse(readFileSync(join(root, "response.json"), "utf8")) as {
      responses: { path: string; status: number; bytes: string }[];
      files: string[];
    };
  vi.spyOn(native, "nativeEnvironment").mockReturnValue({
    ...process.env,
    FIXTURE_HTTP_RESULT: join(root, "response.json"),
    FIXTURE_SCENARIO: scenario,
  });
  const invoke = execution.commandInvocation;
  vi.spyOn(execution, "commandInvocation").mockImplementation((command, args, env, cwd) =>
    command === "mvn" ? [process.execPath, client, ...args] : invoke(command, args, env, cwd),
  );
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", join(import.meta.dirname, ".."));
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "cache"));
  vi.stubEnv("WORKBENCH_MAVEN_REPOSITORY", join(root, "retained-inputs"));
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, "state"));
  vi.stubGlobal("fetch", () => Promise.resolve(new Response(bytes)));
  return { root, path, bytes, config, result, requests, proposal: join(root, "proposal") };
}

test("preparation retains explicit unavailable evidence and activates only after the separate acceptance", async () => {
  const { root, path, bytes, proposal } = fixture();
  await prepareMavenDependencies(root, proposal);
  expect(existsSync(join(root, ".mvn/checksums/checksums.sha256"))).toBe(false);
  expect(readFileSync(join(proposal, "checksums.sha256"), "utf8")).toBe(`${mavenDigest(bytes)}  ${path}\n`);
  expect(authentication(proposal).artifacts[0]?.authentication).toBe("unavailable");
  expect(authentication(proposal).artifacts[0]).toHaveProperty("reason", "Local fixture has no signing authority");
  await expect(requireMavenProposalAcceptance(root, proposal)).rejects.toThrow(/requires acceptance/);
  await acceptMavenDependencies(root, proposal);
  expect(readFileSync(join(root, "retained-inputs", path))).toEqual(bytes);
  await expect(requireMavenProposalAcceptance(root, proposal)).resolves.toBeUndefined();
  const repeat = join(root, "repeated-proposal");
  await prepareMavenDependencies(root, repeat);
  expect(authentication(repeat).artifacts).toEqual(authentication(proposal).artifacts);
  await expect(requireMavenProposalAcceptance(root, repeat)).resolves.toBeUndefined();
  const accepted = readFileSync(join(root, ".mvn/checksums/checksums.sha256"), "utf8");
  writeFileSync(join(proposal, "repository", path), "altered after preparation");
  await expect(acceptMavenDependencies(root, proposal)).rejects.toThrow(/checksum mismatch/);
  expect(readFileSync(join(root, ".mvn/checksums/checksums.sha256"), "utf8")).toBe(accepted);
  writeFileSync(join(root, "pom.xml"), "<project/>");
  await expect(acceptMavenDependencies(root, proposal)).rejects.toThrow(/stale/);
});

test("unmapped new artifacts never reach Maven, even when its resolver ignores the HTTP error", async () => {
  const { root, config, proposal, result } = fixture();
  writeFileSync(join(root, ".mvn/acquisition.json"), JSON.stringify({ ...config, trust: [] }));
  await expect(prepareMavenDependencies(root, proposal)).rejects.toThrow(/No declared Maven authentication/);
  const response = result().responses[0];
  expect(response?.status).toBe(502);
  expect(response?.bytes).not.toContain("candidate library bytes");
  expect(existsSync(proposal)).toBe(false);
});

test("source preparation stages only metadata, serves owned POMs, and never acquires source JARs", async () => {
  const { root, config, proposal, path, requests, result } = fixture();
  mkdirSync(join(root, "library/.mvn/checksums"), { recursive: true });
  writeFileSync(
    join(root, "library/pom.xml"),
    "<project><modelVersion>4.0.0</modelVersion><groupId>org.fixture</groupId><artifactId>local</artifactId><version>1</version></project>",
  );
  writeFileSync(join(root, ".mvn/acquisition.json"), JSON.stringify({ ...config, sources: ["library"] }));
  const pom = readFileSync(join(root, "pom.xml"));
  writeFileSync(join(root, ".mvn/checksums/checksums.sha256"), "");
  writeFileSync(join(root, "library/.mvn/checksums/checksums.sha256"), "");
  requests(["org/fixture/local/1/local-1.pom", path]);
  await prepareMavenDependencies(root, proposal);
  expect(result().responses[0]?.status).toBe(200);
  expect(result().responses[0]?.bytes).toContain("<artifactId>local</artifactId>");
  expect(result().files).toHaveLength(3);
  expect(result().files.every((file) => file.endsWith("pom.xml"))).toBe(true);
  expect(readFileSync(join(proposal, "checksums.sha256"), "utf8")).not.toContain("org/fixture/");
  await acceptMavenDependencies(root, proposal);
  requests(["org/fixture/local/1/local-1.jar", path]);
  await expect(prepareMavenDependencies(root, join(root, "source-jar-proposal"))).rejects.toThrow(
    /requested a source build output/,
  );
  expect(readFileSync(join(root, "pom.xml"))).toEqual(pom);
  expect(existsSync(join(root, "source-jar-proposal"))).toBe(false);
});

test("optional missing artifacts remain HTTP 404, while textual HTTP errors remain authentication failures", async () => {
  const { root, proposal } = fixture();
  vi.stubGlobal("fetch", () => Promise.resolve(new Response("Missing", { status: 404 })));
  await expect(prepareMavenDependencies(root, proposal)).rejects.toThrow(/no authenticated artifacts/);
  expect(
    (JSON.parse(readFileSync(join(root, "response.json"), "utf8")) as { responses: unknown[] }).responses[0],
  ).toMatchObject({ status: 404 });
  vi.stubGlobal("fetch", () => {
    throw new Error("HTTP 404 appears in this authentication diagnostic");
  });
  await expect(prepareMavenDependencies(root, proposal)).rejects.toThrow(/authentication diagnostic/);
  expect(
    (JSON.parse(readFileSync(join(root, "response.json"), "utf8")) as { responses: unknown[] }).responses[0],
  ).toMatchObject({ status: 502 });
  expect(existsSync(proposal)).toBe(false);
});

test("a missing required signature fails preparation even when Maven ignores the mirror error", async () => {
  const { root, config, proposal, bytes } = fixture();
  writeFileSync(join(root, "keys.asc"), "fixture key, never passed to a verifier");
  writeFileSync(
    join(root, ".mvn/acquisition.json"),
    JSON.stringify({
      ...config,
      trust: [
        { prefix: "org/example/", identity: "Signed fixture publisher", keys: "keys.asc", signers: ["A".repeat(40)] },
      ],
    }),
  );
  vi.stubGlobal("fetch", (url: string | URL | Request) =>
    Promise.resolve(
      (url instanceof Request ? url.url : url.toString()).endsWith(".asc")
        ? new Response("Signature missing", { status: 404 })
        : new Response(bytes),
    ),
  );
  await expect(prepareMavenDependencies(root, proposal)).rejects.toThrow(/no unsigned fallback/);
  expect(
    (JSON.parse(readFileSync(join(root, "response.json"), "utf8")) as { responses: unknown[] }).responses[0],
  ).toMatchObject({ status: 502 });
  expect(existsSync(proposal)).toBe(false);
});

test("reviewed cached artifacts are rehashed and reused without network acquisition", async () => {
  const { root, config, proposal, path, bytes } = fixture();
  const repository = join(root, "existing-repository");
  mkdirSync(dirname(join(repository, path)), { recursive: true });
  writeFileSync(join(repository, path), bytes);
  writeFileSync(join(root, ".mvn/checksums/checksums.sha256"), `${mavenDigest(bytes)}  ${path}\n`);
  writeFileSync(
    join(root, "keys.asc"),
    "A newly declared authority must not invalidate a previously reviewed immutable pin",
  );
  writeFileSync(
    join(root, ".mvn/acquisition.json"),
    JSON.stringify({
      ...config,
      trust: [
        { prefix: "org/example/", identity: "New publisher policy", keys: "keys.asc", signers: ["A".repeat(40)] },
      ],
    }),
  );
  vi.stubEnv("WORKBENCH_MAVEN_REPOSITORY", repository);
  const fetcher = vi.fn(() => {
    throw new Error("Network acquisition should not be needed");
  });
  vi.stubGlobal("fetch", fetcher);
  await prepareMavenDependencies(root, proposal);
  await acceptMavenDependencies(root, proposal);
  expect(fetcher).not.toHaveBeenCalled();
  expect(readFileSync(join(proposal, "repository", path))).toEqual(bytes);
  writeFileSync(join(repository, path), "corrupt existing repository");
  await expect(prepareMavenDependencies(root, join(root, "corrupt-proposal"))).rejects.toThrow(/checksum mismatch/);
  expect(fetcher).not.toHaveBeenCalled();
});

test("reviewed artifact hashes still bind preparation, while project extensions cannot be loaded", async () => {
  const { root, path, proposal, config } = fixture();
  writeFileSync(join(root, ".mvn/checksums/checksums.sha256"), `${"0".repeat(64)}  ${path}\n`);
  writeFileSync(join(root, ".mvn/acquisition.json"), JSON.stringify({ ...config, trust: [] }));
  await expect(prepareMavenDependencies(root, proposal)).rejects.toThrow(/checksum mismatch/);
  for (const pom of [
    "<project><parent/></project>",
    "<project><build><extensions/></build></project>",
    '<!DOCTYPE project SYSTEM "file:///etc/passwd"><project/>',
  ])
    expect(() => {
      checkMavenAcquisitionPom(pom);
    }).toThrow();
  expect(() => decodeMavenAcquisition({ resolver: "test", trust: [] })).toThrow(/pinned/);
  expect(() =>
    decodeMavenAcquisition({ ...config, trust: [{ ...config.trust[0], keys: "key.asc", signers: ["A".repeat(40)] }] }),
  ).toThrow(/cannot replace/);
});

test("a declared signature must verify before Maven receives candidate bytes; failure never becomes unsigned acceptance", async () => {
  const { root, proposal, config } = fixture();
  const bytes = readFileSync(new URL("./fixtures/node-shasums.txt", import.meta.url));
  const signature = readFileSync(new URL("./fixtures/node-shasums.sig", import.meta.url));
  writeFileSync(join(root, "keys.asc"), readFileSync(new URL("../scripts/keys/node.asc", import.meta.url)));
  const rule = {
    prefix: "org/example/",
    identity: "Node release authority, independent fixture mapping",
    keys: "keys.asc",
    signers: ["C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C", "5BE8A3F6C8A5C01D106C0AD820B1A390B168D356"],
  };
  writeFileSync(join(root, ".mvn/acquisition.json"), JSON.stringify({ ...config, trust: [rule] }));
  vi.stubGlobal("fetch", (url: string | URL | Request) =>
    Promise.resolve(
      new Response((url instanceof Request ? url.url : url.toString()).endsWith(".asc") ? signature : bytes),
    ),
  );
  await prepareMavenDependencies(root, proposal);
  expect(authentication(proposal).artifacts[0]?.authentication).toBe("signature");
  expect(authentication(proposal).artifacts[0]?.sha256).toBe(mavenDigest(bytes));
  expect(
    (JSON.parse(readFileSync(join(root, "response.json"), "utf8")) as { responses: { status: number }[] }).responses[0]
      ?.status,
  ).toBe(200);
  vi.stubGlobal("fetch", (url: string | URL | Request) =>
    Promise.resolve(
      new Response(
        (url instanceof Request ? url.url : url.toString()).endsWith(".asc") ? signature : "altered candidate bytes",
      ),
    ),
  );
  await expect(prepareMavenDependencies(root, join(root, "rejected"))).rejects.toThrow(
    /signature verification failed for .*library-1\.jar/,
  );
  expect(readFileSync(join(root, "response.json"), "utf8")).not.toContain("altered candidate bytes");
  expect(existsSync(join(root, "rejected"))).toBe(false);
  await acceptMavenDependencies(root, proposal);
  const path = "org/example/library/1/library-1.jar",
    cached = join(root, "cached", path);
  mkdirSync(dirname(cached), { recursive: true });
  writeFileSync(cached, bytes);
  vi.stubEnv("WORKBENCH_MAVEN_REPOSITORY", join(root, "cached"));
  vi.stubGlobal("fetch", () => {
    throw new Error("An immutable reviewed input must reuse its recorded evidence");
  });
  const repeated = join(root, "reused");
  await prepareMavenDependencies(root, repeated);
  expect(authentication(repeated).artifacts).toEqual(authentication(proposal).artifacts);
  await acceptMavenDependencies(root, repeated);
});

test("preparation rejects a consumer edit after capture instead of publishing a graph for different inputs", async () => {
  const f = fixture(),
    read = policy.acquisitionInputs;
  vi.spyOn(policy, "acquisitionInputs").mockImplementationOnce((root) => {
    const inputs = read(root);
    writeFileSync(join(root, "pom.xml"), inputs.pom.toString().replace("<version>1</version>", "<version>2</version>"));
    return inputs;
  });
  await expect(prepareMavenDependencies(f.root, f.proposal)).rejects.toThrow(/input changed during execution/);
  expect(existsSync(f.proposal)).toBe(false);
});

test("cancellation after the resolver succeeds cannot publish a proposal", async () => {
  const f = fixture(),
    controller = new AbortController(),
    close = vi.fn();
  vi.spyOn(children, "processCancellation").mockReturnValue({ signal: controller.signal, close });
  const execute = children.runOwnedChild;
  vi.spyOn(children, "runOwnedChild").mockImplementation(async (...args) => {
    const outcome = await execute(...args);
    controller.abort();
    return outcome;
  });
  await expect(prepareMavenDependencies(f.root, f.proposal)).rejects.toThrow(/abort/i);
  expect(existsSync(f.proposal)).toBe(false);
  expect(close).toHaveBeenCalledOnce();
});

test("a consumer retains provider signature provenance only while its own policy authorizes it", async () => {
  const f = fixture(),
    library = join(f.root, "library"),
    key = "A".repeat(40),
    checksums = `${mavenDigest(f.bytes)}  ${f.path}\n`;
  mkdirSync(join(library, ".mvn/checksums"), { recursive: true });
  writeFileSync(
    join(library, "pom.xml"),
    "<project><groupId>org.fixture</groupId><artifactId>provider</artifactId><version>1</version></project>",
  );
  writeFileSync(join(library, ".mvn/checksums/checksums.sha256"), checksums);
  writeFileSync(join(f.root, ".mvn/checksums/checksums.sha256"), "");
  writeFileSync(join(f.root, "keys.asc"), "Previously established key; no new verification is performed");
  const config = {
    ...f.config,
    sources: ["library"],
    trust: [{ prefix: "org/example/", identity: "Fixture publisher", keys: "keys.asc", signers: [key] }],
  };
  writeFileSync(join(f.root, ".mvn/acquisition.json"), JSON.stringify(config));
  const evidence = {
    path: f.path,
    sha256: mavenDigest(f.bytes),
    identity: "Fixture publisher",
    authentication: "signature",
    proof: "https://example.org/library.jar.asc",
    signatures: [{ fingerprint: key, primaryFingerprint: key, createdAt: 1, expiresAt: 0 }],
  };
  writeFileSync(
    join(library, ".mvn/checksums/authentication.json"),
    JSON.stringify({
      schema: 1,
      checksumSHA256: mavenDigest(Buffer.from(checksums)),
      preparedAt: "2026-01-01T00:00:00Z",
      pom: "0".repeat(64),
      policy: "0".repeat(64),
      previousChecksums: null,
      resolver: f.config.resolver,
      artifacts: [evidence],
    }),
  );
  mkdirSync(dirname(join(f.root, "retained-inputs", f.path)), { recursive: true });
  writeFileSync(join(f.root, "retained-inputs", f.path), f.bytes);
  vi.stubGlobal("fetch", () => {
    throw new Error("Reviewed inputs must use the retained bytes");
  });
  await prepareMavenDependencies(f.root, f.proposal);
  expect(authentication(f.proposal).artifacts).toEqual([evidence]);
  writeFileSync(join(f.root, ".mvn/acquisition.json"), JSON.stringify({ ...config, trust: [] }));
  const revised = join(f.root, "revised");
  await prepareMavenDependencies(f.root, revised);
  expect(authentication(revised).artifacts).toEqual([
    {
      path: f.path,
      sha256: mavenDigest(f.bytes),
      authentication: "reviewed-pin",
      identity: "Previously reviewed project checksum",
    },
  ]);
});

test("a preparation failure retains its cause when scratch cleanup fails", async () => {
  const f = fixture(),
    cleanupFailure = new Error("scratch cleanup failed"),
    remove = fs.rmSync,
    controller = new AbortController(),
    close = vi.fn();
  writeFileSync(join(f.root, ".mvn/acquisition.json"), JSON.stringify({ ...f.config, trust: [] }));
  vi.spyOn(children, "processCancellation").mockReturnValue({ signal: controller.signal, close });
  vi.spyOn(fs, "rmSync").mockImplementation((path, options) => {
    if (typeof path === "string" && /[\\/]\.maven-preparation-[^\\/]+$/u.test(path)) throw cleanupFailure;
    remove(path, options);
  });
  const failure: unknown = await prepareMavenDependencies(f.root, f.proposal).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  const failures = (failure as AggregateError).errors as unknown[];
  expect(failures[0]).toHaveProperty("message", expect.stringContaining("No declared Maven authentication"));
  expect(failures).toContain(cleanupFailure);
  expect(close).toHaveBeenCalledOnce();
  expect(existsSync(f.proposal)).toBe(false);
});
