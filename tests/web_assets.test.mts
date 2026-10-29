import { expect, test } from "vitest";
import { webServers, readWebPage } from "./fixtures/web.mjs";
import { parseDOM } from "./fixtures/dom.mjs";
const servers = webServers();
test("versioned page assets are compressed, immutable, and revalidate their exact representation", async () => {
  const web = await servers.start(servers.project());
  const document = parseDOM((await readWebPage(web, "/")).html).window.document;
  for (const path of [
    document.querySelector('link[rel="stylesheet"]')?.getAttribute("href"),
    document.querySelector("script")?.getAttribute("src"),
  ]) {
    expect(path).toMatch(/\/assets\/.+\?v=[a-f0-9]{64}$/);
    const url = new URL(path ?? "", web.url);
    const identity = await fetch(url, { headers: { "accept-encoding": "identity" } });
    const plain = await identity.text();
    expect(identity.headers.get("cache-control")).toContain("immutable");
    for (const encoding of ["br", "gzip"]) {
      const response = await fetch(url, { headers: { "accept-encoding": encoding } });
      expect(response.headers.get("content-encoding")).toBe(encoding);
      expect(response.headers.get("vary")).toBe("Accept-Encoding");
      expect(Number(response.headers.get("content-length"))).toBeLessThan(Buffer.byteLength(plain));
      expect(await response.text()).toBe(plain);
      const conditional = await fetch(url, {
        headers: { "accept-encoding": encoding, "if-none-match": response.headers.get("etag") ?? "" },
      });
      expect(conditional.status).toBe(304);
      expect(await conditional.text()).toBe("");
    }
    const refused = await fetch(url, { headers: { "accept-encoding": "br ;q=0, gzip;q=0, *;q=0" } });
    expect(refused.status).toBe(406);
    await refused.arrayBuffer();
    const preferred = await fetch(url, { headers: { "accept-encoding": "br;q=0.2, gzip;q=0.5, identity;q=0.9" } });
    expect(preferred.headers.get("content-encoding")).toBeNull();
    expect(await preferred.text()).toBe(plain);
    const head = await fetch(url, { method: "HEAD", headers: { "accept-encoding": "identity" } });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(Number(head.headers.get("content-length"))).toBe(Buffer.byteLength(plain));
    const uncached = await fetch(new URL(url.pathname, web.url));
    expect(uncached.headers.get("cache-control")).toBe("no-cache");
    await uncached.arrayBuffer();
    url.searchParams.set("v", "0".repeat(64));
    expect((await fetch(url)).status).toBe(404);
  }
});

import { negotiateEncoding } from "../src/web/content-negotiation.ts";
test("encoding negotiation respects explicit exclusions, wildcards, identity preference, and server tie ordering", () => {
  const available = ["br", "gzip", "identity"] as const;
  for (const [header, expected] of [
    [undefined, "identity"],
    ["", "identity"],
    ["BR ; Q=1, identity;q=0", "br"],
    ["br;q=0, *;q=1", "gzip"],
    ["*;q=0, identity;q=0.5", "identity"],
    ["*;q=0", undefined],
    ["br;q=bogus, gzip;q=0, identity;q=0", undefined],
    ["br;q=0.3, gzip;q=0.8, identity;q=0", "gzip"],
    ["br, gzip", "br"],
  ] as const)
    expect(negotiateEncoding(header, available)).toBe(expected);
});
