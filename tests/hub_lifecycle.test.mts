import { expect, test, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { HubLifecycle, ProjectViews } from "../src/web/hub-lifecycle.ts";
test("resource-scoped mutations allow unrelated reads while conflicting mutations are rejected", () => {
  const life = new HubLifecycle(),
    first = life.admit(),
    release = life.claim("project:a");
  const browsing = life.admit(),
    other = life.claim("project:b");
  expect(() => life.claim("project:a")).toThrow("resource is being changed");
  expect(life.mutations).toBe(2);
  other();
  release();
  browsing.release();
  first.release();
});
test("shutdown refuses new requests and drains every admitted request", async () => {
  const life = new HubLifecycle(),
    current = life.admit();
  life.stop();
  expect(() => life.admit()).toThrow("stopping");
  let finished = false;
  const draining = life.drain().then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  current.release();
  await draining;
  expect(finished).toBe(true);
});

const apps = vi.hoisted(() => [] as { root: string; close: ReturnType<typeof vi.fn<() => Promise<void>>> }[]);
vi.mock("../src/web/server.ts", () => ({
  startWebServer: (root: string) => {
    const app = {
      root,
      close: vi.fn(() => Promise.resolve()),
      monitor: { watcherCount: 2 },
      activeCollections: () => 0,
    };
    apps.push(app);
    return Promise.resolve(app);
  },
}));
afterEach(() => {
  apps.splice(0);
});
const project = (id: string) => ({
  id: id.padEnd(24, "0"),
  name: id,
  path: `/fixture/${id}`,
  state: "registered" as const,
  updated: "2026-10-28T00:00:00Z",
});
function response() {
  return new EventEmitter() as unknown as ServerResponse;
}
test("project view capacity evicts idle least-recently-used contexts while retaining active streams", async () => {
  const views = new ProjectViews(2),
    a = response(),
    b = response(),
    c = response();
  await views.use(project("a"), a);
  await views.use(project("b"), b);
  b.emit("finish");
  await views.use(project("c"), c);
  expect(apps.find((app) => app.root.endsWith("/b"))?.close).toHaveBeenCalledOnce();
  expect(apps.find((app) => app.root.endsWith("/a"))?.close).not.toHaveBeenCalled();
  await expect(views.use(project("d"), response())).rejects.toMatchObject({ status: 503 });
  a.emit("close");
  await views.use(project("d"), response());
  expect(apps.find((app) => app.root.endsWith("/a"))?.close).toHaveBeenCalledOnce();
  expect(await views.watchers()).toBe(4);
  await views.close();
});
test("view cleanup attempts every close after a failure and a removal blocks new leases until released", async () => {
  const views = new ProjectViews(3),
    a = response(),
    b = response();
  await views.use(project("a"), a);
  await views.use(project("b"), b);
  const release = await views.remove(project("a").id);
  await expect(views.use(project("a"), response())).rejects.toMatchObject({ status: 409 });
  release();
  await views.use(project("a"), response());
  apps.find((app) => app.root.endsWith("/b"))?.close.mockRejectedValueOnce(new Error("Fixture close failed"));
  await expect(views.close()).rejects.toThrow();
  expect(apps.at(-1)?.close).toHaveBeenCalledOnce();
  expect(views.size).toBe(0);
});

test("relocation and removal serialize one project while other projects remain responsive and disconnected waiters release capacity", async () => {
  const views = new ProjectViews(2),
    first = response();
  await views.use(project("a"), first);
  first.emit("finish");
  let finish!: () => void;
  const old = apps[0];
  if (!old) throw new Error("Missing first application");
  old.close.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const disconnected = response();
  const moving = views.use({ ...project("a"), path: "/fixture/moved" }, disconnected);
  const canceled = expect(moving).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => {
    expect(old.close).toHaveBeenCalledOnce();
  });
  disconnected.emit("close");
  await canceled;
  const unrelated = response();
  await views.use(project("b"), unrelated);
  expect(apps.some((app) => app.root === "/fixture/b")).toBe(true);
  const removing = views.remove(project("a").id);
  await expect(views.use(project("a"), response())).rejects.toMatchObject({ status: 409 });
  finish();
  const release = await removing;
  release();
  unrelated.emit("finish");
  await views.use({ ...project("a"), path: "/fixture/moved" }, response());
  expect(apps.filter((app) => app.root === "/fixture/moved")).toHaveLength(1);
  expect(old.close).toHaveBeenCalledOnce();
  await views.close();
});

test("a response disconnected before admission consumes no project view", async () => {
  const views = new ProjectViews(1),
    closed = response();
  const pending = views.use(project("a"), closed);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  closed.emit("close");
  await rejected;
  await views.use(project("b"), response());
  expect(views.size).toBe(1);
  expect(apps.map((app) => app.root)).toEqual(["/fixture/b"]);
  await views.close();
});

test("cancelled navigation cannot accumulate unbounded pending retirements", async () => {
  const views = new ProjectViews(1),
    first = response();
  await views.use(project("a"), first);
  first.emit("finish");
  const original = apps[0];
  if (!original) throw new Error("Missing first view");
  let finish!: () => void;
  original.close.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const next = response(),
    starting = views.use(project("b"), next);
  const cancelled = expect(starting).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => {
    expect(original.close).toHaveBeenCalledOnce();
  });
  next.emit("close");
  await cancelled;
  await expect(views.use(project("c"), response())).rejects.toMatchObject({ status: 503 });
  finish();
  const unblock = await views.remove(project("b").id);
  unblock();
  await views.use(project("c"), response());
  expect(views.size).toBe(1);
  expect(apps.at(-1)?.root).toBe("/fixture/c");
  await views.close();
});
