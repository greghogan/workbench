/** A complete, offline one-page PDF for HTTP and native browser viewer checks. */
export function citationPdf(): Buffer {
  const text = "BT /F1 24 Tf 72 720 Td (Retained citation source) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${String(Buffer.byteLength(text))} >>\nstream\n${text}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.7\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  const entries = ["0000000000 65535 f ", ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)];
  pdf += `xref\n0 6\n${entries.join("\n")}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(pdf);
}

export const citationImage = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0xkAAAAASUVORK5CYII=",
  "base64",
);

/** Semantic article content shared by acquisition and browser checks, independent of public websites. */
export function citationHtml(): string {
  return `<!doctype html><html lang="en"><head><title>Retained citation source</title></head><body>
  <p><a href="/"><img src="/brand.svg" alt="Publisher"></a></p>
  <nav>Unrelated site navigation</nav><div><h1>Retained citation source</h1>
  <p>A retained source keeps its <em>emphasis</em>, <strong>important findings</strong>, and supporting evidence available.
  Readers should be able to understand a document without depending on the publisher's navigation or page scripts.
  This article describes an approach to preserving the content of a citation while keeping the resulting document
  useful offline. The extracted article retains the structure that conveys meaning, including headings, paragraphs,
  quotations, tables, lists, code examples, and explanatory figures. It provides enough context to evaluate the evidence.</p>
  <h2>Evidence</h2><ul><li>First observation</li><li>Second observation</li></ul>
  <blockquote>Preserve the surrounding context.</blockquote><pre><code>const result = 1 &lt; 2;</code></pre>
  <table><thead><tr><th>Measure</th><th>Value</th></tr></thead><tbody><tr><td>Count</td><td>2</td></tr></tbody></table>
  <figure><img src="./figure.png" alt="A retained figure" onerror="alert(1)"><figcaption>Figure caption</figcaption></figure>
  <p><a href="./details">Further evidence</a> supports the interpretation. Keep these details together so that a reader
  can inspect the claims and understand their limitations even when the original website is unavailable.</p>
  <a href="javascript:alert(1)" onclick="alert(2)">Unsafe destination</a>
  <script>window.unwantedScript = true;</script><iframe src="https://example.invalid/active"></iframe>
  </div><footer>Unrelated site footer</footer></body></html>`;
}
