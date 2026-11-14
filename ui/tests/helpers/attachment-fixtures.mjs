// Small, self-contained files for the disposable HTTP/browser test servers.
export const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
export const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">
  <rect width="800" height="450" fill="#292929"/>
  <circle cx="400" cy="175" r="65" fill="none" stroke="#ccc" stroke-width="18"/>
  <text x="400" y="310" text-anchor="middle" font-family="sans-serif" font-size="32" fill="#eee">OBJY attachment preview</text>
  <script>parent.document.documentElement.dataset.svgExecuted = 'true'</script>
</svg>`;

const content = "BT /F1 24 Tf 50 720 Td (OBJY attachment preview) Tj ET";
const second = "BT /F1 24 Tf 50 720 Td (Second page) Tj ET";
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>",
  `<< /Length ${second.length} >>\nstream\n${second}\nendstream`,
];
let pdf = "%PDF-1.4\n", offsets = [0];
for (let i = 0; i < objects.length; i++) {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
}
const xref = pdf.length;
pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
export { pdf };

export async function seedPreviews(adapter, database, collection) {
  await adapter.createCollection(database, collection);
  for (const [id, name, bytes, type] of [
    ["png", "pixel.png", png, "image/png"],
    ["svg", "preview.svg", svg, "image/svg+xml"],
    ["pdf", "preview.pdf", pdf, "application/pdf"],
    ["html", "pretend-image.jpg", "<script>parent.document.documentElement.dataset.htmlExecuted='true'</script>", "text/html"],
    ["broken", "broken.png", "not an image", "image/png"],
    ["brokenpdf", "broken.pdf", "%PDF-1.4\nnot a document", "application/pdf"],
  ]) await adapter.insertFile(database, collection, { _id: id, name }, new File([bytes], name, { type }));
}
