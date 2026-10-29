import { record, string } from "./values.mjs";
import { verifiedRegistryReference } from "./ci-image-transfer.mjs";
interface CIImageIdentity {
  version: 1;
  profile: string;
  platform: "linux-x64" | "linux-arm64";
  inputs: string;
  reference: string;
  image: string;
}
export type AcquiredCIImage = CIImageIdentity & { published: string };

/** One checked handoff contract is shared by acquisition and every worker. */
export function readAcquiredCIImage(value: unknown): AcquiredCIImage {
  const entry = record(value, "Invalid acquired CI image");
  if (
    entry.version !== 1 ||
    (entry.platform !== "linux-x64" && entry.platform !== "linux-arm64") ||
    Object.keys(entry).some(
      (key) => !["version", "profile", "platform", "inputs", "reference", "image", "published"].includes(key),
    )
  )
    throw new Error("Invalid acquired CI image version, platform, or fields");
  const identity: CIImageIdentity = {
    version: 1,
    platform: entry.platform,
    profile: string(entry.profile, "Missing image profile"),
    inputs: string(entry.inputs, "Missing image inputs"),
    reference: string(entry.reference, "Missing image reference"),
    image: string(entry.image, "Missing image ID"),
  };
  if (
    !identity.profile ||
    !identity.reference ||
    !/^[a-f0-9]{64}$/.test(identity.inputs) ||
    !/^sha256:[a-f0-9]{64}$/.test(identity.image)
  )
    throw new Error("Invalid acquired CI image identity");
  const published =
    entry.published === undefined
      ? undefined
      : verifiedRegistryReference(identity.reference, string(entry.published, "Invalid registry identity"));
  if (published === undefined) throw new Error("Registry acquisition requires an immutable published identity");
  return { ...identity, published };
}
