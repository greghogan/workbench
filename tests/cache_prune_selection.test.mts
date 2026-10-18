import { required } from "../src/invariants.ts";
import { expect, test } from "vitest";
import { join, resolve } from "node:path";
import { cachePruneSelection, cachePruneSummary } from "../src/cache-prune-selection.ts";
import { chooseItems } from "../src/terminal-choice.ts";
import { terminal } from "./fixtures/terminal.mjs";
import { imageEntry, builderEntry } from "./fixtures/cache.mjs";
import type { CacheEntry, CacheReport } from "../src/build-cache.ts";
import { groupCacheReport } from "../src/build-cache.ts";
import { initialChoice } from "../src/choice-tree.ts";

function entry(root: string, kind: CacheEntry["kind"], bytes: number, target?: string): CacheEntry {
  return {
    kind,
    bytes,
    directory: join(resolve("cache"), root, kind),
    identity: {
      checkout: resolve("project"),
      root,
      environment: "native",
      fingerprint: "a".repeat(24),
      ...(target ? { localCI: { target, image: "fixture-image" } } : {}),
    },
  };
}

test("menu selection, returned entries, and confirmation use the same root and target groups", () => {
  const root = entry(".", "builds", 1000),
    child = entry("child", "builds", 2000),
    logs = entry("child", "logs", 3000);
  const target = entry("child", "checks", 4000, "node-minimum");
  const report = {
    storageRoot: resolve("cache"),
    checkout: root.identity.checkout,
    entries: [root, child, logs, target],
  };
  const model = cachePruneSelection(report, report, groupCacheReport(report));
  const all = initialChoice(model.items, model.initial);
  expect(model.report([...all.selected]).entries).toEqual(report.entries);
  const parent = model.items[0];
  const childName = required(
    required(parent, "Expected fixture value: parent").children.find((item) => item.label === "child"),
    'Expected fixture value: parent.children.find((item) => item.label === "child")',
  ).name;
  expect(model.report([childName]).entries).toEqual([child, logs]);
  expect(model.confirmation([childName])).toBe("Delete 2 cache directories (5.0 kB)?");
  const reason = required(parent, "Expected fixture value: parent").reason;
  if (typeof reason !== "function") throw new Error("Expected computed parent reason");
  expect(reason(new Set([childName]))).toBe("5.0 kB selected / 10.0 kB available");
  const targetName = required(
    required(parent, "Expected fixture value: parent").children.find((item) => item.label.includes("node-minimum")),
    'Expected fixture value: parent.children.find((item) => item.label.includes("node-minimum"))',
  ).name;
  expect(model.report([targetName]).entries).toEqual([target]);
  expect(report.entries).toEqual([root, child, logs, target]);
});

test("unavailable project roots stay visible without entering the deletion report", () => {
  const available = entry("available", "builds", 1000),
    busy = entry("busy", "builds", 2000);
  const report = { storageRoot: resolve("cache"), checkout: available.identity.checkout, entries: [available, busy] };
  const candidates = { ...report, entries: [available] };
  const model = cachePruneSelection(report, candidates, groupCacheReport(report));
  const busyRow = required(model.items[0], "Expected fixture value: model.items[0]").children.find(
    (item) => item.label === "busy",
  );
  expect(required(busyRow, "Expected fixture value: busyRow").disabled(new Set())).toBe(true);
  expect(model.report([required(busyRow, "Expected fixture value: busyRow").name]).entries).toEqual([]);
  expect(model.confirmation([required(busyRow, "Expected fixture value: busyRow").name])).toBe(
    "Delete 0 cache directories (0 B)?",
  );
});

test.each(["local", "registry"] as const)(
  "%s image selection excludes active images and counts only selected deletion units",
  (location) => {
    const image = imageEntry({
      key: "image-one",
      checkout: resolve("project"),
      profile: "guix",
      reference: "ghcr.io/owner/project:linux-x64-digest",
      image: "sha256:abc",
      bytes: 1000,
    });
    const busy = { ...image, key: "image-two", blockedBy: "referenced by a Docker container" };
    const report: CacheReport = {
      storageRoot: resolve("cache"),
      checkout: null,
      entries: [],
      images: { location, entries: [image, busy], issues: [] },
    };
    const candidates = { ...report, images: { ...required(report.images, "Image report"), entries: [image] } };
    const model = cachePruneSelection(report, candidates, groupCacheReport(report));
    expect(model.initial).toEqual([]);
    const parent = model.items.find((item) => item.name === "Images");
    if (location === "local") {
      expect(required(parent, "Expected fixture value: parent").section).toBe("Local Docker image tags");
      expect(required(parent, "Expected fixture value: parent").reason).toBe("1.0 kB image sizes; 1/2 removable tags");
    }
    expect(
      required(
        required(parent, "Expected fixture value: parent").children[1],
        "Expected fixture value: parent.children[1]",
      ).disabled(new Set()),
    ).toBe(true);
    expect(
      required(
        model.report(["image:image-one", "image:image-two"]).images,
        'Expected fixture value: model.report(["image:image-one", "image:image-two"]).images',
      ).entries,
    ).toEqual([image]);
    expect(required(model.report([]).images, "Expected fixture value: model.report([]).images").entries).toEqual([]);
    expect(model.confirmation(["image:image-one"])).toBe(
      location === "registry"
        ? "Delete 1 GHCR image version from the registry? Other developers may still need these images."
        : "Delete 1 cache item?\n1 image tag (reclaimed space unknown)",
    );
  },
);

test("mixed cleanup never adds repeated image sizes to filesystem or builder estimates", () => {
  const report: CacheReport = {
    storageRoot: resolve("cache"),
    checkout: null,
    entries: [entry(".", "builds", 7200000000)],
    images: {
      location: "local",
      entries: [imageEntry({ bytes: 71800000000 }), imageEntry({ bytes: 71800000000 })],
      issues: [],
    },
    builders: { entries: [builderEntry({ bytes: 2000000000 })], issues: [] },
  };
  expect(cachePruneSummary(report)).toEqual({
    description: "4 cache items",
    details: ["7.2 GB filesystem estimate", "2.0 GB builder volume estimate", "2 image tags (reclaimed space unknown)"],
  });
});

test.each(["images", "builders"])("empty %s previews name the requested Docker resources", (checkout) => {
  expect(cachePruneSummary({ entries: [], checkout, storageRoot: resolve("cache") }).description).toBe(
    checkout === "images" ? "0 local image tags" : "0 builder stores",
  );
});

test("terminal confirmation shows separate size categories on distinct lines before accepting deletion", async () => {
  const { input, output, text } = terminal(80, 16);
  const details = [
    "7.2 GB filesystem estimate",
    "2.0 GB builder volume estimate",
    "2 image tags (reclaimed space unknown)",
  ];
  const pending = chooseItems("Select caches", [{ name: "owned" }], ["owned"], input, output, () =>
    ["Delete 4 cache items?", ...details].join("\n"),
  );
  try {
    input.emit("keypress", "", { name: "return" });
    for (const detail of details) expect(text()).toContain(detail + "\n");
    expect(text().indexOf("Y deletes")).toBeGreaterThan(
      text().indexOf(required(details[2], "Fixture value details[2]")),
    );
    input.emit("keypress", "y", { name: "y" });
    expect(await pending).toEqual(["owned"]);
  } finally {
    input.emit("end");
    await pending;
    input.destroy();
    output.destroy();
  }
});
