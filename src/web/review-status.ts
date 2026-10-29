/** The browser needs version identities, never newly rendered or implicitly presented document contents. */
export function decodeReviewVersions(input: unknown): Map<string, string> {
  if (!input || typeof input !== "object" || !("versions" in input) || !Array.isArray(input.versions))
    throw new Error("Invalid review status response");
  const versions = new Map<string, string>();
  for (const value of input.versions as unknown[]) {
    if (
      !value ||
      typeof value !== "object" ||
      !("path" in value) ||
      typeof value.path !== "string" ||
      !("digest" in value) ||
      typeof value.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.digest) ||
      versions.has(value.path)
    )
      throw new Error("Invalid review status version");
    versions.set(value.path, value.digest);
  }
  return versions;
}

export function decodeCompatibilityVersions(input: unknown): { policy_digest: string | null; findings: Set<string> } {
  if (
    !input ||
    typeof input !== "object" ||
    !("policy_digest" in input) ||
    !("findings" in input) ||
    (input.policy_digest !== null &&
      (typeof input.policy_digest !== "string" || !/^[a-f0-9]{64}$/.test(input.policy_digest))) ||
    !Array.isArray(input.findings) ||
    input.findings.length > 256 ||
    input.findings.some((id: unknown) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
  )
    throw new Error("Invalid compatibility review status");
  const findings = new Set(input.findings as string[]);
  if (findings.size !== input.findings.length) throw new Error("Repeated compatibility finding");
  return { policy_digest: input.policy_digest, findings };
}
