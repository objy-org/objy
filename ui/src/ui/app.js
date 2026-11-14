import { Dialog } from "./dialog.js";
import { nodePills, nodeDetails } from "./node-view.js";
import {
  Connections,
  ConnectionStorage,
  ClusterMonitor,
} from "../data/connections.js";
import { previewKind, mountPreview, saveAttachment } from "./attachments.js";
import { showQueryBuilder } from "./query-builder.js";

import { escapeHTML as esc, icon as svg, parseJSON, parseObjectJSON } from "./markup.js";
const icon = (name) => svg(name, 1.5);
let clusterMonitor, nodeDialog, attachmentPreview;
let connections,
  store,
  explorer,
  toastTimer,
  editorBusy = false;
const dialog = new Dialog(render);
function toast(message) {
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}
function render() {
  if (!explorer) return;
  if (attachmentPreview && attachmentPreview.store !== store) dialog.close(true);
  const entry = connections.active;
  const pending = entry?.loading || new Set(),
    errors = entry?.errors || new Map();
  const data =
    pending.size || errors.size
      ? store.databases.map((db) => ({
          ...db,
          collections: db.collections.map((c) => ({
            ...c,
            loading: pending.has(JSON.stringify([db.id, c.id])),
            error: errors.get(JSON.stringify([db.id, c.id])),
          })),
        }))
      : store?.databases || [];
  if (explorer.databases !== data) explorer.databases = data;
  explorer.busy = Boolean(dialog.busy || editorBusy);
  explorer.hidden = !entry;
  explorer.inert = !entry;
  document.querySelector("#disconnected").hidden = Boolean(entry);
  const connection = document.querySelector("#connection-control");
  connection.textContent = entry
    ? store.connection.label + " ▾"
    : "Connect server";
  connection.title = store?.connection.url || "Connect to an OBJY server";
  connection.disabled = Boolean(dialog.busy || editorBusy);
  document.querySelector('[data-action="refresh-connection"]').disabled =
    !entry || Boolean(dialog.busy || editorBusy || entry.refreshing);
  for (const pill of document.querySelectorAll('[data-action="node-details"]'))
    pill.disabled = Boolean(dialog.busy || editorBusy);
  clusterMonitor?.setSource(store || null);
  const notice = document.querySelector("#connection-notice");
  const notices = [
    connections.warning,
    connections.restoreError,
    store?.refreshError
      ? "View may be out of date. " + store.refreshError.message
      : "",
  ].filter(Boolean);
  notice.hidden = !notices.length;
  notice.textContent = notices.join(" ");
}
function renderClusterNodes(state) {
  renderNodeDetails(state);
  const container = document.querySelector("#cluster-nodes");
  if (!container) return;
  container.hidden = state.status === "idle";
  if (state.status === "loading") {
    container.innerHTML =
      '<span class="cluster-note" role="status">Loading nodes…</span>';
    return;
  }
  if (state.status === "error") {
    container.innerHTML = `<span class="cluster-note" title="${esc(state.error)}" role="status">Nodes unavailable</span>`;
    return;
  }
  if (!state.nodes.length) {
    container.innerHTML = '<span class="cluster-note">No nodes reported</span>';
    return;
  }
  const focusedKey = container.querySelector(":focus")?.dataset.nodeKey;
  container.innerHTML = nodePills(state.nodes);
  for (const button of container.querySelectorAll("[data-node-key]")) {
    button.disabled = Boolean(dialog.busy || editorBusy);
    if (button.dataset.nodeKey === focusedKey)
      button.focus({ preventScroll: true });
    if (button.dataset.nodeKey === nodeDialog?.key) dialog.returnFocus = button;
  }
}
function renderNodeDetails(state) {
  if (!nodeDialog) return;
  if (nodeDialog.source !== clusterMonitor.source) {
    dialog.close(true);
    return;
  }
  const body = document.querySelector("#node-details");
  if (!body) return;
  const refresh = document.querySelector('[data-action="refresh-node"]');
  refresh.setAttribute("aria-disabled", String(Boolean(state.refreshing)));
  refresh.textContent = state.refreshing ? "Refreshing…" : "Refresh";
  body.setAttribute("aria-busy", String(Boolean(state.refreshing)));
  document.querySelector(".node-snapshot-note").textContent = state.updatedAt
    ? `Updated ${new Date(state.updatedAt).toLocaleTimeString()} · Manual refresh`
    : "Manual refresh";
  const node = state.nodes.find((node) => node.key === nodeDialog.key);
  if (!node) {
    body.innerHTML = `<p class="node-unavailable" role="status">${esc(state.status === "error" ? state.error : "This node is no longer reported by the server.")}</p>`;
    return;
  }
  body.innerHTML = nodeDetails(node);
}

