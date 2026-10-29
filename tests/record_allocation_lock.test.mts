import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { reserveRecordNumber } from "../src/record-sequences.ts";
test("record allocation preserves uncertain or live owners and recovers a proven abandoned owner", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-record-lock-")),
    lock = join(root, "workbench/.record-allocation.lock");
  mkdirSync(lock, { recursive: true });
  try {
    expect(() => reserveRecordNumber(root, "TSK")).toThrow("another record allocation");
    expect(existsSync(lock)).toBe(true);
    const owner = {
      version: 1,
      pid: process.pid,
      host: hostname(),
      token: "fixture-owner",
      launching: false,
      children: [],
    };
    writeFileSync(join(lock, "owner.json"), JSON.stringify(owner));
    expect(() => reserveRecordNumber(root, "TSK")).toThrow("another record allocation");
    const previous = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
      encoding: "utf8",
    });
    expect(previous.status).toBe(0);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ ...owner, pid: Number(previous.stdout) }));
    expect(reserveRecordNumber(root, "TSK")).toBe("0");
    expect(existsSync(lock)).toBe(false);
    expect(reserveRecordNumber(root, "TSK")).toBe("1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
