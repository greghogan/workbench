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
test("demo transitions drain other handlers and cannot reopen a stopped service", async () => {
  let start!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => {
      start = resolve;
    }),
    finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
  const life = new HubLifecycle(),
    current = life.admit(),
    other = life.admit();
  const transition = life.transition(current, async () => {
    start();
    await finished;
  });
  expect(() => life.admit()).toThrow("switching");
  other.release();
  await started;
  life.stop();
  const ending = life.finishTransition();
  finish();
  await transition;
  await ending;
  current.release();
  await life.drain();
  expect(() => life.admit()).toThrow("stopping");
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
  id,
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
  const release = await views.remove("a");
  await expect(views.use(project("a"), response())).rejects.toMatchObject({ status: 409 });
  release();
  await views.use(project("a"), response());
  apps.find((app) => app.root.endsWith("/b"))?.close.mockRejectedValueOnce(new Error("Fixture close failed"));
  await expect(views.close()).rejects.toThrow();
  expect(apps.at(-1)?.close).toHaveBeenCalledOnce();
  expect(views.size).toBe(0);
});