function showNodeDetails(key) {
  if (dialog.busy || editorBusy) return;
  const node = clusterMonitor?.state.nodes.find((node) => node.key === key);
  if (!node) return;
  dialog.show(
    node.label,
    '<div id="node-details"></div><div class="node-footer"><span class="node-snapshot-note"></span><button type="button" class="node-refresh" data-action="refresh-node" aria-label="Refresh node statistics">Refresh</button></div>',
    null, { className: "node-modal", onClose: () => { nodeDialog = null; } },
  );
  nodeDialog = { key, source: clusterMonitor.source };
  renderNodeDetails(clusterMonitor.state);
}
function nameForm(placeholder) {
  return `<form><label class="form-field">Name<input name="name" required placeholder="${placeholder}"></label><div class="modal-actions"><button class="secondary-btn" type="button" data-action="close-modal">Cancel</button><button class="primary-btn" type="submit">Create</button></div></form>`;
}
function createScope(database) {
  if (!store) return connectionSettings();
  const targetStore = store, isDatabase = database === undefined;
  const kind = isDatabase ? "database" : "collection";
  dialog.show(`Create ${kind}`, nameForm(isDatabase ? "My data" : "Objects"), async (data) => {
    const name = data.get("name").trim();
    if (!name) throw new Error(`Enter a ${kind} name.`);
    if (isDatabase) await targetStore.createDatabase(name);
    else await targetStore.createCollections(database, [name]);
    dialog.close(true);
    render();
    if (isDatabase) explorer.selectDatabase(name);
    else explorer.selectCollection(database, name);
  });
}
function deleteScope({ databaseId: database, collectionId: collection }) {
  if (!store || dialog.busy || editorBusy) return;
  const targetStore = store,
    kind = collection === undefined ? "database" : "collection",
    name = collection ?? database,
    target = collection === undefined ? database : `${database} / ${collection}`;
  dialog.show(`Delete ${kind}`, `<form>
    <p class="modal-description">Delete <strong>${esc(target)}</strong> and all its ${collection === undefined ? "collections, " : ""}objects and attachments? This cannot be undone.</p>
    <label class="form-field confirm-name">Type <strong>${esc(name)}</strong> to confirm<input name="confirmation" aria-label="Confirm ${kind} name" autocomplete="off" required></label>
    <div class="modal-actions"><button class="secondary-btn" type="button" data-action="close-modal">Cancel</button><button class="secondary-btn danger-btn" type="submit" disabled>Delete ${kind}</button></div>
  </form>`, async (data) => {
    if (data.get("confirmation") !== name) throw new Error("Enter the exact name to confirm.");
    if (collection === undefined) await targetStore.dropDatabase(database);
    else await targetStore.dropCollection(database, collection);
    dialog.close(true);
    toast(`${kind === "database" ? "Database" : "Collection"} deleted`);
  });
  const form = document.querySelector(".modal form");
  form.elements.confirmation.addEventListener("input", () => {
    const button = form.querySelector("[type=submit]");
    button.disabled = dialog.busy || button.dataset.uncertain === "true" || form.elements.confirmation.value !== name;
  });
}
function addObjects(database, collection) {
  if (!store) return connectionSettings();
  const targetStore = store;
  dialog.show(
    "Add objects",
    `<form><label class="form-field">JSON<textarea class="json-editor" name="json" aria-label="Object JSON" spellcheck="false" required>{}</textarea></label><label class="form-field">Attachment · optional<input type="file" name="file" aria-label="File attachment"></label><p class="modal-description">One object or an array. Attachments require a single object.</p><div class="modal-actions"><button type="button" class="secondary-btn" data-action="close-modal">Cancel</button><button type="submit" class="primary-btn">Insert</button></div></form>`,
    async (data) => {
      const value = parseJSON(data.get("json"));
      const file = data.get("file");
      if (file?.name) {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("An attachment requires one JSON object.");
        await targetStore.insertFile(database, collection, { name: file.name, ...value }, file);
      } else
        await targetStore.insertObjects(database, collection, Array.isArray(value) ? value : [value]);
      dialog.close(true);
      render();
      toast("Objects inserted");
    },
  );
}
function attachFile({ databaseId: database, collectionId: collection, objectId: id, original }) {
  if (!store || dialog.busy || editorBusy) return;
  const targetStore = store, replacing = Boolean(original._file);
  dialog.show(replacing ? "Replace attachment" : "Attach file", `<form>
    <label class="form-field">File<input type="file" name="file" aria-label="File attachment" required></label>
    ${replacing ? '<p class="modal-description">This replaces the current attachment. The old file cannot be restored.</p>' : ""}
    <div class="modal-actions"><button type="button" class="secondary-btn" data-action="close-modal">Cancel</button><button type="submit" class="primary-btn">${replacing ? "Replace" : "Upload"}</button></div>
  </form>`, async (data) => {
    const file = data.get("file");
    if (!file?.name) throw new Error("Choose a file.");
    await targetStore.replaceFile(database, collection, id, file, { expected: original });
    dialog.close(true);
    toast(replacing ? "Attachment replaced" : "File attached");
  });
}
function disposeAttachmentPreview() {
  attachmentPreview?.controller.abort();
  attachmentPreview?.dispose?.();
  attachmentPreview = null;
}
async function openFile({ databaseId: database, collectionId: collection, objectId: id, original }) {
  if (!store || dialog.busy || editorBusy) return;
  const targetStore = store, name = String(original.name || id);
  const modal = dialog.show(name, '<div class="file-viewer" role="region" aria-label="Attachment preview"><p role="status">Loading attachment…</p></div><div class="modal-actions"><button type="button" class="secondary-btn" data-download-preview disabled>Download</button></div>',
    null, { className: "file-preview-modal", onClose: disposeAttachmentPreview });
  const viewer = modal.querySelector(".file-viewer"),
    download = modal.querySelector("[data-download-preview]"),
    preview = { store: targetStore, controller: new AbortController() };
  attachmentPreview = preview;
  try {
    const blob = await targetStore.downloadFile(database, collection, id, { signal: preview.controller.signal });
    const kind = await previewKind(blob);
    if (attachmentPreview !== preview) return;
    if (!kind) {
      dialog.close();
      saveAttachment(blob, name);
      return;
    }
    download.disabled = false;
    download.addEventListener("click", () => saveAttachment(blob, name));
    preview.dispose = mountPreview(viewer, blob, name, kind);
  } catch (error) {
    if (attachmentPreview !== preview) return;
    viewer.textContent = "";
    const message = modal.querySelector(".modal-error");
    message.textContent = error.message;
    message.hidden = false;
  }
}
async function writeObject(detail, remove = false) {
  if (!store) throw new Error("Connect to a server first.");
  if (dialog.busy || editorBusy)
    throw new Error("Wait for the current operation to finish.");
  const targetStore = store;
  const {
    databaseId: database,
    collectionId: collection,
    objectId: id,
    object,
    original,
  } = detail;
  if (targetStore.assertCollection(database, collection).readOnly)
    throw new Error("Derived query results cannot be edited or deleted.");
  editorBusy = true;
  render();
  try {
    const result = remove
      ? await targetStore.removeObjects(database, collection, [id], {
          expected: original,
        })
      : await targetStore.replaceObject(database, collection, id, object, {
          expected: original,
        });
    // A confirmed write remains visible even if the subsequent catalog read failed.
    if (targetStore.collectionRefreshError(database, collection)) {
      targetStore.databases = targetStore.databases.map((db) =>
        db.id !== database
          ? db
          : {
              ...db,
              collections: db.collections.map((c) =>
                c.id !== collection
                  ? c
                  : {
                      ...c,
                      objects: remove
                        ? c.objects.filter((value) => value._id !== id)
                        : c.objects.map((value) =>
                            value._id === id ? result : value,
                          ),
                      count:
                        remove && c.count !== null
                          ? Math.max(0, c.count - (result.deleted || 0))
                          : c.count,
                    },
              ),
            },
      );
    }
    if (store === targetStore) render();
    return result;
  } finally {
    editorBusy = false;
    render();
  }
}
async function collectionMetadata(database, collection) {
  if (!store || dialog.busy || editorBusy) return;
  const targetStore = store;
  dialog.show(
    "Collection metadata",
    '<p class="modal-description" role="status">Loading…</p>',
  );
  const loading = document.querySelector(".modal");
  try {
    const original = await targetStore.getMeta(database, collection);
    if (document.querySelector(".modal") !== loading || store !== targetStore)
      return;
    const initial = JSON.stringify(original, null, 2);
    dialog.show(
      "Collection metadata",
      `<form><label class="form-field">${esc(database)} / ${esc(collection)}<textarea class="json-editor" name="json" aria-label="Collection metadata JSON" spellcheck="false" required>${esc(initial)}</textarea></label><div class="modal-actions"><button type="button" class="secondary-btn" id="undo-meta">Undo</button><button type="submit" class="primary-btn">Save</button></div></form>`,
      async (data) => {
        const value = parseObjectJSON(data.get("json"));
        input.readOnly = true;
        undo.disabled = true;
        try {
          await targetStore.setMeta(database, collection, value, {
            expected: original,
          });
          dialog.close(true);
          render();
          toast("Metadata saved");
        } finally {
          input.readOnly = false;
          undo.disabled = input.value === initial;
        }
      },
    );
    const form = document.querySelector(".modal form"),
      input = form.elements.json,
      undo = form.querySelector("#undo-meta"),
      save = form.querySelector("[type=submit]");
    const update = () => {
      undo.disabled = dialog.busy || input.value === initial;
      save.disabled =
        dialog.busy ||
        save.dataset.uncertain === "true" ||
        input.value === initial;
    };
    input.addEventListener("input", update);
    undo.addEventListener("click", () => {
      if (dialog.busy) return;
      input.value = initial;
      const error = form.closest(".modal").querySelector(".modal-error");
      error.hidden = true;
      error.textContent = "";
      update();
      input.focus();
    });
    update();
  } catch (error) {
    if (document.querySelector(".modal") !== loading) return;
    const box = loading.querySelector(".modal-error");
    loading.querySelector("[role=status]").remove();
    box.hidden = false;
    box.textContent = error.message;
  }
}
function saveConnectionView() {
  const entry = connections.active;
  if (!entry) return;
  entry.viewState = explorer.viewState;
}
function showActiveConnection() {
  const entry = connections.active;
  store = entry?.store;
  explorer.databases = store?.databases || [];
  explorer.viewState = entry?.viewState || {};
  dialog.close(true);
  render();
}
function connectionChanged() {
  if (!explorer) return;
  if (store !== connections.active?.store) showActiveConnection();
  else render();
}
async function useConnection(id, disconnect = false) {
  if (dialog.busy || editorBusy) return;
  saveConnectionView();
  dialog.busy = true;
  render();
  try {
    if (disconnect) await connections.disconnect(id);
    else await connections.use(id);
    showActiveConnection();
  } catch (error) {
    if (!disconnect && error.status === 401) {
      dialog.busy = false;
      connectionSettings(id);
    }
    const box = document.querySelector(".modal .modal-error");
    if (box) {
      box.hidden = false;
      box.textContent = error.message;
    } else toast(error.message);
  } finally {
    dialog.busy = false;
    render();
  }
}
function connectionSettings(selectedId) {
  if (dialog.busy || editorBusy) return;
  const selected = connections.entries.get(selectedId)?.record;
  const defaultUrl = ["http:", "https:"].includes(location.protocol)
    ? location.origin
    : "";
  const label = (entry) =>
    entry.store?.connection.label ||
    new URL(entry.record.url).host +
      new URL(entry.record.url).pathname.replace(/\/$/, "");
  dialog.show(
    selected ? "Sign in" : "Connect server",
    `<div class="connections-list">${[...connections.entries.values()].map((entry) => `<div class="connection-row"><button type="button" data-action="use-connection" data-id="${esc(entry.id)}" aria-current="${entry.id === connections.activeId}">${esc(label(entry))}${entry.id === connections.activeId ? " ✓" : entry.needsLogin ? " · Sign in" : entry.error ? " · Retry" : ""}</button><button type="button" data-action="disconnect" data-id="${esc(entry.id)}" aria-label="Forget ${esc(label(entry))}" title="Forget server and saved login">${icon("close")}</button></div>`).join("")}</div>
 <form><label class="form-field">Server URL<input name="url" type="url" placeholder="http://localhost:8080" value="${esc(selected?.url || defaultUrl)}" required></label>
 <div class="credentials"><label class="form-field">Username<input name="username" autocomplete="username" value="${esc(selected?.username || "")}"></label><label class="form-field">Password<input name="password" type="password" autocomplete="current-password"></label></div>
 <details><summary>Authentication scope</summary><label class="form-field">Database<input name="database" value="${esc(selected?.database || "_global")}" required></label><label class="form-field">Collection<input name="collection" value="${esc(selected?.collection || "users")}" required></label></details>
 <p class="modal-description">${connections.storage ? "Server and login are saved in this browser. Passwords are never saved." : "Connections last for this page only."} Leave credentials empty for servers without authentication.</p>
 <div class="modal-actions"><button class="primary-btn" type="submit">Connect</button></div></form>`,
    async (data) => {
      if (data.get("password") && !data.get("username").trim())
        throw new Error("Enter a username.");
      saveConnectionView();
      await connections.connect(
        {
          url: data.get("url").trim(),
          username: data.get("username").trim(),
          password: data.get("password"),
          database: data.get("database").trim(),
          collection: data.get("collection").trim(),
        },
        { id: selectedId },
      );
      showActiveConnection();
    },
  );
}
async function loadObjects({ databaseId: database, collectionId: collection, more = false, query }) {
  const entry = connections.active, querying = query !== undefined;
  if (!entry) {
    if (querying) throw new Error("Connect to a server first.");
    return;
  }
  if (querying && (dialog.busy || editorBusy))
    throw new Error("Wait for the current operation to finish.");
  const key = JSON.stringify([database, collection]);
  if (entry.loading.has(key)) {
    if (querying) throw new Error("Wait for this collection to finish loading.");
    return;
  }
  const cached = entry.store.assertCollection(database, collection);
  if (!querying && cached.loaded && !more && !entry.errors.has(key)) return;
  entry.loading.add(key);
  if (!querying) entry.errors.delete(key);
  render();
  try {
    await entry.store.loadCollection(database, collection, { more, query });
    entry.errors.delete(key);
  } catch (error) {
    if (querying) throw error; // Query editor retains the previous result and shows the error.
    entry.errors.set(key, error.message);
  } finally {
    entry.loading.delete(key);
    if (connections.active === entry) render();
  }
}
async function refreshConnection() {
  if (dialog.busy) return;
  const entry = connections.active;
  if (!entry || entry.refreshing) return;
  entry.refreshing = true;
  render();
  clusterMonitor?.refresh();
  try {
    await entry.store.refresh();
    entry.errors?.clear();
  } catch (error) {
    toast(error.message);
  } finally {
    entry.refreshing = false;
    if (connections.active === entry) render();
  }
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  event.preventDefault();
  switch (button.dataset.action) {
    case "connections":
      connectionSettings();
      break;
    case "use-connection":
      useConnection(button.dataset.id);
      break;
    case "disconnect":
      useConnection(button.dataset.id, true);
      break;
    case "refresh-connection":
      refreshConnection();
      break;
    case "node-details":
      showNodeDetails(button.dataset.nodeKey);
      break;
    case "refresh-node":
      if (!clusterMonitor?.state.refreshing) clusterMonitor?.refresh();
      break;
  }
});
async function initialize() {
  const shell = document.querySelector("#shell");
  shell.innerHTML =
    '<main class="canvas"><p role="status">Opening OBJY…</p></main>';
  try {
    connections = new Connections({
      storage: new ConnectionStorage(),
      onChange: connectionChanged,
      channel:
        typeof BroadcastChannel === "function"
          ? new BroadcastChannel("objy-studio-connections")
          : null,
    });
    await connections.restore();
    store = connections.active?.store;
    shell.innerHTML = `<main class="canvas" aria-label="OBJY Data Explorer"><div class="connection-bar"><div class="connection-summary"><button id="connection-control" class="connection-chip" type="button" data-action="connections" aria-label="Choose database connection"></button><div id="cluster-nodes" class="cluster-nodes" role="group" aria-label="Cluster nodes" hidden></div></div><button type="button" class="icon-btn" data-action="refresh-connection" aria-label="Refresh connection" title="Refresh">↻</button></div><p id="connection-notice" class="modal-error" role="status" hidden></p><div id="disconnected" class="disconnected"><p>No server connected</p><button class="primary-btn" type="button" data-action="connections">Connect server</button></div><objy-data-explorer fill hidden inert></objy-data-explorer></main>`;
    clusterMonitor = new ClusterMonitor({ onChange: renderClusterNodes });
    explorer = document.querySelector("objy-data-explorer");
    const actions = {
      "build-query": (detail) => {
        if (!store || dialog.busy || editorBusy) return;
        const objects = store.assertCollection(detail.databaseId, detail.collectionId).objects;
        const fields = [...new Set(objects.flatMap(Object.keys))].sort();
        showQueryBuilder(dialog, { ...detail, fields });
      },
      "collection-select": loadObjects,
      "load-objects": loadObjects,
      "create-database": () => createScope(),
      "create-collection": ({ databaseId }) => createScope(databaseId),
      "create-objects": ({ databaseId, collectionId }) => addObjects(databaseId, collectionId),
      "manage-collection": ({ databaseId, collectionId }) => collectionMetadata(databaseId, collectionId),
      "delete-scope": deleteScope,
      "attach-file": attachFile,
      "open-file": openFile,
      "save-object": (detail) => detail.respondWith(writeObject(detail)),
      "delete-object": (detail) => detail.respondWith(writeObject(detail, true)),
      "run-query": (detail) => detail.respondWith(loadObjects(detail)),
    };
    for (const [event, handle] of Object.entries(actions))
      explorer.addEventListener(event, ({ detail }) => handle(detail));
    render();
  } catch (error) {
    shell.innerHTML = `<main class="canvas"><p role="alert">Could not open OBJY: ${esc(error.message)}</p></main>`;
  }
}
initialize();
