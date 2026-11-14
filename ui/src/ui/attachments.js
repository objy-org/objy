// Render images as images, never as executable HTML/SVG documents.
// Only an explicitly typed PDF with a PDF header reaches the PDF renderer.
export async function previewKind(blob) {
  const type = blob.type.split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf" &&
      await blob.slice(0, 5).text() === "%PDF-") return "pdf";
  return null;
}

export function saveAttachment(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url;
  link.download = String(name).replace(/[\\/<>:"|?*\u0000-\u001f\u007f]/g, "_").slice(0, 180) || "attachment";
  document.body.append(link);
  try { link.click(); } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

export function mountPreview(container, blob, name, kind) {
  container.dataset.kind = kind;
  if (kind === "pdf") {
    let closed = false, dispose;
    import("./pdf-preview.js").then(({ mountPdfPreview }) => {
      if (!closed) dispose = mountPdfPreview(container, blob, name);
    }).catch(() => {
      if (!closed) container.textContent = "PDF preview unavailable. You can still download it.";
    });
    return () => { closed = true; dispose?.(); container.replaceChildren(); };
  }
  const url = URL.createObjectURL(blob);
  if (kind === "image") {
    const image = document.createElement("img");
    image.alt = name;
    image.addEventListener("error", () => {
      const message = document.createElement("p");
      message.textContent = "This image could not be displayed. You can still download it.";
      container.replaceChildren(message);
    }, { once: true });
    image.src = url;
    container.replaceChildren(image);
  }
  return () => {
    container.replaceChildren();
    URL.revokeObjectURL(url);
  };
}
