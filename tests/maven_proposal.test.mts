import { Command } from "commander";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import * as publication from "../scripts/file-publication.mjs";
import * as acquisition from "../src/maven-acquisition.ts";
import { acquisitionInputs, decodeMavenEvidence, type MavenAuthentication } from "../src/maven-policy.ts";
import { mavenDigest, verifyMavenArtifact } from "../src/maven-artifacts.ts";
import {
  acceptMavenDependencies,
  recoverMavenAcceptance,
  requireAcceptedMavenInputs,
  requireMavenProposalAcceptance,
} from "../src/maven-proposal.ts";
import { registerMavenCommands } from "../src/cli/maven.ts";
import { NativeToolUnavailable } from "../src/tool-probes.ts";
import * as artifacts from "../src/maven-artifacts.ts";
import { mavenMetadataLimit } from "../src/maven-files.ts";

const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-maven-proposal-"));
  temporary.push(root);
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, "state"));
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "cache"));
  vi.stubEnv("WORKBENCH_MAVEN_REPOSITORY", join(root, "retained-inputs"));
  const directory = join(root, ".mvn/checksums");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(root, "pom.xml"), "<project><artifactId>application</artifactId></project>\n");
  const config = {
    resolver: "org.apache.maven.plugins:maven-dependency-plugin:3.11.0:go-offline",
    trust: [{ prefix: "org/example/", identity: "Fixture authority", unavailable: "No fixture signing service" }],
  };
  writeFileSync(join(root, ".mvn/acquisition.json"), JSON.stringify(config));
  const path = "org/example/library/2/library-2.jar";
  const bytes = Buffer.from("new reviewed dependency\n");
  const old = `${"0".repeat(64)}  org/example/library/1/library-1.jar\n`;
  writeFileSync(join(directory, "checksums.sha256"), old);
  const proposal = join(root, "proposal");
  mkdirSync(dirname(join(proposal, "repository", path)), { recursive: true });
  writeFileSync(join(proposal, "repository", path), bytes);
  const checksums = `${mavenDigest(bytes)}  ${path}\n`;
  writeFileSync(join(proposal, "checksums.sha256"), checksums);
  const authentication: MavenAuthentication = {
    schema: 1,
    pom: mavenDigest(readFileSync(join(root, "pom.xml"))),
    policy: acquisitionInputs(root).policy,
    resolver: config.resolver,
    previousChecksums: mavenDigest(Buffer.from(old)),
    preparedAt: "2026-01-01T00:00:00.000Z",
    checksumSHA256: mavenDigest(Buffer.from(checksums)),
    artifacts: [
      {
        path,
        sha256: mavenDigest(bytes),
        identity: "Fixture authority",
        authentication: "unavailable",
        reason: "No fixture signing service",
      },
    ],
  };
  const update = () => {
    writeFileSync(join(proposal, "authentication.json"), JSON.stringify(authentication));
  };
  update();
  return {
    root,
    directory,
    proposal,
    path,
    bytes,
    checksums,
    old,
    config,
    authentication,
    update,
    journal: () => readdirSync(join(root, "state/maven-activations")).filter((file) => file.endsWith(".json")),
  };
}

test("interrupted acceptance recovers the approved pair without requiring its proposal directory", async () => {
  const f = fixture();
  const publish = publication.publishCheckedFiles;
  vi.spyOn(publication, "publishCheckedFiles").mockImplementationOnce((files, validate) => {
    publish(files.slice(0, 1), validate);
    throw new Error("Interrupted after publishing authentication");
  });
  await expect(acceptMavenDependencies(f.root, f.proposal)).rejects.toThrow(/Interrupted/);
  expect(readFileSync(join(f.directory, "checksums.sha256"), "utf8")).toBe(f.old);
  expect(readFileSync(join(f.root, "retained-inputs", f.path))).toEqual(f.bytes);
  expect(existsSync(join(f.directory, "authentication.json"))).toBe(true);
  expect(f.journal()).toHaveLength(1);
  rmSync(f.proposal, { recursive: true });
  requireAcceptedMavenInputs(f.root);
  expect(readFileSync(join(f.directory, "checksums.sha256"), "utf8")).toBe(f.checksums);
  expect(f.journal()).toEqual([]);
  expect(() => {
    requireAcceptedMavenInputs(f.root);
  }).not.toThrow();
});

