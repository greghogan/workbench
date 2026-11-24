import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { InputWatch } from "../../../src/server/workspace/input-watch.ts";
import { distribution, git } from "../../fixtures/adoption.mjs";
import { initRefFormat, linkedCheckout } from "../../fixtures/ref-recovery.mts";
import { readWebPage, webServers } from "../../fixtures/web.mjs";
import { planIdentity } from "../../../src/core/tasks/planning/plan-model.ts";
import { readPlan } from "../../../src/core/tasks/planning/planning-store.ts";
import {
  checkpointPlans,
  configurePlanning,
  savePlanDraft,
} from "../../../src/core/tasks/planning/planning-operations.ts";

test("input reconciliation follows atomic replacements, discovers missing parents and ignores unrelated writes", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-input-watch-"));
  const path = join(root, "new", "receipt.json"),
    changes: string[][] = [];
  const watch = new InputWatch((paths) => {
    changes.push(paths);
  });
  try {
    watch.update([path]);
    writeFileSync(join(root, "unrelated"), "unrelated");
    watch.reconcile();
    expect(changes).toEqual([]);
    mkdirSync(join(root, "new"));
    writeFileSync(path, "first");
    watch.reconcile();
    expect(changes).toEqual([[path]]);
    writeFileSync(join(root, "new", "replacement"), "second");
    renameSync(join(root, "new", "replacement"), path);
    watch.reconcile();
    expect(changes).toEqual([[path], [path]]);
    renameSync(join(root, "new"), join(root, "old"));
    mkdirSync(join(root, "new"));
    writeFileSync(path, "third");
    watch.reconcile();
    expect(changes).toHaveLength(3);
    watch.close();
    writeFileSync(path, "fourth");
    watch.reconcile();
    expect(changes).toHaveLength(3);
  } finally {
    watch.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const servers = webServers();

test.for(["files", "reftable"] as const)(
  "a live linked checkout observes external plan and review ref creation, updates, and removal with %s",
  async (format, context) => {
    const root = servers.project((directory) => {
      initRefFormat(directory, format, context);
    });
    vi.stubEnv("WORKBENCH_STATE_HOME", join(root, ".git/local-state"));
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
    const linked = linkedCheckout(root, "linked");
    configurePlanning(root, { branch: "planning", auto_prune: true });
    const planRef = "refs/heads/planning",
      identity = planIdentity("demo", "external-ref");
    const planContents = (title: string) => `---\nstatus: Planned\n---\n\n# ${title}\n\nDeliver project work.\n`;
    savePlanDraft(root, identity, planContents("First external plan"));
    const firstPlan = checkpointPlans(root);
    savePlanDraft(root, identity, planContents("Revised external plan"), { expected: readPlan(root, identity).digest });
    const lastPlan = checkpointPlans(root);
    if (!firstPlan || !lastPlan) throw new Error("Expected both planning checkpoints");
    git(root, "update-ref", "-d", planRef, lastPlan);

    const base = git(root, "rev-parse", "HEAD"),
      record = "workbench/decisions/ADR-00.md";
    const review = (subject: string) => {
      writeFileSync(
        join(root, record),
        `---\nsummary: Keep files authoritative.\n---\n\n# ADR-0: Files\n\n${subject}.\n`,
      );
      git(root, "add", record);
      git(root, "commit", "-qm", `${subject}\n\nWorkbench-Provisional: true`);
      return git(root, "rev-parse", "HEAD");
    };
    const firstReview = review("First external review"),
      lastReview = review("Revised external review");
    git(root, "update-ref", "refs/heads/main", base, lastReview);
    const reviewRef = "refs/heads/topic",
      web = await servers.start(linked, { pollInterval: 250 });
    const page = async (path: string) => {
      const { response, html } = await readWebPage(web, path, false);
      expect(response.status).toBe(200);
      return html;
    };
    const waitFor = (path: string) => expect.poll(() => page(path), { timeout: 10000, interval: 100 });

    git(root, "update-ref", planRef, firstPlan);
    git(root, "update-ref", reviewRef, firstReview);
    await waitFor("/plans").toContain("First external plan");
    await waitFor("/reviews").toContain("First external review");

    git(linked, "update-ref", planRef, lastPlan, firstPlan);
    git(linked, "update-ref", reviewRef, lastReview, firstReview);
    await waitFor("/plans").toContain("Revised external plan");
    await waitFor("/reviews").toContain("Revised external review");

    git(root, "update-ref", "-d", planRef, lastPlan);
    git(root, "update-ref", "-d", reviewRef, lastReview);
    await waitFor("/plans").not.toContain("Revised external plan");
    await waitFor("/reviews").not.toContain("external review");

    git(linked, "switch", "--quiet", "--detach", lastReview);
    await waitFor("/reviews").toContain("Revised external review");
    git(linked, "switch", "--quiet", "linked");
    await waitFor("/reviews").not.toContain("external review");
  },
);
