import { expect, test } from "vitest";
import { prepareGuixBootstrap, validateGuixBootstrap } from "../scripts/ci-guix-bootstrap.mjs";

const channels = ["a".repeat(64)];
const manifest = () => ({
  schema: 1,
  channels,
  sha256: "b".repeat(64),
  profiles: [{ path: `/gnu/store/${"0".repeat(32)}-profile`, aliases: ["a".repeat(52)] }],
});

test("Guix bootstrap caches identify pinned profiles and constrain restored alias paths", () => {
  const value = manifest();
  expect(validateGuixBootstrap(value, channels)).toBe(value);
  for (const bad of [
    { ...value, schema: 2 },
    { ...value, channels: ["different"] },
    { ...value, sha256: "unverified" },
    { ...value, profiles: [] },
    { ...value, profiles: [{ ...value.profiles[0], path: "/tmp/profile" }] },
    { ...value, profiles: [{ ...value.profiles[0], aliases: [] }] },
    { ...value, profiles: [{ ...value.profiles[0], aliases: ["../escape"] }] },
    { ...value, profiles: [{ ...value.profiles[0], aliases: ["a".repeat(52), "a".repeat(52)] }] },
  ])
    expect(() => validateGuixBootstrap(bad, channels)).toThrow(/Guix bootstrap cache/);
});

test("Guix bootstrap signing trust cannot be installed by an ordinary local invocation", async () => {
  const original = process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_ACTIONS;
  try {
    await expect(prepareGuixBootstrap()).rejects.toThrow("isolated Linux Actions runner");
  } finally {
    if (original === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = original;
  }
});
