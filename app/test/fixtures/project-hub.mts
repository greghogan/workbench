import { afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { webFixture } from "./web.mjs";
import { startProjectHub } from "../../src/server/projects/project-hub.ts";
import { registerConsumingProject } from "../../src/core/projects/project-registration.ts";
import { configureDiagnostics } from "../../src/core/diagnostics/diagnostics.mjs";

export const distribution = resolve(import.meta.dirname, "../../..");

export function projectHubFixtures() {
  const roots: string[] = [];
  const servers: Awaited<ReturnType<typeof startProjectHub>>[] = [];
  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), "workbench-project-browser-"));
    roots.push(home);
    for (const kind of ["CONFIG", "CACHE", "DATA", "STATE"])
      vi.stubEnv(`WORKBENCH_${kind}_HOME`, join(home, kind.toLowerCase()));
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    configureDiagnostics();
  });
  async function start(demo = false) {
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
    const server = await startProjectHub(distribution, { port: 0, demo });
    servers.push(server);
    return server;
  }
  async function project() {
    const root = webFixture();
    roots.push(root);
    await registerConsumingProject(root);
    return root;
  }
  function signInHeader(server: (typeof servers)[number]): string {
    return `Basic ${Buffer.from(`${server.signIn.username}:${server.signIn.password}`).toString("base64")}`;
  }
  function browse(url: string | URL, options: RequestInit = {}) {
    const origin = new URL(url).origin;
    const server = servers.findLast((candidate) => new URL(candidate.url).origin === origin);
    if (!server) throw new Error("Missing registered fixture listener for browser navigation");
    const headers = new Headers(options.headers);
    headers.set("authorization", signInHeader(server));
    return fetch(url, { ...options, headers });
  }
  function post(url: string, values: Record<string, string>) {
    return browse(url, { method: "POST", body: new URLSearchParams(values), redirect: "manual" });
  }
  return { start, project, signInHeader, browse, post, roots, servers };
}
