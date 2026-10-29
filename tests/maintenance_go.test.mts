import { afterEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverMaintenance, developmentDiscovery } from "../scripts/maintenance/plan.mjs";
import { applyMaintenance } from "../scripts/maintenance/apply.mjs";
import { MaintenanceSources } from "../scripts/maintenance/sources.mjs";
import { MaintenanceState } from "../scripts/maintenance/contract.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(current: string, responses: Record<string, unknown>, name = "example.test/lib") {
  const root = mkdtempSync(join(tmpdir(), "workbench-go-discovery-"));
  roots.push(root);
  mkdirSync(join(root, "workbench"));
  writeFileSync(join(root, "workbench/projects.toml"), '[[language_root]]\npath="."\nlanguage="go"\n');
  writeFileSync(join(root, "workbench/config.toml"), "schema_version=1\n");
  writeFileSync(join(root, "go.mod"), `module example.test/app\ngo 1.26.8\nrequire ${name} ${current}\n`);
  const base = `https://proxy.golang.org/${name.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`)}`;
  const sources = new MaintenanceSources((url) => {
    const key = url.slice(base.length);
    if (!url.startsWith(base) || !Object.hasOwn(responses, key))
      return Promise.reject(new Error(`Unexpected metadata request: ${url}`));
    const response = responses[key];
    return Promise.resolve(typeof response === "string" ? response : JSON.stringify(response));
  });
  const discover = developmentDiscovery(sources, root);
  return { root, discover, sources, plan: () => discoverMaintenance(root, discover) };
}
const older = "v0.0.0-20261014143641-f0251eb4aa3e";
const newer = "v0.0.0-20261104143641-abcdef123456";

test("untagged Go modules discover newer pseudo-versions and retain their exact pin when applied", async () => {
  const f = fixture(older, { "/@v/list": "", "/@latest": { Version: newer } });
  const plan = await f.plan();
  expect(plan.entries[0]).toMatchObject({ state: MaintenanceState.Available, selected: { version: newer.slice(1) } });
  await applyMaintenance(f.root, plan, { discover: f.discover, sources: f.sources, run: () => Promise.resolve("") });
  expect(readFileSync(join(f.root, "go.mod"), "utf8")).toContain(`example.test/lib ${newer}`);
});

test.each([older, "v1.2.4-0.20261014143641-f0251eb4aa3e", "v1.2.3-beta.0.20261014143641-f0251eb4aa3e"])(
  "unchanged pseudo-version %s is current",
  async (current) => {
    const f = fixture(current, { "/@v/list": "", "/@latest": { Version: current } });
    expect((await f.plan()).entries[0]?.state).toBe(MaintenanceState.Current);
  },
);

test("a stable release takes precedence over its preceding pseudo-version", async () => {
  const f = fixture("v1.2.4-0.20261014143641-f0251eb4aa3e", { "/@v/list": "v1.2.3\nv1.2.4\n" });
  expect((await f.plan()).entries[0]).toMatchObject({
    state: MaintenanceState.Available,
    selected: { version: "1.2.4" },
  });
});

test("an older upstream latest never downgrades an existing pseudo-version", async () => {
  const current = "v1.2.4-0.20261014143641-f0251eb4aa3e";
  const f = fixture(current, {
    "/@v/list": "v1.2.3\n",
    "/@latest": { Version: "v1.2.3" },
    [`/@v/${current}.info`]: { Version: current },
  });
  expect((await f.plan()).entries[0]).toMatchObject({
    state: MaintenanceState.Current,
    selected: { version: current.slice(1) },
  });
});

test("ordinary release candidates do not replace the pinned pseudo-version", async () => {
  const f = fixture(older, {
    "/@v/list": "v0.1.0-rc.1\n",
    "/@latest": { Version: "v0.1.0-rc.1" },
    [`/@v/${older}.info`]: { Version: older },
  });
  expect((await f.plan()).entries[0]?.state).toBe(MaintenanceState.Current);
});

test.each([{}, { Version: "bad" }, { Version: " v1.2.3" }, { Version: 123 }])(
  "malformed Go metadata is unavailable: %j",
  async (latest) => {
    const f = fixture(older, { "/@v/list": "", "/@latest": latest });
    const entry = (await f.plan()).entries[0];
    expect(entry?.state).toBe(MaintenanceState.Unavailable);
    expect(entry?.reason).toMatch(/Go module version/);
  },
);

test("pinned metadata must identify the exact retained revision", async () => {
  const f = fixture(newer, {
    "/@v/list": "",
    "/@latest": { Version: older },
    [`/@v/${newer}.info`]: { Version: older },
  });
  const entry = (await f.plan()).entries[0];
  expect(entry?.state).toBe(MaintenanceState.Unavailable);
  expect(entry?.reason).toContain("does not match");
});

test("Go proxy module paths retain uppercase escaping", async () => {
  const f = fixture("v1.0.0", { "/@v/list": "v1.0.0\n" }, "example.test/Upper/Case");
  expect((await f.plan()).entries[0]?.state).toBe(MaintenanceState.Current);
});

test("generic discovery uses semantic Go ordering for mixed candidates", async () => {
  const f = fixture(older, {});
  const plan = await discoverMaintenance(f.root, () =>
    Promise.resolve([
      { version: older.slice(1), reference: "https://example.test/pseudo" },
      { version: "0.0.0", reference: "https://example.test/release" },
    ]),
  );
  expect(plan.entries[0]).toMatchObject({ state: MaintenanceState.Available, selected: { version: "0.0.0" } });
});
