import { acquireCommand } from "./network-command.mts";
import { acquisitionReason, AcquisitionReason } from "./network-retry.mts";
import { ciProcessOwner } from "./ci-lifecycle.mjs";
import { UserFacingError } from "./diagnostic-errors.mjs";

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
    const reason = missing
      ? options.profile
        ? `Required published CI image is missing: ${reference}. Prepare, verify, and publish profile '${options.profile}' for the selected architecture. Local foreign execution requires configured binfmt; an explicit native image-preparation workflow is also supported. Routine CI does not rebuild prepared images.`
        : `Required container image is missing: ${reference}. Check the selected repository, tag, or digest.`
      : reasonCode === AcquisitionReason.Unavailable
        ? `The image registry remained unavailable while acquiring ${reference}. Retry when registry connectivity recovers.`
        : `Could not retrieve the required image ${reference}. Check registry access and authentication.`;
    throw new UserFacingError(reason, { cause: error });
  }
}
