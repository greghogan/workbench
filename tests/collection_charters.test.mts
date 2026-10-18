import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { expect, test, vi } from "vitest";
import { renderAgentContext } from "../src/agents.ts";
import { exportCollection } from "../src/collection-commands.ts";
import { collectionChanges, reconcileCollection } from "../src/collection-reconcile.ts";
import {
  inspectCollection,
  registryPins,
  resolveLocalCollections,
  writeCollectionManifest,
} from "../src/collections.ts";
import { documentationErrors } from "../src/documentation.ts";
import { required } from "../src/invariants.ts";
import { approveLocalPolicy, reviewLocalPolicy } from "../src/local-policy.ts";
import {
  acknowledgePolicyCompatibility,
  policyCompatibility,
  projectPolicyFingerprint,
} from "../src/policy-compatibility.ts";
import { stagedRecordTree } from "../src/staged-records.ts";
import { provider, git } from "./fixtures/adoption.mjs";
import { collectionFixture, adopt, options, working } from "./fixtures/collection-scenarios.mjs";

const { fixture, temporary } = collectionFixture();
const publishedCharter = "# Published purpose\r\n\r\n<!-- Preserve this human note. -->\r\nProvider boundaries.\r\n";

test("exports preserve the selected human-written charter bytes and require an explicit source", async () => {
  const root = await fixture();
  const projectCharter = readFileSync(join(root, "workbench/CHARTER.md"));
  mkdirSync(join(root, "workbench/decisions"), { recursive: true });
  writeFileSync(
    join(root, "workbench/decisions/ADR-00.md"),
    "---\nsummary: Scope.\n---\n\n# ADR-0: Scope\n\nSee [purpose](../CHARTER.md).\n",
  );
  const custom = join(root, "collection-purpose.md");
  writeFileSync(custom, publishedCharter);
  const output = join(root, "export");
  await exportCollection(root, output, "consumer", "1", [], undefined, true, "public", "collection-purpose.md");
  expect(readFileSync(join(output, "workbench/CHARTER.md"))).toEqual(Buffer.from(publishedCharter));
  expect(readFileSync(join(root, "workbench/CHARTER.md"))).toEqual(projectCharter);
  expect(inspectCollection(output).manifest.files["workbench/CHARTER.md"]).toMatch(/^[a-f0-9]{64}$/);
  writeFileSync(join(output, "workbench/CHARTER.md"), "Changed without updating the inventory.\n");
  expect(() => inspectCollection(output)).toThrow(/verification/);
  rmSync(join(root, "workbench/CHARTER.md"));
  await expect(
    exportCollection(root, join(root, "missing"), "consumer", "2", [], undefined, true, "public"),
  ).rejects.toThrow(/human-written collection charter/);
  expect(existsSync(join(root, "missing"))).toBe(false);
  writeFileSync(custom, "# Purpose\n\nSee [provider details](../README.md).\n");
  await expect(
    exportCollection(root, join(root, "external"), "consumer", "2", [], undefined, true, "public", custom),
  ).rejects.toThrow(/collection charter links outside/);
  expect(existsSync(join(root, "external"))).toBe(false);
  writeFileSync(custom, " \n");
  await expect(
    exportCollection(root, join(root, "empty"), "consumer", "2", [], undefined, true, "public", custom),
  ).rejects.toThrow(/human-written collection charter/);
});

