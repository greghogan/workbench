import { required } from "../src/invariants.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { consumer, distribution, provider } from "./fixtures/adoption.mjs";
import { installSelectedCollections } from "../src/collection-install.ts";
import {
  approveLocalPolicy,
  cancelLocalRemoval,
  prepareLocalPolicy,
  prepareLocalRemoval,
  reviewLocalPolicy,
} from "../src/local-policy.ts";
import { registryPins, resolveCollections } from "../src/collections.ts";
import { renderAgentContext } from "../src/agents.ts";
import { syncLocalContext, syncLocalContextIndex } from "../src/local-context.ts";
import {
  acknowledgePolicyCompatibility,
  checkPolicyCompatibility,
  policyCompatibility,
  policyExecutionEnvironment,
  projectPolicyFingerprint,
} from "../src/policy-compatibility.ts";
import { provisionCollectionSnapshot } from "../src/collection-provision.ts";
import { userDirectory } from "../src/storage.ts";
import { cpSync } from "node:fs";

const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
async function fixture() {
  const storage = mkdtempSync(join(tmpdir(), "workbench-policy-"));
  temporary.push(storage);
  for (const kind of ["CONFIG", "DATA", "CACHE", "STATE"])
    vi.stubEnv(`WORKBENCH_${kind}_HOME`, join(storage, kind.toLowerCase()));
  vi.stubEnv("XDG_DATA_DIRS", join(storage, "system"));
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const root = await consumer();
  temporary.push(root);
  const base = join(root, "workbench/.local-collections");
  const source = provider(root, "machine", "1", [
    "Use the installed scheduler for substantial work.\n\nKeep unrelated process settings unchanged.",
  ]);
  return { root, base, source, storage, draft: join(base, ".drafts/machine/workbench/decisions/ADR-00.md") };
}
const stage = ({ root, source }: Awaited<ReturnType<typeof fixture>>) =>
  installSelectedCollections(root, [{ source: source.directory, sha256: source.pin.sha256 }], { scope: "local" });
const activate = ({ base }: Awaited<ReturnType<typeof fixture>>) => {
  approveLocalPolicy(base, "machine", reviewLocalPolicy(base, "machine").digest, true);
};
const acknowledge = (root: string) => {
  acknowledgePolicyCompatibility(root, policyCompatibility(root).digest, true);
};

test("installation prepares editable policy without activation and creates empty persistent context", async () => {
  const fixture_ = await fixture();
  const { root, base, draft } = fixture_;
  expect(policyCompatibility(root).status).toBe("not-required");
  expect(existsSync(userDirectory("state"))).toBe(false);
  stage(fixture_);
  expect(readFileSync(draft, "utf8")).toContain("installed scheduler");
  expect(registryPins(base)).toEqual([]);
  expect(renderAgentContext(root, true)).not.toContain("machine:ADR-0");
  expect(readFileSync(join(base, "AGENTS.md"), "utf8")).toContain("No local collections");
  expect(readFileSync(join(userDirectory("data"), "AGENTS.md"), "utf8")).toContain("compatibility check");
  expect(
    required(
      reviewLocalPolicy(base, "machine").changes.find((change) => change.path === "workbench/decisions/ADR-00.md"),
      "Local decision change",
    ).after,
  ).toContain("installed scheduler");
});

test("activation requires exact human acknowledgment; edits remain drafts until approved", async () => {
  const fixture_ = await fixture();
  const { root, base, draft } = fixture_;
  stage(fixture_);
  const first = reviewLocalPolicy(base, "machine");
  expect(() => {
    approveLocalPolicy(base, "machine", first.digest, false);
  }).toThrow(/human-approved/);
  expect(() => {
    approveLocalPolicy(base, "machine", "0".repeat(64), true);
  }).toThrow(/review changed/);
  writeFileSync(draft, readFileSync(draft, "utf8").replace("substantial work", "builds and experiments"));
  expect(() => {
    approveLocalPolicy(base, "machine", first.digest, true);
  }).toThrow(/review changed/);
  activate(fixture_);
  const active = renderAgentContext(root, true);
  const pin = registryPins(base)[0];
  expect(
    readFileSync(
      join(
        base,
        required(pin, "Expected fixture value: pin").id,
        required(pin, "Expected fixture value: pin").revision,
        "workbench/decisions/ADR-00.md",
      ),
      "utf8",
    ),
  ).toContain("builds and experiments");
  writeFileSync(draft, readFileSync(draft, "utf8").replaceAll("Policy 0.", "New draft instructions."));
  expect(renderAgentContext(root, true)).toBe(active);
  expect(reviewLocalPolicy(base, "machine").changes).toHaveLength(1);
  activate(fixture_);
  expect(renderAgentContext(root, true)).toContain("New draft instructions.");
});

