import { expect, test } from "vitest";
import { WebActions } from "../../../src/server/projects/actions.ts";
import { Route } from "../../../src/server/routes/routes.ts";
import { presentedReviewDigest } from "../../../src/core/review/review-service.ts";
import { createHash } from "node:crypto";
import { WebAction } from "../../../src/core/diagnostics/diagnostics.mjs";
import { decodeReviewRequest } from "../../../src/server/review/review-protocol.ts";

function presented(actions: WebActions): URLSearchParams {
  const change = {
    path: "workbench/decisions/ADR-00.md",
    before: "000000:" + "0".repeat(40),
    after: "100644:" + "a".repeat(40),
    charter: false,
  };
  actions.reviews.retain(change, { before: null, after: Buffer.from("exact").toString("base64"), error: "" }, "");
  return new URLSearchParams({ path: change.path, digest: presentedReviewDigest(change, ""), reviewed: "yes" });
}

test("worker operations validate their own inputs and reject mixed preparation and acknowledgment requests", () => {
  const contents = Buffer.from("retained file");
  const change = {
    path: "workbench/decisions/ADR-00.md",
    before: "000000:" + "0".repeat(40),
    after:
      "100644:" +
      createHash("sha1")
        .update(`blob ${String(contents.length)}\0`)
        .update(contents)
        .digest("hex"),
    charter: false,
  };
  const version = { head: "", change, contents: contents.toString("base64") };
  const acknowledgment = {
    root: "/project",
    operation: WebAction.Review,
    version,
    digest: presentedReviewDigest(change, ""),
    humanWritten: false,
  };
  const preparation = { root: "/project", operation: WebAction.ReviewPrepare, path: change.path };
  expect(decodeReviewRequest(preparation)).toEqual(preparation);
  expect(decodeReviewRequest(acknowledgment)).toEqual(acknowledgment);
  for (const invalid of [
    { ...preparation, version },
    { ...acknowledgment, path: change.path },
    { ...preparation, operation: "unknown" },
    { ...preparation, path: "" },
    { ...acknowledgment, version: { ...version, contents: Buffer.from("different").toString("base64") } },
  ])
    expect(() => decodeReviewRequest(invalid)).toThrow(/Invalid|invalid/);
});

test.each([Route.Approve, Route.ReviewPrepare])(
  "admitted review operation %s remains owned through caller abandonment and shutdown",
  async (route) => {
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const actions = new WebActions("unused", undefined, () => pending);
    const form = presented(actions);
    const operation = actions.run(
      route,
      form,
      route === Route.ReviewPrepare ? { path: form.get("path") ?? "", layout: "unified" } : undefined,
    );
    expect(actions.activeOperations).toBe(1);
    expect(actions.activeCollections).toBe(0);
    await expect(actions.run(Route.Approve, form)).rejects.toThrow("in progress");
    let closed = false;
    const closing = actions.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(actions.run(Route.Approve, form)).rejects.toThrow("stopping");
    complete();
    await operation;
    await closing;
    expect(closed).toBe(true);
    expect(actions.activeOperations).toBe(0);
  },
);

test("a failed approval releases admission and does not conceal its cause", async () => {
  let fail = true;
  const actions = new WebActions("unused", undefined, () => {
    if (fail) return Promise.reject(new Error("Receipt publication failed"));
    return Promise.resolve();
  });
  const form = presented(actions);
  await expect(actions.run(Route.Approve, form)).rejects.toThrow("Receipt publication failed");
  expect(actions.activeOperations).toBe(0);
  fail = false;
  await expect(actions.run(Route.Approve, form)).resolves.toMatchObject({ redirect: Route.Reviews });
  await actions.close();
});

test("collection metrics distinguish collection work from approvals and clear after failure", async () => {
  let complete!: () => void;
  const pending = new Promise<undefined>((resolve) => {
    complete = () => {
      resolve(undefined);
    };
  });
  const actions = new WebActions("unused", () => pending);
  const operation = actions.run(
    Route.Preview,
    new URLSearchParams({
      source: "https://example.invalid/policies.git",
      commit: "a".repeat(40),
      collection: ".",
      visibility: "public",
    }),
  );
  expect(actions.activeOperations).toBe(1);
  expect(actions.activeCollections).toBe(1);
  complete();
  await expect(operation).rejects.toThrow("collection preview was not produced");
  expect(actions.activeOperations).toBe(0);
  expect(actions.activeCollections).toBe(0);
  await actions.close();
});
