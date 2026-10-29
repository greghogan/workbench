import { brotliCompressSync, constants } from "node:zlib";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom/worker";
import { fromHtml } from "hast-util-from-html";
import { defaultSchema, sanitize } from "hast-util-sanitize";
import { toHtml } from "hast-util-to-html";
import { citationDocumentLimit, citationHtmlLimit, citationImageLimit, citationHttps } from "./citation-format.js";

export { citationHtmlLimit, citationImageLimit } from "./citation-format.js";

function decodeHtml(bytes: Buffer, charset?: string): string {
  if (bytes.length > citationHtmlLimit) throw new Error("Citation webpage exceeds its supported size");
  const encoding =
    charset ??
    /<meta\b[^>]*charset\s*=\s*["']?([\w.-]+)/i.exec(bytes.subarray(0, 1024).toString("latin1"))?.[1] ??
    "utf-8";
  return new TextDecoder(encoding).decode(bytes);
}

function documentLanguage(document: { documentElement: { getAttribute(name: string): string | null } }): string {
  const value = document.documentElement.getAttribute("lang");
  return value && /^[A-Za-z0-9-]+$/.test(value) ? ` lang="${value}"` : "";
}

/** Full source content remains distinct from article extraction; active content never enters the original view. */
export function originalCitationHtml(bytes: Buffer, url: string, charset?: string): string {
  const document = parseHTML(decodeHtml(bytes, charset)).document;
  for (const element of document.querySelectorAll("a[href],img[src]")) {
    const attribute = element.localName === "img" ? "src" : "href";
    const value = element.getAttribute(attribute) ?? "";
    if (value.startsWith("#")) {
      element.removeAttribute("target");
      continue;
    }
    if (attribute === "src" && value.startsWith("data:image/")) continue;
    if (!URL.canParse(value, url)) {
      element.removeAttribute(attribute);
      continue;
    }
    const resolved = new URL(value, url).href;
    const destination = new URL(resolved);
    const permitted =
      attribute === "src"
        ? citationHttps(resolved)
        : ["http:", "https:", "mailto:", "tel:"].includes(destination.protocol) &&
          !destination.username &&
          !destination.password;
    if (!permitted) {
      element.removeAttribute(attribute);
      continue;
    }
    element.setAttribute(attribute, resolved);
    if (attribute === "href") {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noreferrer noopener");
    } else element.setAttribute("referrerpolicy", "no-referrer");
  }
  const tree = sanitize(fromHtml(document.body.innerHTML, { fragment: true }), {
    ...defaultSchema,
    clobberPrefix: "",
    tagNames: [
      ...(defaultSchema.tagNames ?? []),
      "figure",
      "figcaption",
      "article",
      "section",
      "header",
      "footer",
      "nav",
      "main",
      "aside",
    ],
    strip: [...(defaultSchema.strip ?? []), "script", "style", "iframe", "object", "embed", "form", "noscript"],
    attributes: {
      ...defaultSchema.attributes,
      a: [...(defaultSchema.attributes?.a ?? []), "target", "rel"],
      img: [...(defaultSchema.attributes?.img ?? []), "referrerPolicy"],
    },
    protocols: { ...defaultSchema.protocols, src: ["https", "data"] },
  });
  return `<!doctype html><html${documentLanguage(document)}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Original citation</title><style>body{font:1.1rem/1.6 system-ui,sans-serif;margin:2rem auto;max-width:90ch;padding:0 1rem;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre,table{max-width:100%;overflow:auto}pre{white-space:pre-wrap}</style></head><body>${toHtml(tree)}</body></html>`;
}

function imageType(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return "image/gif";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (bytes.subarray(4, 8).toString() === "ftyp" && /avif|avis/.test(bytes.subarray(8, 32).toString()))
    return "image/avif";
  throw new Error("Citation image is not a supported PNG, JPEG, GIF, WebP, or AVIF file");
}

/** Reader extraction selects content; an independent HTML sanitizer establishes the rendering boundary. */
export async function captureCitationHtml(
  bytes: Buffer,
  url: string,
  fetchImage: (url: string) => Promise<Buffer>,
  charset?: string,
): Promise<Buffer> {
  const document = parseHTML(decodeHtml(bytes, charset)).document;
  Object.defineProperties(document, { documentURI: { value: url }, baseURI: { value: url } });
  const location = new URL(url);
  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href");
    if (!href || anchor.textContent.trim() || !anchor.querySelector("img")) continue;
    const destination = URL.canParse(href, url) ? new URL(href, url) : undefined;
    if (
      destination?.origin === location.origin &&
      (destination.pathname === "/" || location.pathname.startsWith(destination.pathname.replace(/\/$/, "") + "/"))
    )
      anchor.remove();
  }
  const article = new Readability(document, { maxElemsToParse: 100_000 }).parse();
  if (!article?.content?.trim()) throw new Error("No readable article found in citation webpage");
  const tree = sanitize(fromHtml(article.content, { fragment: true }), {
    ...defaultSchema,
    clobberPrefix: "",
    tagNames: [...(defaultSchema.tagNames ?? []), "figure", "figcaption"],
    protocols: { ...defaultSchema.protocols, src: ["https", "data"] },
  });
  const images: { properties: Record<string, unknown>; src: string }[] = [];
  const collect = (node: typeof tree): void => {
    if (node.type === "element" && node.tagName === "img" && typeof node.properties.src === "string")
      images.push({ properties: node.properties, src: node.properties.src });
    if ("children" in node) for (const child of node.children) collect(child);
  };
  collect(tree);
  const retained = new Map<string, string>();
  let imageBytes = 0,
    embeddedBytes = 0;
  for (const image of images) {
    const resolved = new URL(image.src, url).href;
    let embedded = retained.get(resolved);
    if (!embedded) {
      let content: Buffer;
      if (resolved.startsWith("data:")) {
        const data = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,([A-Za-z0-9+/=]+)$/.exec(resolved);
        if (!data?.[1]) throw new Error("Citation contains an unsupported embedded image");
        content = Buffer.from(data[1], "base64");
      } else {
        if (!resolved.startsWith("https://")) throw new Error("Citation image URL must use HTTPS");
        content = await fetchImage(resolved);
      }
      imageBytes += content.length;
      if (content.length > citationImageLimit || imageBytes > citationDocumentLimit)
        throw new Error("Citation images exceed their supported size");
      embedded = `data:${imageType(content)};base64,${content.toString("base64")}`;
      retained.set(resolved, embedded);
    }
    embeddedBytes += Buffer.byteLength(embedded);
    if (embeddedBytes > citationDocumentLimit) throw new Error("Embedded citation images exceed their supported size");
    image.properties.src = embedded;
  }
  const title = toHtml({ type: "text", value: article.title ?? "Citation document" });
  const html = `<!doctype html><html${documentLanguage(document)}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:1.1rem/1.6 system-ui,sans-serif;max-width:75ch;margin:2rem auto;padding:0 1rem;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre,table{overflow:auto;max-width:100%}pre{white-space:pre-wrap}blockquote{margin-inline:1rem;border-inline-start:3px solid #888;padding-inline-start:1rem}table{border-collapse:collapse}td,th{border:1px solid #888;padding:.4rem}figure{margin-inline:0}figcaption{font-size:.9em}</style></head><body><article><h1>${title}</h1>${toHtml(tree)}</article></body></html>`;
  if (Buffer.byteLength(html) > citationDocumentLimit) throw new Error("Extracted citation exceeds its supported size");
  return brotliCompressSync(html, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } });
}