test("three-way local updates preserve adaptations and retain conflicts for explicit resolution", async () => {
  const fixture_ = await fixture();
  const { root, base, source, draft } = fixture_;
  stage(fixture_);
  activate(fixture_);
  writeFileSync(
    draft,
    readFileSync(draft, "utf8").replace("Use the installed scheduler", "Use the reviewed scheduler"),
  );
  const incoming = provider(root, "machine", "2", [
    "Use the installed scheduler for substantial work.\n\nKeep all unrelated process settings unchanged.",
  ]);
  prepareLocalPolicy(base, incoming.directory, incoming.pin.sha256);
  expect(readFileSync(draft, "utf8")).toContain("Use the reviewed scheduler");
  expect(readFileSync(draft, "utf8")).toContain("all unrelated");
  expect(
    readFileSync(join(base, ".originals", "machine", source.pin.revision, "workbench/decisions/ADR-00.md"), "utf8"),
  ).toContain("installed scheduler");
  const next = provider(root, "machine", "3", [
    "Use a different scheduler for substantial work.\n\nKeep all unrelated process settings unchanged.",
  ]);
  const before = readFileSync(draft);
  let proposal;
  try {
    prepareLocalPolicy(base, next.directory, next.pin.sha256);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    proposal = /Resolve (.+)\/resolved and repeat/.exec(error.message)?.[1];
  }
  expect(proposal).toBeDefined();
  expect(readFileSync(draft)).toEqual(before);
  const resolved = join(required(proposal, "Expected fixture value"), "resolved");
  writeFileSync(join(resolved, "decisions/ADR-00.md"), before);
  prepareLocalPolicy(base, next.directory, next.pin.sha256, resolved);
  expect(readFileSync(draft)).toEqual(before);
  expect(() => prepareLocalPolicy(base, next.directory, next.pin.sha256, resolved)).toThrow(/stale/);
});

test("local removals require approval and leave retained originals and empty discovery", async () => {
  const fixture_ = await fixture();
  const { base, draft } = fixture_;
  stage(fixture_);
  activate(fixture_);
  writeFileSync(draft, readFileSync(draft, "utf8").replace("substantial work", "an unfinished local change"));
  prepareLocalRemoval(base, "machine");
  expect(registryPins(base)).toHaveLength(1);
  expect(reviewLocalPolicy(base, "machine").candidate).toBeUndefined();
  cancelLocalRemoval(base, "machine");
  expect(reviewLocalPolicy(base, "machine").candidate).toBeDefined();
  prepareLocalRemoval(base, "machine");
  activate(fixture_);
  expect(registryPins(base)).toEqual([]);
  expect(existsSync(join(base, ".originals/machine/1/workbench/collection.toml"))).toBe(true);
  expect(readFileSync(draft, "utf8")).toContain("an unfinished local change");
  expect(reviewLocalPolicy(base, "machine").candidate).toBeDefined();
  expect(readFileSync(join(base, "AGENTS.md"), "utf8")).toContain("No local collections");
  expect(existsSync(syncLocalContextIndex())).toBe(true);
});

