import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";

test.skipIf(process.platform === "win32")(
  "the Python bootstrap rejects unsafe or unauthenticated activation and cleans staging",
  () => {
    const output = execFileSync(
      "python3",
      ["-B", "tests/fixtures/bootstrap_cases.py", "scripts/ci-linux/bootstrap.py"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(output).toBe("");
  },
);