test("a conflicting cache input prevents activation and preserves both the cache and project lock", async () => {
  const f = fixture(),
    cached = join(f.root, "retained-inputs", f.path);
  mkdirSync(dirname(cached), { recursive: true });
  writeFileSync(cached, "conflicting existing cache bytes");
  await expect(acceptMavenDependencies(f.root, f.proposal)).rejects.toThrow(/checksum mismatch/);
  expect(readFileSync(cached, "utf8")).toBe("conflicting existing cache bytes");
  expect(readFileSync(join(f.directory, "checksums.sha256"), "utf8")).toBe(f.old);
  expect(existsSync(join(f.directory, "authentication.json"))).toBe(false);
});

test.each(["checksum", "pom", "policy"] as const)(
  "intervening %s changes preserve the partial acceptance and recovery evidence",
  async (change) => {
    const f = fixture();
    const publish = publication.publishCheckedFiles;
    const affected =
      change === "checksum"
        ? join(f.directory, "checksums.sha256")
        : change === "pom"
          ? join(f.root, "pom.xml")
          : join(f.root, ".mvn/acquisition.json");
    const edited = change === "policy" ? JSON.stringify({ ...f.config, trust: [] }) : "concurrent human edit\n";
    vi.spyOn(publication, "publishCheckedFiles").mockImplementationOnce((files, validate) => {
      publish(files, validate, (path) => {
        if (path.endsWith("authentication.json")) writeFileSync(affected, edited);
      });
    });
    await expect(acceptMavenDependencies(f.root, f.proposal)).rejects.toThrow(
      /published files: .*authentication\.json/,
    );
    expect(readFileSync(affected, "utf8")).toBe(edited);
    expect(f.journal()).toHaveLength(1);
    expect(() => {
      recoverMavenAcceptance(f.root);
    }).toThrow(/conflicts|changed project inputs/);
    expect(readFileSync(affected, "utf8")).toBe(edited);
    expect(f.journal()).toHaveLength(1);
  },
);

test("acceptance rejects stale destinations and a forged reviewed-pin downgrade without publishing", async () => {
  const f = fixture();
  writeFileSync(join(f.directory, "checksums.sha256"), "human changed checksums\n");
  await expect(acceptMavenDependencies(f.root, f.proposal)).rejects.toThrow(/Invalid Maven checksum entry/);
  expect(existsSync(join(f.directory, "authentication.json"))).toBe(false);
  writeFileSync(join(f.directory, "checksums.sha256"), `${"1".repeat(64)}  ${f.path}\n`);
  await expect(acceptMavenDependencies(f.root, f.proposal)).rejects.toThrow(/changed after preparation/);
  expect(existsSync(join(f.directory, "authentication.json"))).toBe(false);
  writeFileSync(join(f.directory, "checksums.sha256"), f.old);
  const evidence = f.authentication as unknown as { artifacts: unknown[] };
  evidence.artifacts = [
    {
      path: f.path,
      sha256: mavenDigest(f.bytes),
      identity: "Previously reviewed project checksum",
      authentication: "reviewed-pin",
    },
  ];
  f.update();
  await expect(acceptMavenDependencies(f.root, f.proposal)).rejects.toThrow(/reviewed-pin evidence/);
  expect(readFileSync(join(f.directory, "checksums.sha256"), "utf8")).toBe(f.old);
});

