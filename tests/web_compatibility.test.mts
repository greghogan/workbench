import { withStagedPolicyReview } from "../src/review-policy.ts";
import { expect, test, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { webServers, readWebPage, postWebForm, hiddenValue } from "./fixtures/web.mjs";
import { provider, distribution, git } from "./fixtures/adoption.mjs";
import { parseDOM } from "./fixtures/dom.mjs";
import { installSelectedCollections } from "../src/collection-install.ts";
import { approveLocalPolicy, reviewLocalPolicy } from "../src/local-policy.ts";
import {
  policyCompatibility,
  acknowledgePolicyCompatibility,
  reportPolicyIncompatibilities,
} from "../src/policy-compatibility.ts";
import {
  readCompatibilityAssessment,
  compatibilityFindingsPath,
  decideCompatibilityFinding,
  CompatibilityDecision,
} from "../src/policy-findings.ts";
import { WorkspaceCollector } from "../src/workspace-service.ts";
import { registerProject } from "../src/project-registry.ts";
import { reviewStatus, ReviewSource } from "../src/review-service.ts";

const fixtures = webServers();
const proposed = {
  summary: "The local rule conflicts with the project's execution choice",
  details: "The project requires direct execution while the local rule requires scheduler admission.",
  records: ["demo:ADR-0", "hostrules:ADR-0"],
  proposed_resolution: "Revise demo:ADR-0 to permit wrapping its commands with the installed scheduler.",
};
function localProject() {
  const root = fixtures.project();
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  for (const kind of ["CONFIG", "DATA", "CACHE", "STATE"])
    vi.stubEnv(`WORKBENCH_${kind}_HOME`, join(root, ".git", kind.toLowerCase()));
  registerProject(root, "demo");
  writeFileSync(
    join(root, "workbench/decisions/ADR-00.md"),
    "---\nsummary: Direct execution requirement.\n---\n\n# ADR-0: Project execution\n\nRun project build commands directly without a scheduler wrapper.\n",
  );
  git(root, "add", "workbench/decisions/ADR-00.md");
  git(root, "commit", "-qm", "Project execution baseline");
  const source = provider(root, "hostrules", "1", ["Use scheduler admission on this host."]);
  installSelectedCollections(root, [{ source: source.directory, sha256: source.pin.sha256 }], { scope: "local" });
  const base = join(root, "workbench/.local-collections");
  approveLocalPolicy(base, "hostrules", reviewLocalPolicy(base, "hostrules").digest, true);
  return root;
}
function report(root: string) {
  const status = policyCompatibility(root);
  reportPolicyIncompatibilities(root, status.digest, [proposed]);
  return policyCompatibility(root);
}

test("a stale compatibility assessment requests agent work without entering the human review queue", async () => {
  const root = localProject(),
    web = await fixtures.start(root);
  expect(policyCompatibility(root).status).toBe("review-required");
  const queue = parseDOM((await readWebPage(web, "/review")).html).window.document;
  expect(queue.querySelector("[data-compatibility-item]")).toBeNull();
  const local = (await readWebPage(web, "/collections")).html;
  expect(local).toContain("An agent compatibility assessment is needed.");
  expect((await readWebPage(web, "/review?compatibility=1&id=demo:ADR-0")).response.status).toBe(400);
});

test("reported incompatibilities join document reviews; approval records a resolution without changing policy", async () => {
  const root = localProject(),
    status = report(root),
    web = await fixtures.start(root);
  const before = readFileSync(join(root, "workbench/decisions/ADR-00.md"), "utf8"),
    index = git(root, "ls-files", "--stage");
  const queue = parseDOM((await readWebPage(web, "/review")).html).window.document;
  const links = [...queue.querySelectorAll("main [data-card-link]")];
  expect(links.map((link) => link.textContent)).toEqual(["Resolve policy incompatibilities"]);
  const page = await readWebPage(web, links[0]?.getAttribute("href") ?? "");
  const document = parseDOM(page.html).window.document;
  expect(document.querySelector("main")?.textContent).toContain(proposed.proposed_resolution);
  expect(document.querySelector('a[href*="/records/hostrules:ADR-0"]')).not.toBeNull();
  const finding = hiddenValue(page.html, "finding");
  const response = await postWebForm(web, "/actions/policy-resolution", {
    csrf: hiddenValue(page.html, "csrf"),
    policy_digest: status.digest,
    finding,
    decision: "approve",
    reviewed: "yes",
  });
  expect(response.status).toBe(200);
  expect(readCompatibilityAssessment(status.receipt)?.findings[0]?.decision?.outcome).toBe("approve");
  expect(policyCompatibility(root).status).toBe("incompatible");
  expect(() => {
    acknowledgePolicyCompatibility(root, status.digest, true);
  }).toThrow(/Implement the approved/);
  expect(readFileSync(join(root, "workbench/decisions/ADR-00.md"), "utf8")).toBe(before);
  expect(git(root, "ls-files", "--stage")).toBe(index);
  expect(existsSync(join(root, ".git/workbench/review.json"))).toBe(false);
  expect((await readWebPage(web, "/review")).html).not.toContain("data-compatibility-item");
  writeFileSync(
    join(root, "workbench/decisions/ADR-00.md"),
    before + "\nCommands may run through the host scheduler.\n",
  );
  const changed = policyCompatibility(root);
  acknowledgePolicyCompatibility(root, changed.digest, true);
  expect(policyCompatibility(root).status).toBe("current");
  expect(readCompatibilityAssessment(status.receipt)).toBeNull();
  expect(JSON.parse(readFileSync(status.receipt, "utf8"))).toMatchObject({
    resolved_assessment: {
      findings: [{ proposed_resolution: proposed.proposed_resolution, decision: { outcome: "approve" } }],
    },
  });
  expect(reviewStatus(root, ReviewSource.Working).changes.some((change) => !change.approved)).toBe(true);
});

test("unreviewed findings block clean acknowledgment and source changes cannot silently replace them", () => {
  const root = localProject(),
    status = report(root);
  expect(() => {
    acknowledgePolicyCompatibility(root, status.digest, true);
  }).toThrow(/human review/);
  writeFileSync(
    join(root, "workbench/decisions/ADR-00.md"),
    "---\nsummary: Changed after report.\n---\n\n# ADR-0: Changed after report\n",
  );
  const changed = policyCompatibility(root);
  expect(() => {
    reportPolicyIncompatibilities(root, changed.digest, [proposed]);
  }).toThrow(/outstanding compatibility/);
  expect(readCompatibilityAssessment(status.receipt)?.policy_digest).toBe(status.digest);
});

test("exact proposal versions reject stale decisions and conflicting repeat submissions", async () => {
  const root = localProject(),
    status = report(root),
    web = await fixtures.start(root);
  const page = await readWebPage(web, "/review?compatibility=1"),
    finding = hiddenValue(page.html, "finding");
  const form = {
    csrf: hiddenValue(page.html, "csrf"),
    policy_digest: status.digest,
    finding,
    decision: "approve",
    reviewed: "yes",
  };
  expect((await postWebForm(web, "/actions/policy-resolution", { ...form, reviewed: "no" })).status).toBe(400);
  expect((await postWebForm(web, "/actions/policy-resolution", form)).status).toBe(200);
  expect((await postWebForm(web, "/actions/policy-resolution", { ...form, decision: "dismiss" })).status).toBe(409);
  writeFileSync(
    join(root, "workbench/decisions/ADR-00.md"),
    "---\nsummary: A new policy version.\n---\n\n# ADR-0: A new policy version\n",
  );
  reportPolicyIncompatibilities(root, policyCompatibility(root).digest, [
    { ...proposed, proposed_resolution: "Revise the newly changed policy." },
  ]);
  expect((await postWebForm(web, "/actions/policy-resolution", form)).status).toBe(409);
  expect(readCompatibilityAssessment(status.receipt)?.findings[0]?.decision).toBeNull();
});

test("a dismissed false positive still requires an agent compatibility assessment", () => {
  const root = localProject(),
    status = report(root),
    finding = status.assessment?.findings[0];
  if (!finding) throw new Error("Missing reported finding");
  decideCompatibilityFinding(status.receipt, status.digest, finding.id, CompatibilityDecision.Dismiss);
  expect(policyCompatibility(root).status).toBe("review-required");
  acknowledgePolicyCompatibility(root, status.digest, true);
  expect(policyCompatibility(root).status).toBe("current");
});

test("metadata-only changes invalidate snapshots, while unreadable assessments leave records browsable", () => {
  const root = localProject(),
    collector = new WorkspaceCollector(root),
    first = collector.collect();
  expect(collector.collect()).toBe(first);
  const status = report(root),
    reported = collector.collect();
  expect(reported.revision).not.toBe(first.revision);
  expect(reported.compatibility.report?.assessment?.findings).toHaveLength(1);
  writeFileSync(compatibilityFindingsPath(status.receipt), "{broken JSON");
  const broken = collector.collect();
  expect(broken.records.some((record) => record.id === "demo:ADR-0")).toBe(true);
  expect(broken.compatibility.report).toBeNull();
  expect(broken.compatibility.error).not.toBe("");
});

test("CLI report and human resolution preserve a durable proposal and require explicit human authority", () => {
  const root = localProject(),
    status = policyCompatibility(root),
    input = join(root, ".git/findings.json");
  writeFileSync(input, JSON.stringify([proposed]));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [join(distribution, "bin/workbench.mjs"), "collection", "compatibility", ...args], {
      cwd: root,
      env: { ...process.env, WORKBENCH_PROJECT_ROOT: root },
      encoding: "utf8",
    });
  const published = run("report", "--digest", status.digest, "--from", input);
  expect(published.status, published.stderr).toBe(0);
  const finding = readCompatibilityAssessment(status.receipt)?.findings[0];
  if (!finding) throw new Error("Missing CLI finding");
  const args = ["resolve", "--digest", status.digest, "--finding", finding.id, "--decision", "approve"];
  expect(run(...args).status).not.toBe(0);
  expect(readCompatibilityAssessment(status.receipt)?.findings[0]?.decision).toBeNull();
  expect(run(...args, "--human-approved").status).toBe(0);
  expect(readCompatibilityAssessment(status.receipt)?.findings[0]?.decision?.outcome).toBe("approve");
});

