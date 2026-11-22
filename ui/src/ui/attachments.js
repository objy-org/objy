// Only passive document types may use a same-origin Blob URL. HTML/SVG/XML
// can execute scripts with the UI's origin even when window.opener is null.
export function browserViewable(type) {
  return /^(?:application\/(?:pdf|json)|text\/(?:plain|csv)|image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|vnd.microsoft.icon)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/.test(type.split(";")[0].trim().toLowerCase());
}

function saveAttachment(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url;
  link.download = String(name).replace(/[\\/<>:"|?*\u0000-\u001f\u007f]/g, "_").slice(0, 180) || "attachment";
  document.body.append(link);
  try { link.click(); } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

export async function openAttachment(load, name) {
  // Reserve the tab during the click, before the authenticated download awaits.
  const tab = window.open("about:blank", "_blank");
  if (!tab) throw new Error("Allow pop-ups for this site to open attachments.");
  tab.opener = null;
  tab.document.title = name;
  tab.document.body.textContent = "Loading attachment…";
  const controller = new AbortController();
  let url;
  const release = () => {
    clearInterval(closed);
    controller.abort();
    if (url) URL.revokeObjectURL(url);
  };
  // Keep the URL available for the browser's save/reload controls until close.
  const closed = setInterval(() => { if (tab.closed) release(); }, 1000);
  try {
    const blob = await load(controller.signal);
    if (tab.closed) { release(); return; }
    if (!browserViewable(blob.type)) {
      saveAttachment(blob, name);
      tab.close();
      release();
      return;
    }
    url = URL.createObjectURL(blob);
    tab.location.replace(url);
  } catch (error) {
    const canceled = controller.signal.aborted;
    tab.close();
    release();
    if (!canceled) throw error;
  }
}
