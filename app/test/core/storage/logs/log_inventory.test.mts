import { expect, test, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogInventory, compareRetentionRuns } from "../../../../src/core/storage/logs/log-inventory.ts";

test("external inventory sorting retains all units beyond the former directory cutoff and cleans its scratch", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-log-inventory-"));
  vi.stubEnv("WORKBENCH_CACHE_HOME", root);
  const inventory = new LogInventory(32768);
  try {
    const records = Array.from({ length: 20005 }, (_, index) => ({
      directory: `/logs/unit-${String(index)}`,
      completed: (index * 7919) % 20011,
      bytes: index % 100,
      eligible: index % 3 !== 0,
    }));
    for (const record of records) await inventory.add(record);
    const sorted = [];
    for await (const record of inventory.sorted()) sorted.push(record);
    expect(sorted).toEqual([...records].sort(compareRetentionRuns));
    expect(inventory.totalBytes).toBe(records.reduce((sum, record) => sum + record.bytes, 0));
    expect(inventory.newest).toEqual(sorted.filter((record) => record.eligible).at(-1));
    inventory.close();
    expect(readdirSync(join(root, "log-inventory"))).toEqual([]);
  } finally {
    inventory.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unreadable inventory parts reject the sweep and release all sorting resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-log-inventory-"));
  vi.stubEnv("WORKBENCH_CACHE_HOME", root);
  const inventory = new LogInventory(1);
  try {
    for (let index = 0; index < 2; index++)
      await inventory.add({ directory: `/logs/${String(index)}`, completed: index, bytes: 1, eligible: true });
    const parent = join(root, "log-inventory");
    const directory = join(parent, readdirSync(parent)[0] ?? "missing");
    const part = readdirSync(directory).find((name) => name.endsWith(".jsonl"));
    rmSync(join(directory, part ?? "missing"));
    const sorting = async () => {
      const rows = [];
      for await (const row of inventory.sorted()) rows.push(row);
      return rows;
    };
    await expect(sorting()).rejects.toMatchObject({ code: "ENOENT" });
    inventory.close();
    expect(readdirSync(parent)).toEqual([]);
  } finally {
    inventory.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
