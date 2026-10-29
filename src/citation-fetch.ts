import { citationHttps } from "./citation-format.js";
/** Redirects retain the caller's cancellation and one request-chain deadline. */
export async function fetchCitationHttps(
  url: string,
  signal: AbortSignal,
  headers?: Record<string, string>,
): Promise<Response> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(300_000)]);
  let current = url;
  for (let redirect = 0; redirect < 8; redirect++) {
    if (!citationHttps(current)) throw new Error("download URL must use HTTPS without credentials");
    const response = await fetch(current, { ...(headers ? { headers } : {}), redirect: "manual", signal: deadline });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error(`HTTP ${String(response.status)} without Location`);
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${String(response.status)} from ${current}`);
    }
    return response;
  }
  throw new Error("too many HTTPS redirects");
}
