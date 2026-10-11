import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { verifyRegistryPublication } from "../scripts/ci-publish.mjs";

const temporary = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-publication-"));
  temporary.push(root);
  const path = join(root, "dist/releases/go-nix-docker");
  mkdirSync(path, { recursive: true });
  const archive = Buffer.from("verified archive fixture");
  writeFileSync(join(path, "docker.tar.gz"), archive);
  const receipt = {
    version: 1,
    verified: true,
    emulation: false,
    builder: "nix",
    profile: { name: "go-nix-docker" },
    source: { revision: "1".repeat(40), dirty: false },
    artifacts: [
      {
        path: "docker.tar.gz",
        type: "file",
        size: archive.length,
        sha256: createHash("sha256").update(archive).digest("hex"),
      },
    ],
  };
  const record = join(path, "workbench-release.json");
  writeFileSync(record, JSON.stringify(receipt));
  const env = {
    GITHUB_REPOSITORY: "Fixture/Workbench",
    GITHUB_SHA: "1".repeat(40),
    GITHUB_RUN_ID: "12",
    GITHUB_RUN_ATTEMPT: "1",
    RUNNER_TEMP: root,
  };
  const calls = [];
  const id = "sha256:" + "2".repeat(64);
  const digest = "ghcr.io/fixture/workbench-ci-nix@sha256:" + "3".repeat(64);
  const backend = {
    hasImage: () => false,
    docker: (...args) => {
      calls.push(args);
      if (args[0] === "run") return "3";
      if (args.includes("{{.Id}}")) return id;
      if (args.includes("{{json .RepoDigests}}")) return JSON.stringify([digest]);
      return "";
    },
  };
  return { root, record, receipt, env, calls, id, digest, backend };
}
test("publication checks the verified archive, pushes a unique tag, then pulls and executes the same image by digest", async () => {
  const f = fixture();
  const result = await verifyRegistryPublication(f.root, "nix", f.env, f.backend);
  expect(result).toMatchObject({ published: true, verified: true, deployed: false, digest: f.digest, imageID: f.id });
  expect(f.calls).toContainEqual(["pull", f.digest]);
  expect(f.calls).toContainEqual(["run", "--rm", "--pull=never", "--network=none", f.digest, "a", "banana"]);
  const push = f.calls.findIndex(([operation]) => operation === "push");
  const removal = f.calls.findIndex(([operation, , image]) => operation === "image" && image?.includes(":ci-"));
  const pull = f.calls.findIndex(([operation]) => operation === "pull");
  expect(push).toBeLessThan(removal);
  expect(removal).toBeLessThan(pull);
});
test("unverified or changed publication artifacts fail before Docker or registry effects", async () => {
  const f = fixture();
  f.receipt.verified = false;
  writeFileSync(f.record, JSON.stringify(f.receipt));
  await expect(verifyRegistryPublication(f.root, "nix", f.env, f.backend)).rejects.toThrow(
    /verified native release receipt/,
  );
  expect(f.calls).toEqual([]);
  f.receipt.verified = true;
  f.receipt.artifacts[0].sha256 = "0".repeat(64);
  writeFileSync(f.record, JSON.stringify(f.receipt));
  await expect(verifyRegistryPublication(f.root, "nix", f.env, f.backend)).rejects.toThrow(/differs/);
  expect(f.calls).toEqual([]);
});

test("publication rejects dirty or unknown source state before Docker or registry effects", async () => {
  for (const dirty of [true, null, undefined]) {
    const f = fixture();
    f.receipt.source.dirty = dirty;
    writeFileSync(f.record, JSON.stringify(f.receipt));
    await expect(verifyRegistryPublication(f.root, "nix", f.env, f.backend)).rejects.toThrow(
      /verified native release receipt/,
    );
    expect(f.calls).toEqual([]);
  }
});
