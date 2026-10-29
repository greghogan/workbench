import { expect, test } from "vitest";
import { readAdvisory, formatAdvisory } from "../src/advisory-details.ts";

test("advisory decoding ignores malformed optional entries and formatting selects the exact ecosystem and package", () => {
  expect(() => readAdvisory({ id: "different" }, "TEST")).toThrow("Invalid advisory");
  const data = readAdvisory(
    {
      id: "TEST",
      summary: "impact",
      affected: [
        null,
        {},
        { package: { name: "package", ecosystem: "other" }, ranges: [{ events: [{ fixed: "wrong" }] }] },
        {
          package: { name: "package", ecosystem: "npm" },
          ranges: [
            null,
            { events: [null, { fixed: 9 }] },
            { type: "GIT", events: [{ fixed: "abcdef" }] },
            { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "2.0.0" }, { last_affected: "1.9.0" }] },
          ],
        },
      ],
    },
    "TEST",
  );
  const formatted = formatAdvisory("TEST", data, { name: "package", ecosystem: "npm" }).join("\n");
  expect(formatted).toContain("Fixed release boundaries reported: 2.0.0");
  expect(formatted).toContain("last_affected: 1.9.0");
  expect(formatted).not.toContain("wrong");
  expect(formatted).not.toContain("reported: abcdef");
  expect(formatAdvisory("TEST", data, { name: "another", ecosystem: "npm" }).join("\n")).toContain(
    "No fixed release reported",
  );
});