test("accepted proposal checkpoint binds schema, current inputs and exact checksum bytes", async () => {
  const f = fixture();
  await expect(requireMavenProposalAcceptance(f.root, f.proposal)).rejects.toThrow(/requires acceptance/);
  await acceptMavenDependencies(f.root, f.proposal);
  await expect(requireMavenProposalAcceptance(f.root, f.proposal)).resolves.toBeUndefined();
  const evidence = join(f.directory, "authentication.json");
  writeFileSync(evidence, JSON.stringify({ ...f.authentication, schema: 2 }));
  await expect(requireMavenProposalAcceptance(f.root, f.proposal)).rejects.toThrow(
    /Invalid Maven authentication record/,
  );
  expect(() => {
    requireAcceptedMavenInputs(f.root);
  }).toThrow(/Invalid Maven authentication record/);
});

const signature = { fingerprint: "A".repeat(40), primaryFingerprint: "B".repeat(40), createdAt: 1, expiresAt: 0 };
const signed = {
  path: "org/example/library/1/library-1.jar",
  sha256: "0".repeat(64),
  identity: "Owner",
  authentication: "signature",
  proof: "https://example.org/library.jar.asc",
  signatures: [signature],
};
test.each([
  { ...signed, signatures: [{}] },
  { ...signed, signatures: [{ ...signature, fingerprint: "A123" }] },
  { ...signed, signatures: [{ ...signature, expiresAt: -1 }] },
  { ...signed, signatures: [{ ...signature, createdAt: 1.5 }] },
  { ...signed, signatures: [{ ...signature, signers: [signature.fingerprint] }] },
  { ...signed, proof: "http://example.org/library.jar.asc" },
  { ...signed, authentication: "reviewed-pin" },
  { ...signed, authentication: "unavailable", reason: "No signing" },
])("persisted Maven evidence rejects invalid or contradictory authentication: %#", (evidence) => {
  expect(() => decodeMavenEvidence(evidence)).toThrow(/evidence/);
});

test("artifact verification copies exactly the authenticated bytes and preserves existing destinations", async () => {
  const f = fixture();
  const output = join(f.root, "verified.jar");
  const checksums = new Map([[f.path, mavenDigest(f.bytes)]]);
  await expect(verifyMavenArtifact(join(f.proposal, "repository"), f.path, checksums, output)).resolves.toBe(
    mavenDigest(f.bytes),
  );
  expect(readFileSync(output)).toEqual(f.bytes);
  writeFileSync(output, "existing user data");
  await expect(verifyMavenArtifact(join(f.proposal, "repository"), f.path, checksums, output)).rejects.toThrow();
  expect(readFileSync(output, "utf8")).toBe("existing user data");
  const rejected = join(f.root, "rejected.jar");
  await expect(
    verifyMavenArtifact(join(f.proposal, "repository"), f.path, new Map([[f.path, "f".repeat(64)]]), rejected),
  ).rejects.toThrow(/checksum mismatch/);
  expect(existsSync(rejected)).toBe(false);
});

function configureJavaRoot(root: string, path: string) {
  const distribution = resolve(import.meta.dirname, "..");
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  mkdirSync(join(root, path), { recursive: true });
  mkdirSync(join(root, "workbench"), { recursive: true });
  writeFileSync(
    join(root, "workbench/config.toml"),
    "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
  );
  writeFileSync(
    join(root, "workbench/projects.toml"),
    `[[project]]\nid="fixture"\npath="."\n[[language_root]]\npath = ${JSON.stringify(path)}\nlanguage = "java"\n`,
  );
  return join(root, path);
}

test("Maven prepare rejects incomplete root selectors before acquisition begins", async () => {
  const f = fixture(),
    nested = "storage's Java root";
  const directory = configureJavaRoot(f.root, nested);
  const output = join(f.root, "must-not-be-created");
  const prepare = vi
    .spyOn(acquisition, "prepareMavenDependencies")
    .mockResolvedValue({ directory: output, artifacts: 0 });
  const program = new Command();
  registerMavenCommands(program, f.root);
  const rejected = program.parseAsync(["maven", "prepare", "--path", nested, "--output", output], { from: "user" });
  await expect(rejected).rejects.toBeInstanceOf(NativeToolUnavailable);
  await expect(rejected).rejects.toThrow(nested);
  await expect(rejected).rejects.toThrow(/java \(\.java-version\), maven \(\.tool-versions\)/);
  await expect(rejected).rejects.toThrow("--path 'storage'\\''s Java root'");
  expect(prepare).not.toHaveBeenCalled();
  expect(existsSync(output)).toBe(false);
  expect(existsSync(join(directory, ".java-version"))).toBe(false);
  expect(existsSync(join(directory, ".tool-versions"))).toBe(false);
});