test("invalid reports preserve existing findings and repeated reports preserve exact human decisions", () => {
  const root = localProject(),
    status = report(root),
    finding = status.assessment?.findings[0];
  if (!finding) throw new Error("Missing finding");
  const path = compatibilityFindingsPath(status.receipt),
    original = readFileSync(path, "utf8");
  for (const [invalid, diagnostic] of [
    [[{ ...proposed, records: ["missing:ADR-0"] }], /unavailable policy/],
    [[{ ...proposed, proposed_resolution: "" }], /proposed_resolution/],
    [[{ ...proposed, decision: { outcome: "approve" } }], /unknown finding fields/],
    [[{ ...proposed, details: "x".repeat(1024 * 1024) }], /assessment/],
  ] as const) {
    expect(() => {
      reportPolicyIncompatibilities(root, status.digest, invalid);
    }).toThrow(diagnostic);
    expect(readFileSync(path, "utf8")).toBe(original);
  }
  decideCompatibilityFinding(status.receipt, status.digest, finding.id, CompatibilityDecision.Approve);
  reportPolicyIncompatibilities(root, status.digest, [proposed, { ...proposed, summary: "Another incompatibility" }]);
  const merged = readCompatibilityAssessment(status.receipt);
  expect(merged?.findings).toHaveLength(2);
  expect(merged?.findings.find((entry) => entry.id === finding.id)?.decision?.outcome).toBe("approve");
  expect(merged?.findings.filter((entry) => !entry.decision)).toHaveLength(1);
});

