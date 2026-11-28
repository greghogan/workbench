import { beforeEach, expect, test, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { startWebServer } from "../../../src/server/http/server.ts";
import { webServers, readReconciledWebPage, postWebForm, hiddenValue, readWebPage } from "../../fixtures/web.mjs";

const servers = webServers();
let root: string;
let web: Awaited<ReturnType<typeof startWebServer>>;
beforeEach(async () => {
  root = servers.project();
  web = await servers.start(root, { port: 0, pollInterval: 50 });
});
async function get(path: string) {
  return readReconciledWebPage(web, path);
}
function post(path: string, values: Record<string, string>, headers: Record<string, string> = {}) {
  return postWebForm(web, path, values, headers);
}

test("live events detect external saves and new records, and close cleanly with the service", async () => {
  const controller = new AbortController();
  const response = await fetch(web.url + "/events", { signal: controller.signal });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing events");
  const initial = await reader.read();
  expect(Buffer.from(initial.value ?? []).toString()).toContain("event: revision");
  const changed = once(web.monitor, "change", { signal: AbortSignal.timeout(5000) });
  writeFileSync(join(root, "workbench/decisions/ADR-00.md"), "# External save\n");
  await changed;
  let received = "";
  while (!received.includes(web.monitor.revision)) {
    const next = await reader.read();
    if (next.done) throw new Error("live stream ended before the revision event");
    received += Buffer.from(next.value).toString();
  }
  expect(received).toContain(`event: revision\ndata: ${web.monitor.revision}`);
  const discovered = once(web.monitor, "change", { signal: AbortSignal.timeout(5000) });
  mkdirSync(join(root, "workbench/tasks"));
  writeFileSync(join(root, "workbench/tasks/TSK-00.md"), "# New task\n");
  await discovered;
  expect((await get("/records?type=TSK")).html).toContain("New task");
  controller.abort();
  await reader.cancel().catch(() => undefined);
  await web.close();
  await web.close();
});

test("collection requests remain responsive and require the exact prepared proposal", async () => {
  await web.close();
  const request = {
    source: "/local/provider",
    commit: "a".repeat(40),
    collection: ".",
    visibility: "private" as const,
  };
  const plan = {
    differences: {},
    digest: "b".repeat(64),
    pin: { id: "company", revision: "1", sha256: "c".repeat(64), scopes: ["."], visibility: "private" as const },
    files: [
      {
        path: "workbench/collections/company/decisions/ADR-00.md",
        before: null,
        after: "# Provider",
        before_sha256: null,
        after_sha256: "d".repeat(64),
      },
    ],
  };
  const runner = vi.fn().mockResolvedValueOnce(plan).mockResolvedValueOnce({ id: "company", issues: [], omitted: 0 });
  web = await servers.start(root, { port: 0, collectionRunner: runner });
  const page = await get("/collections"),
    csrf = hiddenValue(page.html, "csrf");
  const preview = await post("/actions/collection-preview", { csrf, ...request });
  const result = (await preview.json()) as { redirect: string };
  expect(preview.status).toBe(200);
  const proposal = await get(result.redirect);
  expect(proposal.html).toContain("# Provider");
  const token = hiddenValue(proposal.html, "token");
  expect((await post("/actions/collection-apply", { csrf, token })).status).toBe(400);
  const applied = await post("/actions/collection-apply", { csrf, token, reviewed: "yes" });
  expect(applied.status).toBe(200);
  const landing = (await applied.json()) as { redirect: string };
  expect(landing.redirect).toBe("/reviews?collection_applied=company");
  expect((await get(landing.redirect)).html).toContain("Project context synchronized and validation passed.");
  expect(runner.mock.calls[1]?.[3]).toBe(plan.digest);
  expect((await get(result.redirect)).response.status).toBe(409);
});

test("collection work keeps browsing responsive, rejects competing mutations, and drains on shutdown", async () => {
  await web.close();
  const entered = Promise.withResolvers<undefined>(),
    finish = Promise.withResolvers<undefined>();
  const runner = vi.fn(() => {
    entered.resolve(undefined);
    return finish.promise;
  });
  web = await servers.start(root, { port: 0, collectionRunner: runner });
  const page = await get("/collections"),
    csrf = hiddenValue(page.html, "csrf");
  const values = { csrf, source: "/fixture", commit: "a".repeat(40), visibility: "public", collection: "." };
  const editor = await get("/records/demo:ADR-0?view=edit");
  const original = readFileSync(join(root, "workbench/decisions/ADR-00.md"), "utf8");
  const pending = post("/actions/collection-preview", values);
  try {
    await entered.promise;
    expect((await get("/")).response.status).toBe(200);
    expect(
      (
        await post("/actions/save", {
          csrf,
          id: "demo:ADR-0",
          expected: hiddenValue(editor.html, "expected"),
          contents: "# ADR-0: Concurrent edit\n",
        })
      ).status,
    ).toBe(409);
    expect(readFileSync(join(root, "workbench/decisions/ADR-00.md"), "utf8")).toBe(original);
    expect((await post("/actions/collection-preview", values)).status).toBe(409);
    let closed = false;
    const closing = web.close().then(() => {
      closed = true;
    });
    expect(closed).toBe(false);
    finish.resolve(undefined);
    expect((await pending).status).toBe(500);
    await closing;
    expect(closed).toBe(true);
  } finally {
    finish.resolve(undefined);
    await pending;
    await web.close();
  }
});

test("a request whose body finishes during shutdown cannot admit a new mutation", async () => {
  const editor = await get("/records/demo:ADR-0?view=edit");
  const body = new URLSearchParams({
    csrf: hiddenValue(editor.html, "csrf"),
    expected: hiddenValue(editor.html, "expected"),
    id: "demo:ADR-0",
    contents: "Late draft",
  }).toString();
  const incoming = once(web.server, "request");
  const response = new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      web.url + "/actions/save",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("error", reject);
    request.flushHeaders();
    void incoming
      .then(() => {
        const closing = web.close();
        request.end(body);
        return closing;
      })
      .catch(reject);
  });
  expect(await response).toBe(503);
  expect(readFileSync(join(root, "workbench/decisions/ADR-00.md"), "utf8")).toContain("Keep files authoritative");
});

