import { expect, test } from "vitest";
import { supersededImages } from "../src/image-retention.ts";
import type { LocalImageEntry, LocalImageReport } from "../src/image-contract.ts";

function entry(reference: string, verified?: string): LocalImageEntry {
  return {
    key: reference,
    checkout: "/project",
    profile: "native",
    reference,
    image: `sha256:${reference}`,
    bytes: 1000,
    lock: "/profile",
    receipt: "/profile",
    identity: reference,
    catalog: `/catalog/${reference}`,
    platform: "linux-x64",
    ...(verified ? { verified } : {}),
  };
}
const first = "2026-10-01T00:00:00Z",
  second = "2026-10-02T00:00:00Z",
  third = "2026-10-03T00:00:00Z";

test("a verified active replacement retires older images while keeping attached images and other consumers' requirements", () => {
  const old = entry("old", first),
    working = { ...entry("current", second), blockedBy: "container", blockedReason: "attached" as const };
  const report: LocalImageReport = { location: "local", entries: [old, working], issues: [] };
  expect(supersededImages(report, "/project", new Set([working.image]), 1)).toEqual([old]);
  expect(supersededImages(report, "/project", new Set([working.image, old.image]), 1)).toEqual([]);
  expect(
    supersededImages(
      { ...report, entries: [{ ...old, blockedBy: "container", blockedReason: "attached" }, working] },
      "/project",
      new Set([working.image]),
      1,
    ),
  ).toEqual([]);
  expect(supersededImages(report, "/project", new Set([working.image]), 0)).toEqual([]);
});

test("unverified or changed replacements cannot retire images; newer failed attempts, separate profiles and platforms remain", () => {
  const old = entry("old", first),
    working = entry("current", second),
    failed = { ...entry("failed"), assembled: third };
  const different = { ...old, reference: "arm", image: "arm", platform: "linux-arm64" };
  const other = { ...old, reference: "other", image: "other", profile: "guix" };
  const report: LocalImageReport = { location: "local", entries: [old, working, failed, different, other], issues: [] };
  expect(supersededImages(report, "/project", new Set(), 1)).toEqual([]);
  expect(supersededImages(report, "/project", new Set([working.image]), 1)).toEqual([old]);
  expect(
    supersededImages(
      { ...report, entries: [old, { ...working, blockedBy: "changed", blockedReason: "changed" }] },
      "/project",
      new Set([working.image]),
      1,
    ),
  ).toEqual([]);
  expect(
    supersededImages({ ...report, issues: ["unknown ownership"] }, "/project", new Set([working.image]), 1),
  ).toEqual([]);
});
