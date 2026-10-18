import { expect, test } from "vitest";
import { imageRepository, imageReference } from "../src/container-references.ts";

test.each([
  "ghcr.io/owner/project",
  "registry.gitlab.com/team/project/image",
  "registry.example.com:5000/team/project",
  "localhost:5000/project",
  "localhost/project",
  "registry:5000/project",
  "docker.io/library/project",
])("accepts an explicit OCI repository: %s", (repository) => {
  expect(imageRepository(repository)).toBe(true);
  expect(imageReference(`${repository}:linux-x64-a1b2`)).toBe(true);
  expect(imageReference(repository)).toBe(false);
  expect(imageRepository(`${repository}:latest`)).toBe(false);
});

test.each([
  "project",
  "owner/project",
  "https://ghcr.io/owner/project",
  "ghcr.io/owner/project@sha256:abc",
  "ghcr.io/owner/../project",
  "ghcr.io//project",
  "ghcr.io/Owner/project",
  "ghcr.io/owner/project\n",
  "-registry.example.com/project",
  "registry..example.com/project",
  "registry.example.com:/project",
])("rejects ambiguous or malformed repositories: %s", (repository) => {
  expect(imageRepository(repository)).toBe(false);
  expect(imageReference(`${repository}:test`)).toBe(false);
});

test.each(["", "bad tag", "-leading", ".leading", "x".repeat(129)])("rejects invalid tags: %s", (tag) => {
  expect(imageReference(`ghcr.io/owner/project:${tag}`)).toBe(false);
});