test("browsing uses the last complete snapshot while acquisition is pending", async () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- The captured method is called with its original receiver below.
  const post = Worker.prototype.postMessage;
  let release: () => void = () => {
    throw new Error("missing worker request");
  };
  const paused = vi.spyOn(Worker.prototype, "postMessage").mockImplementationOnce(function (
    this: Worker,
    value: unknown,
  ) {
    release = () => {
      post.call(this, value);
    };
  });
  const pending = web.monitor.reconcile(true);
  try {
    const path = join(root, "workbench/decisions/ADR-00.md");
    writeFileSync(path, readFileSync(path, "utf8") + "\nChanged while background refresh is waiting.\n");
    const response = await fetch(web.url + "/records/demo:ADR-0", { signal: AbortSignal.timeout(5000) });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Keep files authoritative");
    expect(html).not.toContain("Changed while background refresh is waiting");
    expect(html).not.toContain("Files checked at");
    expect(web.monitor.refreshing).toBe(true);
  } finally {
    paused.mockRestore();
    release();
    await pending;
  }
  expect((await readWebPage(web, "/records/demo:ADR-0")).html).toContain("Changed while background refresh is waiting");
});

test("a failed refresh retains readable data and reports its cause until recovery", async () => {
  const path = join(root, "workbench/config.toml"),
    config = readFileSync(path, "utf8");
  writeFileSync(path, "invalid TOML [");
  await expect(web.monitor.reconcile(true)).rejects.toThrow();
  const retained = await readWebPage(web, "/records/demo:ADR-0");
  expect(retained.response.status).toBe(200);
  expect(retained.html).toContain("Refresh failed:");
  expect(retained.html).toContain("Keep files authoritative");
  writeFileSync(path, config);
  await web.monitor.reconcile(true);
  expect(web.monitor.problem).toBe("");
  expect((await readWebPage(web, "/")).response.status).toBe(200);
});

test("shutdown discards an in-flight refresh without publishing changes or reopening watchers", async () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- The captured method is called with its original receiver below.
  const post = Worker.prototype.postMessage;
  let release: () => void = () => {
    throw new Error("missing held refresh");
  };
  const paused = vi.spyOn(Worker.prototype, "postMessage").mockImplementationOnce(function (
    this: Worker,
    value: unknown,
  ) {
    release = () => {
      post.call(this, value);
    };
  });
  const pending = web.monitor.reconcile(true),
    changed = vi.fn();
  web.monitor.on("change", changed);
  writeFileSync(join(root, "workbench/decisions/ADR-00.md"), "# Changed during shutdown\n");
  const closing = web.close();
  paused.mockRestore();
  release();
  await Promise.all([pending, closing]);
  expect(changed).not.toHaveBeenCalled();
});

test("explicit workspace retry follows the browser form response contract and requires the session token", async () => {
  const home = await get("/");
  const denied = await post("/actions/workspace-retry", { csrf: "another-session" });
  expect(denied.status).toBe(403);
  const response = await post("/actions/workspace-retry", { csrf: hiddenValue(home.html, "csrf") });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ redirect: "/" });
  expect((await fetch(web.url + "/actions/workspace-retry")).status).toBe(405);
});
