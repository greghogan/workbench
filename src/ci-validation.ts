import { parse } from "yaml";
import { ciDestination } from "./ci-destinations.js";
import { CIProvider } from "./ci-hosting.js";
import { RegistryProvider } from "./registry-management-contract.js";
import { registryRequest } from "./registry-api.js";
import { renderCIWorkflow, renderCIPipeline } from "./ci-workflows.js";
import { record, strings } from "../scripts/values.mjs";
import { processCancellation } from "../scripts/owned-child.mjs";

/** Explicit server-side schema validation does not create pipelines or execute any jobs. */
export async function validateHostedCI(root: string, remote: string, live = false, signal?: AbortSignal) {
  const destination = ciDestination(root, remote);
  const documents = [
    { name: "workflow", content: renderCIWorkflow(root, destination) },
    { name: "pipeline", content: renderCIPipeline(root, destination) },
  ];
  for (const document of documents) {
    if (destination.provider === CIProvider.GitHub && document.name === "pipeline") JSON.parse(document.content);
    else parse(document.content);
  }
  if (!live)
    return {
      provider: destination.provider,
      scope: "local" as const,
      valid: true,
      documents: documents.map((document) => document.name),
    };
  if (destination.provider !== CIProvider.GitLab)
    throw new Error(
      "Live CI schema validation requires a GitLab destination; validate GitHub workflows with actionlint",
    );
  const repository = new URL(destination.repository);
  const management = {
    provider: RegistryProvider.GitLab,
    host: repository.host,
    project: repository.pathname.slice(1),
  } as const;
  const owner = signal ? undefined : processCancellation();
  const active = signal ?? owner?.signal;
  if (!active) throw new Error("CI validation requires an operation owner");
  try {
    const results = [];
    for (const document of documents) {
      const response = record(
        await registryRequest(management, `projects/${encodeURIComponent(management.project)}/ci/lint`, {
          method: "POST",
          input: { content: document.content, dry_run: false, include_jobs: true },
          signal: active,
        }),
        "Invalid GitLab CI validation response",
      );
      const errors = strings(response.errors ?? [], "Invalid GitLab CI validation errors");
      const warnings = strings(response.warnings ?? [], "Invalid GitLab CI validation warnings");
      if (response.valid !== true || errors.length)
        throw new Error(
          `GitLab rejected the ${document.name}: ${errors.join("; ").slice(0, 16000) || "validation was not successful"}`,
        );
      results.push({ name: document.name, warnings });
    }
    return { provider: destination.provider, scope: "server" as const, valid: true, documents: results };
  } finally {
    owner?.close();
  }
}