test("compatibility acknowledgment binds charter, ADR bodies, supporting files, and active local policies", async () => {
  const fixture_ = await fixture();
  const { root, draft } = fixture_;
  stage(fixture_);
  activate(fixture_);
  const status = policyCompatibility(root);
  expect(status.status).toBe("review-required");
  expect(() => {
    checkPolicyCompatibility(root);
  }).toThrow(/review-required/);
  expect(() => {
    acknowledgePolicyCompatibility(root, status.digest, false);
  }).toThrow(/reviewed/);
  acknowledge(root);
  expect(policyCompatibility(root).status).toBe("current");
  writeFileSync(join(root, "unrelated.txt"), "application change\n");
  expect(policyCompatibility(root).status).toBe("current");
  const charter = join(root, "workbench/CHARTER.md");
  writeFileSync(charter, readFileSync(charter, "utf8") + "\nAdditional intent.\n");
  expect(() => {
    acknowledgePolicyCompatibility(root, status.digest, true);
  }).toThrow(/changed/);
  acknowledge(root);
  const decisions = join(root, "workbench/decisions");
  mkdirSync(decisions, { recursive: true });
  writeFileSync(
    join(decisions, "ADR-00.md"),
    "---\nsummary: Local project policy.\n---\n\n# ADR-0: Project policy\n\nUse declared tools.\n",
  );
  expect(policyCompatibility(root).status).toBe("review-required");
  acknowledge(root);
  mkdirSync(join(decisions, "ADR-00"));
  writeFileSync(join(decisions, "ADR-00/design.txt"), "supporting policy material");
  expect(policyCompatibility(root).status).toBe("review-required");
  acknowledge(root);
  writeFileSync(draft, readFileSync(draft, "utf8").replace("Policy 0.", "Changed local policy."));
  expect(policyCompatibility(root).status).toBe("current");
  activate(fixture_);
  expect(policyCompatibility(root).status).toBe("review-required");
});

test("project adaptations conflict with differing local copies despite identical upstream origins", async () => {
  const fixture_ = await fixture();
  const { root, base, source } = fixture_;
  installSelectedCollections(root, [{ source: source.directory }], { scope: "project", commit: source.commit });
  stage(fixture_);
  activate(fixture_);
  expect(resolveCollections(root)).toHaveLength(1);
  acknowledge(root);
  const record = join(root, "workbench/collections/machine/decisions/ADR-00.md");
  writeFileSync(record, readFileSync(record, "utf8").replace("installed scheduler", "project scheduler"));
  expect(policyCompatibility(root).status).toBe("conflict");
  expect(() => {
    acknowledge(root);
  }).toThrow(/collisions/);
  expect(() => resolveCollections(root)).toThrow(/conflicting/);
  expect(renderAgentContext(root, true)).toContain("machine:ADR-0");
  expect(existsSync(join(base, "AGENTS.md"))).toBe(true);
});

test("context freshness blocks acknowledgment and the CLI blocks execution while permitting inspection", async () => {
  const fixture_ = await fixture();
  const { root, base } = fixture_;
  stage(fixture_);
  activate(fixture_);
  writeFileSync(join(base, "AGENTS.md"), "stale\n");
  expect(policyCompatibility(root).status).toBe("stale-context");
  expect(() => {
    acknowledge(root);
  }).toThrow(/refresh/);
  syncLocalContext(base);
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [join(distribution, "bin/workbench.mjs"), ...args], {
      cwd: root,
      env: process.env,
      encoding: "utf8",
    });
  const inspection = run("collection", "context");
  expect(inspection.status, inspection.stderr).toBe(0);
  expect(inspection.stdout).toContain("review-required");
  const marker = join(root, "executed");
  const blocked = run(
    "shell",
    "--",
    "node",
    "-e",
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
  );
  expect(blocked.status).not.toBe(0);
  expect(blocked.stderr).toContain("review-required");
  expect(existsSync(marker)).toBe(false);
  const status = policyCompatibility(root);
  expect(run("collection", "compatibility", "acknowledge", "--digest", status.digest, "--reviewed").status).toBe(0);
  expect(run("collection", "compatibility", "check").status).toBe(0);
});

test("failed context publication rolls back activation and preserves the editable draft", async () => {
  const fixture_ = await fixture();
  const { base, draft } = fixture_;
  stage(fixture_);
  activate(fixture_);
  const before = registryPins(base);
  const oldContext = readFileSync(join(base, "AGENTS.md"));
  writeFileSync(draft, readFileSync(draft, "utf8").replace("Policy 0.", "Changed policy."));
  const global = join(userDirectory("data"), "AGENTS.md");
  rmSync(global);
  mkdirSync(global);
  expect(() => {
    activate(fixture_);
  }).toThrow();
  expect(registryPins(base)).toEqual(before);
  expect(readFileSync(join(base, "AGENTS.md"))).toEqual(oldContext);
  expect(readFileSync(draft, "utf8")).toContain("Changed policy.");
});

