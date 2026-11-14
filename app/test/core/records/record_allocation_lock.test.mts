import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, renameSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { reserveRecordNumber } from "../../../src/core/records/record-sequences.ts";
import { createExperiment } from "../../../src/core/records/records.ts";
import { requiredExperimentProtocol } from "../../../src/core/records/record-content.ts";
import { scan } from "../../../src/core/records/record-files.ts";
import { parse } from "smol-toml";
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
    expect(parse(readFileSync(join(root, "workbench/state.toml"), "utf8")).next).toEqual({
      ADR: "0",
      TSK: "2",
      EXP: "0",
      ENV: "0",
      CIT: "0",
      REL: "0",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("experiment creation identifies unowned supporting files and preserves them through owner-first recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-experiment-owner-")),
    supporting = join(root, "workbench/experiments/EXP-00"),
    owner = `${supporting}.md`,
    evidence = '{"samples":[1,2,3]}\n';
  mkdirSync(supporting, { recursive: true });
  try {
    writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="fixture"\npath="."\n');
    writeFileSync(
      join(root, "workbench/config.toml"),
      'schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\ndata="delete"\n',
    );
    writeFileSync(join(supporting, "measurements.json"), evidence);
    const protocol = join(root, "draft-protocol.md");
    writeFileSync(
      protocol,
      "---\nstatus: Planned\nenvironment: null\n---\n\n# Draft protocol\n\n" +
        requiredExperimentProtocol.map((heading) => `## ${heading}\n\nDeclared comparison.\n`).join("\n"),
    );
    await expect(createExperiment(root, "Compare candidates", protocol, "fixture")).rejects.toThrow(
      `supporting directory has no owning record '${owner}'. Move prepared files outside record directories`,
    );
    expect(readFileSync(join(supporting, "measurements.json"), "utf8")).toBe(evidence);
    expect(existsSync(owner)).toBe(false);
    expect(existsSync(join(root, "workbench/state.toml"))).toBe(false);
    const prepared = join(root, "prepared-evidence");
    renameSync(supporting, prepared);
    expect(await createExperiment(root, "Compare candidates", protocol, "fixture")).toBe(owner);
    renameSync(prepared, supporting);
    expect(scan(root, "EXP")).toEqual([{ number: "0", path: owner }]);
    expect(readFileSync(join(supporting, "measurements.json"), "utf8")).toBe(evidence);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
