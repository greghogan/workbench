import { test } from "vitest";
import { managedPreparationFixtures } from "../../fixtures/managed-preparation.mjs";

const { verifySharedStore } = managedPreparationFixtures();

test.skipIf(process.platform !== "linux")("guix projects share cache storage across target architectures", async () => {
  await verifySharedStore("guix");
});