test("the prepare completion command retains the selected nested root and quotes literal paths", async () => {
  const f = fixture();
  const nested = "nested Java root";
  const directory = configureJavaRoot(f.root, nested);
  for (const file of [".java-version", ".tool-versions"])
    writeFileSync(
      join(directory, file),
      readFileSync(resolve(import.meta.dirname, "../examples/languages/java", file)),
    );
  const output = join(f.root, "review's $proposal");
  const prepare = vi
    .spyOn(acquisition, "prepareMavenDependencies")
    .mockResolvedValue({ directory: output, artifacts: 2 });
  const messages = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const program = new Command();
  registerMavenCommands(program, f.root);
  await program.parseAsync(["maven", "prepare", "--path", nested, "--output", output], { from: "user" });
  expect(prepare).toHaveBeenCalledWith(join(f.root, nested), output);
  const command = String(messages.mock.calls.at(-1)?.[0]);
  expect(command).toContain("accept --path 'nested Java root' --proposal '");
  expect(command).toContain("review'\\''s $proposal'");
});

test("cancellation after retention leaves the project lock unactivated", async () => {
  const f = fixture(),
    controller = new AbortController(),
    retain = artifacts.retainMavenArtifacts;
  vi.spyOn(artifacts, "retainMavenArtifacts").mockImplementationOnce(async (...args) => {
    await retain(...args);
    controller.abort();
  });
  await expect(acceptMavenDependencies(f.root, f.proposal, controller.signal)).rejects.toThrow(/abort/i);
  expect(readFileSync(join(f.directory, "checksums.sha256"), "utf8")).toBe(f.old);
  expect(existsSync(join(f.directory, "authentication.json"))).toBe(false);
  expect(readFileSync(join(f.root, "retained-inputs", f.path))).toEqual(f.bytes);
});

test("an activation too large to recover fails before artifact retention", async () => {
  const f = fixture(),
    previous = JSON.stringify({ note: "\n".repeat(Math.floor(mavenMetadataLimit * 0.4)) });
  const path = join(f.directory, "authentication.json");
  writeFileSync(path, previous);
  await expect(acceptMavenDependencies(f.root, f.proposal)).rejects.toThrow(/recovery record size limit/);
  expect(existsSync(join(f.root, "retained-inputs"))).toBe(false);
  expect(readFileSync(path, "utf8")).toBe(previous);
  expect(readFileSync(join(f.directory, "checksums.sha256"), "utf8")).toBe(f.old);
});

test("oversized proposal metadata is rejected without activating or retaining artifacts", async () => {
  const f = fixture();
  truncateSync(join(f.proposal, "authentication.json"), mavenMetadataLimit + 1);
  await expect(acceptMavenDependencies(f.root, f.proposal)).rejects.toThrow(/oversized Maven metadata/);
  expect(existsSync(join(f.root, "retained-inputs"))).toBe(false);
  expect(readFileSync(join(f.directory, "checksums.sha256"), "utf8")).toBe(f.old);
});

test("a metadata edit during retention remains intact and blocks activation", async () => {
  const f = fixture(),
    retain = artifacts.retainMavenArtifacts,
    path = join(f.directory, "authentication.json"),
    edited = "concurrent metadata edit\n";
  vi.spyOn(artifacts, "retainMavenArtifacts").mockImplementationOnce(async (...args) => {
    await retain(...args);
    writeFileSync(path, edited);
  });
  await expect(acceptMavenDependencies(f.root, f.proposal)).rejects.toThrow(/input changed during execution/);
  expect(readFileSync(path, "utf8")).toBe(edited);
  expect(readFileSync(join(f.directory, "checksums.sha256"), "utf8")).toBe(f.old);
});
