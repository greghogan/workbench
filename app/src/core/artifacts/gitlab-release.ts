import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { record, records } from "../runtime/values.mjs";
import type { ArtifactDestination } from "./artifact-catalog.js";
import { networkResponse, retryNetwork } from "../toolchains/acquisition/network-retry.mts";

export interface ReleaseFile {
  path: string;
  sha256: string;
  bytes: number;
}

/** GitLab stores immutable package bytes and exposes them through release asset links. */
export async function publishGitLabFiles(
  destination: Extract<ArtifactDestination, { kind: "gitlab" }>,
  tag: string,
  revision: string,
  description: string,
  files: readonly ReleaseFile[],
  signal: AbortSignal,
  env = process.env,
) {
  const token = env.GITLAB_TOKEN ?? env.CI_JOB_TOKEN;
  if (!token) throw new Error("GitLab publication needs GITLAB_TOKEN or CI_JOB_TOKEN");
  const header = env.GITLAB_TOKEN ? "PRIVATE-TOKEN" : "JOB-TOKEN";
  const base = `${destination.host}/api/v4/projects/${encodeURIComponent(destination.project)}`;
  const encodedTag = encodeURIComponent(tag);
  const request = async (path: string, method = "GET", body?: BodyInit, contentType?: string) => {
    const headers = new Headers({ [header]: token });
    if (contentType) headers.set("Content-Type", contentType);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(900_000)]);
    const attempt = async () => {
      let response = await networkResponse(base + path, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: deadline,
        redirect: "manual",
      });
      const redirects = method === "GET" ? 3 : 0;
      for (let hop = 0; response.status >= 300 && response.status < 400 && hop < redirects; hop++) {
        const location = response.headers.get("Location");
        await response.body?.cancel();
        if (!location) throw new Error("GitLab download redirect did not identify a destination");
        const url = new URL(location, response.url || base + path);
        if (url.protocol !== "https:" || url.username || url.password)
          throw new Error("Unsafe GitLab download redirect");
        response = await networkResponse(url, {
          ...(url.origin === destination.host ? { headers } : {}),
          signal: deadline,
          redirect: "manual",
        });
      }
      if (response.status === 404 && method === "GET") {
        await response.body?.cancel();
        return undefined;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`GitLab ${method} returned HTTP ${String(response.status)}`);
      }
      return response;
    };
    return method === "GET" ? retryNetwork("Read GitLab release evidence", attempt, { signal: deadline }) : attempt();
  };
  const remoteTag = await request(`/repository/tags/${encodedTag}`);
  if (!remoteTag || record(record(await remoteTag.json(), "Invalid tag").commit, "Missing tag commit").id !== revision)
    throw new Error("The remote GitLab tag must identify the reviewed release commit");
  const existing = await request(`/releases/${encodedTag}`);
  const release = existing ? record(await existing.json(), "Invalid GitLab release") : undefined;
  if (release && release.description !== description)
    throw new Error("Existing GitLab release has a different immutable identity");
  const links = [];
  for (const file of files) {
    const name = basename(file.path);
    const remotePath = `/packages/generic/workbench-artifacts/${encodedTag}/${encodeURIComponent(name)}`;
    const url = base + remotePath;
    let response = await request(remotePath);
    if (!response) {
      if (release) throw new Error(`Published release is missing ${name}; refusing mutation`);
      const result = await request(remotePath, "PUT", await openAsBlob(file.path), "application/octet-stream");
      await result?.body?.cancel();
      response = await request(remotePath);
    }
    const reader = response?.body?.getReader();
    if (!reader) throw new Error(`GitLab did not return the published ${name}`);
    const digest = createHash("sha256");
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > file.bytes) throw new Error(`Published ${name} is larger than its verified source`);
        digest.update(part.value);
      }
    } finally {
      await reader.cancel();
    }
    if (bytes !== file.bytes || digest.digest("hex") !== file.sha256)
      throw new Error(`Published ${name} differs from the verified artifact; preserving existing bytes`);
    links.push({ name, url, link_type: "package", direct_asset_path: "/" + name });
  }
  if (!release) {
    const response = await request(
      "/releases",
      "POST",
      JSON.stringify({
        tag_name: tag,
        name: tag,
        description,
        assets: { links },
      }),
      "application/json",
    );
    await response?.body?.cancel();
  }
  const confirmed = await request(`/releases/${encodedTag}`);
  if (!confirmed) throw new Error("GitLab did not confirm the release");
  const data = record(await confirmed.json(), "Invalid GitLab release");
  const published = records(record(data.assets, "Missing release assets").links, "Missing release links");
  if (
    data.description !== description ||
    links.some(({ name, url }) => !published.some((entry) => entry.name === name && entry.url === url))
  )
    throw new Error("GitLab release links do not match the verified publication");
  return links.map(({ url }) => url);
}
