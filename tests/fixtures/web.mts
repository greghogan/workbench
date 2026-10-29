import { afterEach, vi } from "vitest";
import { startWebServer } from "../../src/web/server.ts";
import { distribution, git } from "./adoption.mjs";
import { rmSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function webFixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-web-")));
  git(root, "init", "-q");
  mkdirSync(join(root, "workbench/decisions"), { recursive: true });
  writeFileSync(
    join(root, "workbench/config.toml"),
    "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
  );
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="demo"\npath="."\n');
  writeFileSync(join(root, "workbench/CHARTER.md"), "# Charter\n\nHuman intent.\n");
  writeFileSync(
    join(root, "workbench/decisions/ADR-00.md"),
    "---\nsummary: Keep files authoritative.\n---\n\n# ADR-0: Files\n\nKeep files authoritative.\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "Baseline");
  return root;
}
export function hiddenValue(html: string, name: string): string {
  const value = new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
  if (!value) throw new Error(`missing ${name} in page`);
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

/** One lifecycle owns fixture roots and every listener, including listeners replaced within a test. */
export function webServers() {
  const roots: string[] = [],
    servers: Awaited<ReturnType<typeof startWebServer>>[] = [];
  afterEach(async () => {
    try {
      const outcomes = await Promise.allSettled(servers.splice(0).map((server) => server.close()));
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason as unknown] : [],
      );
      if (failures.length) throw new AggregateError(failures, "web fixture cleanup failed");
    } finally {
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });
  return {
    project: () => {
      const root = webFixture();
      roots.push(root);
      return root;
    },
    start: async (root: string, options: Parameters<typeof startWebServer>[1] = {}) => {
      vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
      const server = await startWebServer(root, { port: 0, ...options });
      servers.push(server);
      return server;
    },
  };
}
export async function readWebPage(web: Awaited<ReturnType<typeof startWebServer>>, path: string, fresh = true) {
  if (fresh) await web.monitor.reconcile(true);
  const response = await fetch(web.url + path);
  return { response, html: await response.text() };
}
export function postWebForm(
  web: Awaited<ReturnType<typeof startWebServer>>,
  path: string,
  values: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return fetch(web.url + path, {
    method: "POST",
    body: new URLSearchParams(values),
    headers: { Accept: "application/json", ...headers },
    redirect: "manual",
  });
}
