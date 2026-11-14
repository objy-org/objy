import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";

const assets = new URL("./pdf/", import.meta.url).href;
GlobalWorkerOptions.workerSrc = `${assets}pdf.worker.js`;

// Render one page at a time. No PDF scripting, embedded links, or remote viewer.
export function mountPdfPreview(container, blob, name) {
  container.innerHTML = '<div class="pdf-page"><canvas role="img" hidden></canvas><p role="status">Loading PDF…</p></div><div class="pdf-navigation"><button type="button" class="secondary-btn" aria-label="Previous page" disabled>←</button><span aria-live="polite"></span><button type="button" class="secondary-btn" aria-label="Next page" disabled>→</button></div>';
  const surface = container.querySelector(".pdf-page"), canvas = container.querySelector("canvas");
  const message = container.querySelector("p"), count = container.querySelector("span");
  const [previous, next] = container.querySelectorAll("button");
  let closed = false, loading, document, rendering, pageNumber = 1, revision = 0;

  function fail(error) {
    canvas.hidden = true;
    message.hidden = false;
    message.textContent = error.name === "PasswordException"
      ? "This PDF requires a password. Download it to open it in your PDF reader."
      : "This PDF could not be displayed. You can still download it.";
  }

  async function render() {
    if (!document || closed) return;
    const current = ++revision, pending = rendering;
    pending?.cancel();
    previous.disabled = pageNumber <= 1;
    next.disabled = pageNumber >= document.numPages;
    count.textContent = `${pageNumber} / ${document.numPages}`;
    canvas.hidden = true;
    delete canvas.dataset.rendered;
    message.hidden = false;
    message.textContent = "Loading page…";
    try {
      await pending?.promise.catch(() => {});
      if (closed || current !== revision) return;
      const page = await document.getPage(pageNumber);
      if (closed || current !== revision) return;
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min((surface.clientWidth - 32) / base.width, (surface.clientHeight - 32) / base.height);
      const viewport = page.getViewport({ scale: Math.max(0.1, scale) });
      // Bound the canvas allocation on large displays without changing its CSS size.
      const density = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / (viewport.width * viewport.height)));
      canvas.width = Math.ceil(viewport.width * density);
      canvas.height = Math.ceil(viewport.height * density);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.setAttribute("aria-label", `${name}, page ${pageNumber} of ${document.numPages}`);
      rendering = page.render({ canvas, viewport, transform: [density, 0, 0, density, 0, 0] });
      await rendering.promise;
      if (closed || current !== revision) return;
      message.hidden = true;
      canvas.hidden = false;
      canvas.dataset.rendered = String(pageNumber);
      page.cleanup();
    } catch (error) {
      if (!closed && current === revision && error.name !== "RenderingCancelledException") fail(error);
    }
  }

  previous.addEventListener("click", () => { pageNumber--; void render(); });
  next.addEventListener("click", () => { pageNumber++; void render(); });
  const observer = new ResizeObserver(() => { void render(); });
  observer.observe(surface);
  void (async () => {
    try {
      const data = new Uint8Array(await blob.arrayBuffer());
      if (closed) return;
      loading = getDocument({ data, cMapUrl: `${assets}cmaps/`, cMapPacked: true,
        standardFontDataUrl: `${assets}standard_fonts/`, wasmUrl: `${assets}wasm/`, iccUrl: `${assets}iccs/` });
      document = await loading.promise;
      if (!closed) await render();
    } catch (error) { if (!closed) fail(error); }
  })();

  return () => {
    closed = true;
    revision++;
    observer.disconnect();
    rendering?.cancel();
    void loading?.destroy().catch(() => {});
    canvas.width = canvas.height = 0;
    container.replaceChildren();
  };
}