test("adopted charters provide discoverable context while only the consumer charter and edited ADRs govern", async () => {
  const root = await fixture();
  const projectCharter = readFileSync(join(root, "workbench/CHARTER.md"));
  const source = provider(root, "company", "1", undefined, "public", {}, publishedCharter);
  adopt(root, source);
  const charter = join(root, "workbench/collections/company/CHARTER.md");
  expect(readFileSync(charter)).toEqual(Buffer.from(publishedCharter));
  const context = renderAgentContext(root);
  expect(context.match(/^### Charter$/gm)).toHaveLength(1);
  expect(context).toContain("Published collection charter (context)");
  expect(context.replace(/\s+/g, " ")).toContain("this published charter supplies no additional authority");
  expect(context).not.toContain("Provider boundaries.");
  expect(context).toContain(projectCharter.toString("utf8").trimEnd());
  const originalPolicy = projectPolicyFingerprint(root);
  writeFileSync(working(root), readFileSync(working(root), "utf8").replaceAll("Policy 0.", "Consumer adaptation."));
  expect(renderAgentContext(root)).toContain("Consumer adaptation.");
  expect(readFileSync(charter)).toEqual(Buffer.from(publishedCharter));
  expect(readFileSync(join(root, "workbench/CHARTER.md"))).toEqual(projectCharter);
  expect(projectPolicyFingerprint(root)).not.toBe(originalPolicy);
  const adaptedPolicy = projectPolicyFingerprint(root);
  writeFileSync(charter, publishedCharter.replace("Provider boundaries.", "Updated context."));
  expect(projectPolicyFingerprint(root)).toBe(adaptedPolicy);
  expect(collectionChanges(root, "company")).toContainEqual({ path: "CHARTER.md", change: "modified" });
  git(root, "add", "workbench");
  expect(stagedRecordTree(root).classify("workbench/collections/company/CHARTER.md")).toEqual({
    charter: true,
    protected: true,
    policy: false,
  });
});

test("charter updates reconcile as human contents and conflicting edits preserve the checkout", async () => {
  const root = await fixture();
  const source = provider(root, "company", "1", undefined, "public", {}, "# Purpose\n\nOriginal purpose.\n");
  adopt(root, source);
  const charter = join(root, "workbench/collections/company/CHARTER.md");
  const incoming = provider(root, "company", "2", undefined, "public", {}, publishedCharter);
  reconcileCollection(root, incoming.directory, options(incoming), "company");
  expect(readFileSync(charter)).toEqual(Buffer.from(publishedCharter));
  writeFileSync(charter, publishedCharter.replace("Provider boundaries.", "Locally reviewed context."));
  const before = readFileSync(charter);
  const next = provider(
    root,
    "company",
    "3",
    undefined,
    "public",
    {},
    publishedCharter.replace("Provider boundaries.", "Upstream replacement."),
  );
  let proposal: string | undefined;
  try {
    reconcileCollection(root, next.directory, options(next), "company");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    expect(error.message).toContain("workbench/CHARTER.md");
    proposal = /Resolve files in (.+)\/resolved, then repeat/.exec(error.message)?.[1];
  }
  temporary.push(required(proposal, "Charter conflict proposal"));
  expect(readFileSync(charter)).toEqual(before);
  expect(readFileSync(join(required(proposal, "Charter conflict proposal"), "resolved/CHARTER.md"), "utf8")).toContain(
    "<<<<<<< project",
  );
});

test("charter-only local activation has a distinct immutable snapshot without changing policy compatibility", async () => {
  const root = await fixture();
  const source = provider(root, "company", "1", undefined, "public", {}, publishedCharter);
  adopt(root, source, "local");
  const base = join(root, "workbench/.local-collections");
  approveLocalPolicy(base, "company", reviewLocalPolicy(base, "company").digest, true);
  const first = required(registryPins(base)[0], "First approved snapshot");
  const status = policyCompatibility(root);
  acknowledgePolicyCompatibility(root, status.digest, true);
  writeFileSync(join(base, ".drafts/company/workbench/CHARTER.md"), "# Published purpose\n\nRevised background.\n");
  const review = reviewLocalPolicy(base, "company");
  expect(review.changes.map((change) => change.path)).toEqual(["workbench/CHARTER.md"]);
  approveLocalPolicy(base, "company", review.digest, true);
  const second = required(registryPins(base)[0], "Second approved snapshot");
  expect(second.revision).not.toBe(first.revision);
  expect(second.sha256).not.toBe(first.sha256);
  expect(readFileSync(join(base, first.id, first.revision, "workbench/CHARTER.md"))).toEqual(
    Buffer.from(publishedCharter),
  );
  expect(policyCompatibility(root).digest).toBe(status.digest);
  expect(policyCompatibility(root).status).toBe("current");
  expect(renderAgentContext(root, true)).not.toContain("Revised background.");
});

test("collection inventories cannot omit the charter or publish an empty charter", async () => {
  const root = await fixture();
  const source = provider(root);
  const manifestPath = join(source.directory, "workbench/collection.toml");
  const manifest = readFileSync(manifestPath, "utf8");
  writeFileSync(manifestPath, manifest.replace(/^"workbench\/CHARTER\.md"[^\n]*\n/m, ""));
  expect(() => inspectCollection(source.directory)).toThrow(/charter is missing from the published inventory/);
  writeFileSync(manifestPath, manifest);
  writeFileSync(join(source.directory, "workbench/CHARTER.md"), "\n");
  expect(() =>
    writeCollectionManifest(source.directory, { id: "company", revision: "2", visibility: "public", decisions: ["0"] }),
  ).toThrow(/human-written collection charter/);
  rmSync(join(source.directory, "workbench/CHARTER.md"));
  expect(() => inspectCollection(source.directory)).toThrow();
});

test("external collection links allow verified charters and supporting files while retaining link checks", async () => {
  const data = mkdtempSync(join(tmpdir(), "workbench-collection-links-"));
  temporary.push(data);
  vi.stubEnv("WORKBENCH_DATA_HOME", data);
  const root = await fixture();
  const source = provider(
    root,
    "company",
    "1",
    ["See [purpose](../CHARTER.md#purpose) and [details](ADR-00/details.md#details)."],
    "public",
    { "details.md": "# Details\n\nSupporting material.\n" },
    "# Purpose\n\nCollection context.\n",
  );
  adopt(root, source, "user");
  const base = join(data, "collections");
  approveLocalPolicy(base, "company", reviewLocalPolicy(base, "company").digest, true);
  const collection = required(resolveLocalCollections(root)[0], "Active local collection");
  const map = join(collection.directory, "workbench/decision-map.md");
  const decision = join(collection.directory, "workbench/decisions/ADR-00.md");
  const charter = join(collection.directory, "workbench/CHARTER.md");
  const readme = join(root, "README.md");
  const charterLink = relative(root, charter).split(sep).join("/");
  writeFileSync(readme, `# Consumer\n\n[Collection purpose](${charterLink}#purpose).\n`);
  expect(documentationErrors(root, [readme, map, decision])).toEqual([]);

  writeFileSync(readme, `# Consumer\n\n[Collection purpose](${charterLink}#missing).\n`);
  expect(documentationErrors(root, [readme])).toEqual([`README.md: missing Markdown anchor '${charterLink}#missing'`]);

  const unlisted = join(collection.directory, "workbench/unlisted.md");
  writeFileSync(unlisted, "# Unlisted\n");
  const unlistedLink = relative(root, unlisted).split(sep).join("/");
  writeFileSync(readme, `# Consumer\n\n[Unlisted](${unlistedLink}).\n`);
  expect(documentationErrors(root, [readme])).toEqual([`README.md: link escapes the project: '${unlistedLink}'`]);
});
