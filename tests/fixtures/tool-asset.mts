import { createHash } from "node:crypto";
import type { ToolAsset } from "../../src/tool-downloads.ts";

/** Planning and mocked installation fixtures own their metadata; no live release catalog or network is consulted. */
export function fixtureToolAsset(name: string, version: string, platform = "linux-x64"): ToolAsset {
  const url = `https://tools.example.test/${name}/${version}/${platform}.tar.gz`;
  return {
    url,
    sha256: createHash("sha256").update(url).digest("hex"),
    format: "tar",
    strip: 1,
    bin: "bin",
    authenticationUnavailable: {
      reason: "Synthetic local test artifact; never acquired or executed",
      source: url,
      checked: "2026-01-01",
    },
  };
}
