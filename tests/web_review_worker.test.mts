import { expect, test } from "vitest";
import { WebActions } from "../src/web/actions.ts";
import { Route } from "../src/web/routes.ts";
import { presentedReviewDigest } from "../src/review-service.ts";

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

test("admitted approvals remain owned through disconnect-style caller abandonment and shutdown", async () => {
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const actions = new WebActions("unused", undefined, () => pending);
  const form = presented(actions);
  const operation = actions.run(Route.Approve, form);
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
});

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
  await expect(actions.run(Route.Approve, form)).resolves.toMatchObject({ redirect: Route.Review });
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