test("snapshot inheritance retains only an exact current review and remains valid after relocation", async () => {
  const fixture_ = await fixture();
  const { root, base, storage } = fixture_;
  stage(fixture_);
  activate(fixture_);
  const snapshot = join(storage, "snapshot");
  cpSync(join(root, "workbench"), join(snapshot, "workbench"), {
    recursive: true,
    filter: (path) => !path.includes(".local-collections"),
  });
  expect(() => {
    provisionCollectionSnapshot(root, snapshot);
  }).toThrow(/reviewed/);
  acknowledge(root);
  provisionCollectionSnapshot(root, snapshot);
  expect(projectPolicyFingerprint(snapshot)).toBe(projectPolicyFingerprint(root));
  vi.stubEnv("WORKBENCH_COLLECTIONS_MATERIALIZED", "1");
  expect(policyCompatibility(snapshot).status).toBe("current");
  const moved = join(storage, "moved");
  cpSync(snapshot, moved, { recursive: true });
  expect(policyCompatibility(moved).status).toBe("current");
  writeFileSync(join(moved, "workbench/CHARTER.md"), "Changed intent.\n");
  expect(policyCompatibility(moved).status).toBe("review-required");
  expect(registryPins(base)).toHaveLength(1);
});

test("preparation snapshots reuse the owner's review only for matching policy contents", async () => {
  const fixture_ = await fixture();
  const { root, storage } = fixture_;
  stage(fixture_);
  activate(fixture_);
  acknowledge(root);
  const receipt = policyCompatibility(root).receipt;
  const before = readFileSync(receipt);
  const snapshot = join(storage, "preparation");
  cpSync(join(root, "workbench"), join(snapshot, "workbench"), {
    recursive: true,
    filter: (path) => !path.includes(".local-collections"),
  });
  vi.stubEnv("WORKBENCH_LOCAL_CONFIG_ROOT", root);
  expect(policyCompatibility(snapshot).status).toBe("review-required");
  vi.stubEnv("WORKBENCH_EPHEMERAL_CHECKOUT", "1");
  expect(policyCompatibility(snapshot).receipt).toBe(receipt);
  expect(() => {
    checkPolicyCompatibility(snapshot);
  }).not.toThrow();
  writeFileSync(join(snapshot, "workbench/CHARTER.md"), "Different project intent.\n");
  expect(() => {
    checkPolicyCompatibility(snapshot);
  }).toThrow(/review-required/);
  expect(readFileSync(receipt)).toEqual(before);
});

test("managed execution inherits reviewed contents without accepting unrelated policy changes", async () => {
  const fixture_ = await fixture();
  const { root, draft } = fixture_;
  stage(fixture_);
  activate(fixture_);
  const user = join(userDirectory("data"), "collections");
  const other = provider(root, "personal", "1", ["Keep private records local."]);
  prepareLocalPolicy(user, other.directory, other.pin.sha256);
  approveLocalPolicy(user, "personal", reviewLocalPolicy(user, "personal").digest, true);
  acknowledge(root);
  const proof = policyExecutionEnvironment(root).WORKBENCH_POLICY_REVIEW;
  rmSync(policyCompatibility(root).receipt);
  expect(policyCompatibility(root).status).toBe("review-required");
  vi.stubEnv("WORKBENCH_POLICY_REVIEW", proof);
  expect(policyCompatibility(root).status).toBe("current");
  prepareLocalRemoval(user, "personal");
  approveLocalPolicy(user, "personal", reviewLocalPolicy(user, "personal").digest, true);
  expect(policyCompatibility(root).status).toBe("review-required");
  vi.stubEnv("WORKBENCH_DISTRIBUTION_MATERIALIZED", "1");
  expect(policyCompatibility(root).status).toBe("current");
  writeFileSync(draft, readFileSync(draft, "utf8").replace("substantial work", "all work"));
  activate(fixture_);
  expect(policyCompatibility(root).status).toBe("review-required");
  writeFileSync(join(root, "workbench/CHARTER.md"), "Changed project intent.\n");
  expect(policyCompatibility(root).status).toBe("review-required");
  vi.stubEnv("WORKBENCH_POLICY_REVIEW", JSON.stringify({ reviewed: true, project: "a", locals: [[1, false]] }));
  expect(() => policyCompatibility(root)).toThrow(/invalid inherited/);
});

