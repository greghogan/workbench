import { acquireCommand } from "./network-command.mts";
import { acquisitionReason, AcquisitionReason } from "./network-retry.mts";
import { ciProcessOwner } from "./ci-lifecycle.mjs";
import { UserFacingError } from "./diagnostic-errors.mjs";
import { formatDiagnosticSections } from "./diagnostic-text.mjs";

/** Registry acquisition shares process ownership, quiet protocol output, and failure distinctions. */
export async function acquireRegistryImage(
  reference: string,
  options: { platform?: string; profile?: string; quiet?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  const owner = ciProcessOwner();
  try {
    await acquireCommand(
      "Acquire registry image",
      "docker",
      ["pull", ...(options.platform ? ["--platform", options.platform] : []), reference],
      {
        quiet: options.quiet ?? true,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(owner ? { owner } : {}),
      },
    );
  } catch (error) {
    options.signal?.throwIfAborted();
    const reasonCode = acquisitionReason(error);
    const missing = reasonCode === AcquisitionReason.Missing;
    const summary = missing
      ? options.profile
        ? "Required CI image is not published."
        : "Required container image is not published."
      : reasonCode === AcquisitionReason.Unavailable
        ? "The image registry is unavailable."
        : "Could not retrieve the required image.";
    const next = missing
      ? options.profile
        ? "Prepare and publish this profile for its target. See workbench development publish --help for architecture and destination options."
        : "Check the selected repository, tag, or digest."
      : reasonCode === AcquisitionReason.Unavailable
        ? "Check registry connectivity, then retry."
        : "Check registry access and authentication, then retry.";
    throw new UserFacingError(
      formatDiagnosticSections({
        summary,
        ...(options.profile
          ? {
              groups: [
                { heading: "Profile", items: [options.profile + (options.platform ? ` (${options.platform})` : "")] },
              ],
            }
          : {}),
        next,
      }),
      { cause: new Error(`Image: ${reference}`, { cause: error }) },
    );
  }
}