test("fresh assessments preserve the most recent human resolution after later clean acknowledgments", () => {
  const root = localProject(),
    status = report(root),
    finding = status.assessment?.findings[0];
  if (!finding) throw new Error("Missing finding");
  decideCompatibilityFinding(status.receipt, status.digest, finding.id, CompatibilityDecision.Dismiss);
  acknowledgePolicyCompatibility(root, status.digest, true);
  const resolution = policyCompatibility(root).last_resolution;
  expect(resolution?.findings[0]?.decision?.outcome).toBe("dismiss");
  acknowledgePolicyCompatibility(root, status.digest, true);
  expect(policyCompatibility(root).last_resolution).toEqual(resolution);
});

test("the unified queue advances from a document to compatibility and staged acknowledgments honor findings", async () => {
  const root = localProject(),
    status = report(root),
    web = await fixtures.start(root);
  const path = "workbench/decisions/ADR-00.md";
  writeFileSync(join(root, path), readFileSync(join(root, path), "utf8") + "\nPermit the host scheduler wrapper.\n");
  git(root, "add", path);
  await expect(
    withStagedPolicyReview(root, (review) => {
      review.acknowledge(review.status.digest, true);
    }),
  ).rejects.toThrow(/human review/);
  const page = await readWebPage(web, "/records/demo:ADR-0/review");
  const navigation = parseDOM(page.html).window.document.querySelector(".record-pane");
  expect(navigation?.querySelector('button:disabled[aria-label="Previous review"]') ?? null).not.toBeNull();
  expect(navigation?.querySelector('a[rel="next"]')?.getAttribute("href")).toContain("compatibility=1");
  const response = await postWebForm(web, "/actions/approve", {
    csrf: hiddenValue(page.html, "csrf"),
    path,
    digest: hiddenValue(page.html, "digest"),
    reviewed: "yes",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ redirect: "/review?compatibility=1" });
  const finding = readCompatibilityAssessment(status.receipt)?.findings[0];
  if (!finding) throw new Error("Missing finding");
  decideCompatibilityFinding(status.receipt, status.digest, finding.id, CompatibilityDecision.Approve);
  await withStagedPolicyReview(root, (review) => {
    review.acknowledge(review.status.digest, true);
  });
  expect(policyCompatibility(root).status).toBe("current");
});
