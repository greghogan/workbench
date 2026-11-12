import { join } from "node:path";
/** Shipped verification resources are located relative to the selected distribution. */
export const verificationCharterPath = (distribution: string): string =>
  join(distribution, "app/resources/verification/CHARTER.md");
