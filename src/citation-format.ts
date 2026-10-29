export const citationMetadataLimit = 1024 * 1024;
export const citationDocumentLimit = 256 * 1024 * 1024;
export const citationHtmlLimit = 8 * 1024 * 1024;
export const citationImageLimit = 16 * 1024 * 1024;
export const citationFormats = {
  pdf: { extension: "pdf", type: "application/pdf", originalExtension: "pdf", originalLimit: citationDocumentLimit },
  html: {
    extension: "html.br",
    type: "text/html; charset=utf-8",
    originalExtension: "original.html.br",
    originalLimit: citationHtmlLimit,
  },
} as const;
export type CitationFormat = keyof typeof citationFormats;

export function citationHttps(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("https://") || /\s/.test(value) || !URL.canParse(value))
    return false;
  const url = new URL(value);
  return !url.username && !url.password;
}
