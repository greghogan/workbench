import { expect, test } from "vitest";
import { verifiedRegistryReference } from "../scripts/ci-image-transfer.mjs";

test("immutable image handoffs stay in the configured repository without assuming a registry provider", () => {
  for (const repository of [
    "ghcr.io/owner/image",
    "registry.example:5000/team/image",
    "docker.io/owner/image",
    "registry.gitlab.com/group/project/development",
    "quay.io/team/development",
    "harbor.example:8443/team/project/development",
    "123456789012.dkr.ecr.us-east-1.amazonaws.com/project/development",
    "project.azurecr.io/development",
    "us-central1-docker.pkg.dev/project/repository/development",
  ]) {
    const identity = `${repository}@sha256:${"a".repeat(64)}`;
    expect(verifiedRegistryReference(`${repository}:inputs`, identity)).toBe(identity);
    for (const changed of [
      `other.example/image@sha256:${"a".repeat(64)}`,
      `${repository}@latest`,
      `${repository}:mutable`,
    ])
      expect(() => verifiedRegistryReference(`${repository}:inputs`, changed)).toThrow(
        /configured registry repository/,
      );
  }
});
