import { test } from "vitest";
import { propertyTitles, isPropertyID, verifyProperty } from "../scripts/document-properties.mjs";
for (const [id, title] of Object.entries(propertyTitles))
  test(title, () => {
    if (!isPropertyID(id)) throw new Error("Invalid property identifier");
    verifyProperty(id, { numRuns: 100, seed: 20261103 });
  });
