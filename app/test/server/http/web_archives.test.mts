import { expect, test, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { webServers, readReconciledWebPage } from "../../fixtures/web.mjs";
import { distribution, git } from "../../fixtures/adoption.mjs";
import { enableArchive, transferArchive } from "../../../src/core/records/archive-workflow.ts";
import { readTaskGraph } from "../../../src/core/tasks/task-model.ts";
import { parseDOM } from "../../fixtures/dom.mjs";

const servers = webServers();
test("archived records remain searchable, linked, and downloadable without restoring a working copy", async () => {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const root = servers.project(),
    path = "workbench/tasks/TSK-00.md",
    support = "workbench/tasks/TSK-00/evidence.md";
  git(root, "branch", "-M", "main");
  mkdirSync(join(root, "workbench/tasks/TSK-00"), { recursive: true });
  writeFileSync(join(root, path), "---\nstatus: Accepted\n---\n\n# TSK-0: Earlier delivery\n\nArchive-only needle.\n");
  writeFileSync(join(root, support), "# Preserved evidence\n\n**Formatted** support.\n");
  writeFileSync(
    join(root, "workbench/tasks/TSK-01.md"),
    "---\nstatus: Approved\ndepends_on: [demo:TSK-0]\n---\n\n# TSK-1: Follow-up\n\nBuilds on TSK-0.\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "Delivered prerequisite and future work");
  enableArchive(root, { branch: "records", groupSize: 1 });
  git(root, "add", "workbench/config.toml");
  git(root, "commit", "-qm", "Configure archival");
  transferArchive(root);
  expect(readTaskGraph(root).byReference.has("demo:TSK-0")).toBe(true);
  const web = await servers.start(root);
  const search = await readReconciledWebPage(web, "/records?q=ARCHIVE-ONLY&type=TSK&scope=demo");
  expect(search.response.status).toBe(200);
  expect(search.html).toContain("Earlier delivery");
  const record = await readReconciledWebPage(web, "/records/demo:TSK-0");
  expect(record.response.status).toBe(200);
  expect(record.html).toContain("Archived · read only");
  const document = parseDOM(record.html).window.document;
  expect(document.querySelector('form[action*="task-state"]')).toBeNull();
  expect(record.html).not.toContain("Return to planning");
  const followup = await readReconciledWebPage(web, "/records/demo:TSK-1");
  expect(followup.html).toContain('href="/records/demo:TSK-0"');
  const supportLink = document.querySelector<HTMLAnchorElement>('a.record-row[href*="evidence"]')?.getAttribute("href");
  if (!supportLink) throw new Error("Missing supporting-file navigation");
  const preview = await readReconciledWebPage(web, supportLink);
  expect(preview.response.status).toBe(200);
  expect(preview.html).toContain("<strong>Formatted</strong>");
  const downloadLink = parseDOM(preview.html)
    .window.document.querySelector<HTMLAnchorElement>('a[href*="download=1"]')
    ?.getAttribute("href");
  if (!downloadLink) throw new Error("Missing download action");
  const download = await readReconciledWebPage(web, downloadLink);
  expect(download.response.headers.get("content-disposition")).toContain("attachment");
  expect(download.html).toBe("# Preserved evidence\n\n**Formatted** support.\n");
  expect(existsSync(join(root, path))).toBe(false);
  expect(existsSync(join(root, support))).toBe(false);
});