test("the public CLI prepares, approves, reviews compatibility, and executes only the reviewed project", async () => {
  const { root, source } = await fixture();
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [join(distribution, "bin/workbench.mjs"), ...args], {
      cwd: root,
      env: process.env,
      encoding: "utf8",
    });
  const marker = join(root, "executed");
  writeFileSync(
    join(root, "workbench/automation.toml"),
    `[[check]]\nname="fixture"\nrole="test"\ncommand=${JSON.stringify(["node", "-e", "require('node:fs').writeFileSync('executed',process.cwd())"])}\n`,
  );
  expect(run("sync").status).toBe(0);
  const installed = run("collection", "install", source.directory, "--scope", "user", "--sha256", source.pin.sha256);
  expect(installed.status, installed.stderr).toBe(0);
  const inspection = run("collection", "local", "review", "machine");
  expect(inspection.status, inspection.stderr).toBe(0);
  const review = JSON.parse(inspection.stdout) as { draft: string; digest: string };
  expect(review.draft).toContain(".drafts");
  expect(run("collection", "local", "approve", "machine", "--digest", review.digest).status).not.toBe(0);
  expect(run("collection", "local", "approve", "machine", "--digest", review.digest, "--human-approved").status).toBe(
    0,
  );
  expect(run("check", "--role", "test").status).not.toBe(0);
  for (const option of ["--list", "--json", "--all"]) {
    const inspection = run("check", option, "--role", "test");
    expect(inspection.status, inspection.stderr).toBe(0);
  }
  expect(existsSync(marker)).toBe(false);
  const current = JSON.parse(run("collection", "compatibility").stdout) as { digest: string };
  expect(run("collection", "compatibility", "acknowledge", "--digest", current.digest, "--reviewed").status).toBe(0);
  const executed = run("check", "--role", "test");
  expect(executed.status, executed.stdout + executed.stderr).toBe(0);
  expect(readFileSync(marker, "utf8")).toBe(root);
  rmSync(marker);
  mkdirSync(join(root, "workbench/decisions"), { recursive: true });
  writeFileSync(
    join(root, "workbench/decisions/ADR-00.md"),
    "---\nsummary: Changed policy.\n---\n\n# ADR-0: Project policy\n\nUse the new policy.\n",
  );
  expect(run("check", "--role", "test").stderr).toContain("review-required");
  expect(existsSync(marker)).toBe(false);
});

test("separate local installations expose differing namespaces without silently selecting a winner", async () => {
  const fixture_ = await fixture();
  const { root } = fixture_;
  stage(fixture_);
  activate(fixture_);
  const incoming = provider(root, "machine", "2", ["Use another scheduler for substantial work."]);
  const user = join(userDirectory("data"), "collections");
  prepareLocalPolicy(user, incoming.directory, incoming.pin.sha256);
  approveLocalPolicy(user, "machine", reviewLocalPolicy(user, "machine").digest, true);
  expect(policyCompatibility(root).status).toBe("conflict");
  expect(() => {
    acknowledge(root);
  }).toThrow(/collisions/);
  expect(() => renderAgentContext(root, true)).toThrow(/conflicting local/);
});

test.skipIf(process.platform !== "linux" || !existsSync("/dev/shm"))(
  "local draft publication supports a different filesystem from disposable merge storage",
  async () => {
    const { source } = await fixture();
    const base = mkdtempSync(join("/dev/shm", "workbench-policy-"));
    temporary.push(base);
    prepareLocalPolicy(base, source.directory, source.pin.sha256);
    expect(readFileSync(join(base, ".drafts/machine/workbench/decisions/ADR-00.md"), "utf8")).toContain(
      "installed scheduler",
    );
    expect(registryPins(base)).toEqual([]);
  },
);
