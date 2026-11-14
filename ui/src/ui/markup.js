export const escapeHTML = (value) => String(value ?? "").replace(
  /[&<>"']/g,
  (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
);

export function parseJSON(text, message = "Enter valid JSON.") {
  try { return JSON.parse(text); }
  catch { throw new Error(message); }
}

export function parseObjectJSON(text, syntaxMessage, objectMessage = "Enter a JSON object.") {
  const value = parseJSON(text, syntaxMessage);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(objectMessage);
  return value;
}

const paths = {
  chevron: "m9 6 6 6-6 6",
  database:
    "M20 6c0 2-3.6 3-8 3S4 8 4 6s3.6-3 8-3 8 1 8 3ZM4 6v12c0 2 3.6 3 8 3s8-1 8-3V6M4 12c0 2 3.6 3 8 3s8-1 8-3",
  collection: "M3 4h18v5H3zM3 13h18v7H3zM7 6.5h.01M7 16.5h.01",
  object: "M8 4H6v6l-3 2 3 2v6h2M16 4h2v6l3 2-3 2v6h-2",
  copy: "M9 9h12v12H9zM15 9V3H3v12h6",
  check: "m5 12 4 4L19 6",
  plus: "M12 5v14M5 12h14",
  settings: "M4 7h7m4 0h5M4 17h3m4 0h9M11 4v6M7 14v6",
  run: "M5 12h14m-5-5 5 5-5 5",
  close: "m6 6 12 12M6 18 18 6",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  open: "M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  attachment: "m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2",
};
export const icon = (name, strokeWidth = 1.4) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]}"/></svg>`;
