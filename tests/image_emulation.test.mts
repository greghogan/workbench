import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { profileRequiresBinfmt } from "../src/image-emulation.ts";

test("missing, disabled and namespace-unsafe emulators are refused; persistent enabled registrations are accepted", () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-binfmt-"));
  try {
    expect(profileRequiresBinfmt("arm64", directory)).toBe(true);
    writeFileSync(join(directory, "status"), "enabled\n");
    writeFileSync(join(directory, "qemu-aarch64"), "enabled\ninterpreter /usr/bin/qemu-aarch64-static\nflags: O\n");
    expect(profileRequiresBinfmt("arm64", directory)).toBe(true);
    writeFileSync(join(directory, "qemu-aarch64"), "enabled\ninterpreter /usr/bin/qemu-aarch64-static\nflags: OCF\n");
    expect(profileRequiresBinfmt("arm64", directory)).toBe(false);
    expect(profileRequiresBinfmt("x64", directory)).toBe(true);
    writeFileSync(join(directory, "status"), "disabled\n");
    expect(profileRequiresBinfmt("arm64", directory)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
