import { escapeHTML as escape, icon as svg, parseObjectJSON } from "../markup.js";

/*
 * <objy-data-explorer> — dependency-free, reusable data browser.
 *
 * explorer.databases = [{ id, name, collections: [{ id, name, objects: [{ _id, ...data }] }] }];
 * explorer.viewState restores expansion and selection between mounts.
 * Events: create-database, create-collection { databaseId },
 * create-objects { databaseId, collectionId }, collection-select { databaseId, collectionId },
 * object-select { databaseId, collectionId, object }, manage-collection { databaseId, collectionId },
 * save-object / delete-object { databaseId, collectionId, objectId, object, original, respondWith }.
 * run-query { databaseId, collectionId, query, respondWith } executes a native JSON query.
 * delete-scope { databaseId, collectionId? } requests confirmed deletion by the host.
 * attach-file / open-file { databaseId, collectionId, objectId, original }.
 * The host handles writes and supplies refreshed data. Only unsaved editor drafts live here.
 * Colors inherit the host's CSS custom properties; defaults work standalone.
 */
const keyFor = (...parts) => JSON.stringify(parts);
const objectLabel = (object) => String(object._id ?? object.id ?? "No ID");
const format = (object) => JSON.stringify(object, null, 2);
const preview = (object) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(object).filter(([key]) => key !== "_id"),
    ),
  ).slice(0, 180);
const styles = `
  :host { display:block; min-width:0; container-type:inline-size; font-family:inherit; color:var(--ink,#e7e7e7); color-scheme:dark; }
  * { box-sizing:border-box; }
  button { font:inherit; color:inherit; cursor:pointer; border:0; background:none; }
  button:disabled { cursor:default; opacity:.35; }
  .icon-button:disabled:hover { background:none; }
  .objects-pane h2 { flex:1; }
  .objects-pane .count,.objects-pane .icon-button { margin-left:0; }
  ::selection { background:var(--selection,#474747); color:var(--ink,#e7e7e7); }
  button:focus-visible { outline:1px solid var(--accent,#c4c4c4); outline-offset:-2px; }
  svg { width:15px; height:15px; flex-shrink:0; }
  .explorer { overflow:hidden; background:var(--canvas,#181818); }
  .panes { display:grid; grid-template-columns:minmax(160px,23%) minmax(0,1fr); height:444px; }
  :host([fill]) { display:flex; flex-direction:column; min-height:0; }
  :host([fill]) .explorer { display:flex; flex-direction:column; flex:1; min-height:0; }
  :host([fill]) .panes { flex:1; min-height:0; height:auto; }
  .workspace { display:flex; flex-direction:column; min-width:0; min-height:0; }
  .results-panes { display:grid; grid-template-columns:minmax(150px,31.17%) minmax(0,1fr); flex:1; min-height:0; }
  .query-panel { border-bottom:1px solid var(--line,#343434); flex-shrink:0; }
  .query-bar { display:flex; align-items:center; gap:7px; padding:7px 10px; margin:0; }
  .query-input { flex:1; width:100%; min-width:0; min-height:28px; max-height:112px; resize:none; border:0; border-radius:4px; padding:5px 7px; background:transparent; color:var(--ink,#e7e7e7); font:11px/18px ui-monospace,SFMono-Regular,Menlo,monospace; scrollbar-width:thin; }
  .query-input::placeholder { color:var(--muted,#929292); }
  .query-input:focus { outline:1px solid var(--line,#343434); background:var(--surface,#222222); }
  .query-message { padding:0 17px 8px; color:var(--muted,#929292); font-size:10px; line-height:1.5; overflow-wrap:anywhere; }
  .query-message:empty { display:none; }.query-message.error { color:#d8b49d; }
  .pane { display:flex; flex-direction:column; min-width:0; min-height:0; overflow:hidden; }
  .tree-pane,.objects-pane { border-right:1px solid var(--line,#343434); }
  .pane-head { height:44px; flex-shrink:0; padding:0 12px; display:flex; align-items:center; gap:8px; border-bottom:1px solid var(--line,#343434); }
  h2 { font-size:11px; font-weight:500; margin:0; color:var(--secondary,#b8b8b8); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .pane-head .icon-button { margin-left:auto; }
  .tree,.object-list { flex:1; min-height:0; padding:8px 6px; overflow:auto; scrollbar-width:thin; scrollbar-color:var(--scrollbar,#484848) transparent; }
  .node-row { display:flex; align-items:center; }
  .node { min-width:0; width:100%; display:flex; align-items:center; gap:7px; padding:0 7px; height:34px; border-radius:5px; text-align:left; white-space:nowrap; font-size:11px; color:var(--secondary,#b8b8b8); }
  .collection { padding-left:25px; }
  .node:hover,.object-row:hover,.icon-button:hover { background:var(--surface-hover,#2d2d2d); }
  .node[aria-selected="true"],.object-row[aria-selected="true"] { background:var(--wash,#333333); color:var(--ink,#e7e7e7); }
  .node-icon { display:flex; color:var(--muted,#929292); }
  [aria-selected="true"] .node-icon { color:var(--accent,#c4c4c4); }
  .chevron { width:11px; height:11px; flex-shrink:0; display:flex; align-items:center; justify-content:center; color:var(--muted,#929292); }
  .chevron svg { width:11px; height:11px; transition:transform .12s; }
  .node[aria-expanded="true"] .chevron svg { transform:rotate(90deg); }
  .label { min-width:0; overflow:hidden; text-overflow:ellipsis; }
  .count { margin-left:auto; color:var(--muted,#929292); font-size:10px; padding-left:5px; }
  .tree-note,.empty-list { padding:14px 10px; font-size:11px; line-height:1.5; color:var(--muted,#929292); }
  .tree-note { padding:7px 10px 10px 26px; }
  .icon-button { width:27px; height:27px; display:grid; place-items:center; border-radius:5px; color:var(--muted,#929292); flex-shrink:0; padding:0; }
  .node-row .icon-button { width:24px; height:28px; }
  .scope-delete { opacity:0; }
  .node-row:hover .scope-delete,.node-row:focus-within .scope-delete { opacity:1; }
  @media(hover:none) { .scope-delete { opacity:1; } }
  .object-row { width:100%; display:flex; gap:9px; align-items:center; padding:10px 9px; text-align:left; border-radius:5px; color:var(--secondary,#b8b8b8); }
  .object-text { display:flex; flex:1; flex-direction:column; gap:5px; min-width:0; }
  .object-label { font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .object-preview { font:9px ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted,#929292); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .viewer { background:var(--surface,#222222); }
  .json { display:block; width:100%; min-height:0; flex:1; resize:none; border:0; border-radius:0; background:transparent; overflow:auto; padding:16px 18px 20px; margin:0; font:11px/1.95 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; color:var(--ink,#e7e7e7); tab-size:2; scrollbar-width:thin; scrollbar-color:var(--scrollbar,#484848) transparent; }
  .json:focus-visible { outline:1px solid var(--accent,#c4c4c4); outline-offset:-3px; }
  .editor-actions { display:flex; gap:6px; align-items:center; padding:10px 12px; border-top:1px solid var(--line,#343434); }
  .editor-actions button { border-radius:5px; padding:6px 9px; font-size:11px; }
  .save { background:var(--accent,#c4c4c4); color:var(--accent-ink,#202020); }
  .undo:hover,.delete:hover { background:var(--surface-hover,#2d2d2d); }
  .delete { margin-left:auto; color:#d8b49d; }
  .editor-status { padding:0 14px 10px; font-size:10px; line-height:1.5; color:var(--muted,#929292); overflow-wrap:anywhere; }
  .editor-status:empty { display:none; }.editor-status.error { color:#d8b49d; }
  .attachment-bar { display:flex; align-items:center; gap:7px; min-height:37px; padding:5px 12px; border-top:1px solid var(--line,#343434); color:var(--muted,#929292); font-size:10px; }
  .attachment-bar span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .attachment-bar button { flex-shrink:0; font-size:10px; padding:5px; border-radius:4px; }
  .attachment-bar button:hover { background:var(--surface-hover,#2d2d2d); }
  .dirty-dot { width:5px; height:5px; border-radius:50%; background:var(--accent,#c4c4c4); flex-shrink:0; }
  [hidden] { display:none!important; }
  .empty-view { display:flex; flex:1; align-items:center; justify-content:center; color:var(--muted,#929292); font-size:11px; }
  .load-state { font-size:10px; line-height:1.5; padding:8px 12px; color:var(--muted); overflow-wrap:anywhere; }
  .load-state button { padding:5px; color:var(--accent); display:block; }
  .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
  @container(max-width:620px) { .panes { grid-template-columns:minmax(0,1fr) minmax(0,1fr); grid-template-rows:auto 190px 280px; height:auto; }.workspace,.results-panes { display:contents; }.query-panel { grid-column:1/-1; grid-row:1; }.tree-pane { grid-column:1; grid-row:2; }.objects-pane { grid-column:2; grid-row:2; border-right:0; }.viewer { grid-column:1/-1; grid-row:3; border-top:1px solid var(--line,#343434); } }
  @container(max-width:620px) { :host([fill]) .panes { grid-template-rows:auto minmax(0,2fr) minmax(0,3fr); } }
  @media(prefers-reduced-motion:reduce) { * { transition:none!important; } }
`;

class DataExplorer extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._databases = [];
    this._nodes = new Map();
    this._expanded = new Set();
    this._collection =
      this._selected =
      this._focused =
      this._objectFocus =
        null;
    this._initialized = false;
    this._drafts = new Map();
    this._queries = new Map();
    this._busy = false;
    this.shadowRoot.addEventListener("click", (event) =>
      this._onClick(event),
    );
    this.shadowRoot.addEventListener("input", (event) => {
      if (event.target.matches(".query-input")) {
        const state = this._queryState();
        if (state) {
          state.text = event.target.value;
          state.error = "";
          this._updateQuery();
        }
        return;
      }
      if (!event.target.matches(".json")) return;
      const draft = this._draft(this._nodes.get(this._selected));
      draft.text = event.target.value;
      draft.error = "";
      draft.message = "";
      draft.confirmDelete = false;
      this._updateEditor();
    });
    this.shadowRoot.addEventListener("submit", (event) => {
      if (event.target.matches(".query-bar")) {
        event.preventDefault();
        this._runQuery();
      }
    });
    this.shadowRoot.addEventListener("keydown", (event) =>
      this._onKeyDown(event),
    );
    this.shadowRoot.addEventListener("focusin", (event) => {
      const button = event.target.closest("[data-node],[data-object]");
      if (button)
        this._focus(button.dataset.node || button.dataset.object, false);
    });
  }
  connectedCallback() {
    this._render();
  }
  set databases(value) {
    this._databases = Array.isArray(value) ? value : [];
    this._nodes = new Map();
    this._databases.forEach((database) => {
      const dbKey = keyFor("database", database.id);
      const dbNode = {
        key: dbKey,
        id: database.id,
        name: String(database.name ?? database.id),
        type: "database",
        children: [],
        parent: null,
      };
      this._nodes.set(dbKey, dbNode);
      (database.collections || []).forEach((collection) => {
        const colKey = keyFor("collection", database.id, collection.id);
        const colNode = {
          key: colKey,
          id: collection.id,
          name: String(collection.name ?? collection.id),
          type: "collection",
          children: [],
          parent: dbKey,
          databaseId: database.id,
          loaded: collection.loaded !== false,
          loading: collection.loading,
          error: collection.error,
          hasMore: collection.hasMore,
          query: collection.query || null,
          readOnly: collection.readOnly,
          directQuery: collection.directQuery,
          resultCount: collection.resultCount ?? collection.count,
          count:
            collection.count ??
            (collection.loaded === false
              ? null
              : (collection.objects || []).length),
        };
        dbNode.children.push(colKey);
        this._nodes.set(colKey, colNode);
        (collection.objects || []).forEach((object, index) => {
          const result =
            collection.readOnly || (object._id == null && object.id == null);
          const key = result
            ? keyFor(
                "result",
                database.id,
                collection.id,
                collection.query,
                index,
              )
            : keyFor(
                "object",
                database.id,
                collection.id,
                object._id ?? object.id,
              );
          colNode.children.push(key);
          this._nodes.set(key, {
            key,
            name: result ? `Result ${index + 1}` : objectLabel(object),
            type: "object",
            readOnly: result,
            parent: colKey,
            object,
            databaseId: database.id,
            collectionId: collection.id,
          });
        });
      });
    });
    this._expanded = new Set(
      [...this._expanded].filter(
        (key) => this._nodes.get(key)?.type === "database",
      ),
    );
    if (!this._nodes.has(this._collection)) this._collection = null;
    if (
      !this._collection ||
      this._nodes.get(this._selected)?.parent !== this._collection
    )
      this._selected = null;
    if (!this._nodes.has(this._focused)) this._focused = null;
    for (const key of this._queries.keys())
      if (!this._nodes.has(key)) this._queries.delete(key);
    for (const key of this._drafts.keys()) {
      const [, database, collection] = JSON.parse(key);
      if (!this._nodes.has(keyFor("collection", database, collection))) this._drafts.delete(key);
    }
    if (!this._initialized && this._databases.length) {
      const key = keyFor("database", this._databases[0].id);
      this._expanded.add(key);
      this._focused = key;
      this._initialized = true;
    }
    this._render();
  }
  get databases() {
    return this._databases;
  }
  set busy(value) {
    this._busy = Boolean(value);
    this._updateEditor();
  }
  get busy() {
    return this._busy;
  }
  get selection() {
    const collection = this._nodes.get(this._collection);
    if (collection)
      return {
        databaseId: collection.databaseId,
        collectionId: collection.id,
      };
    const focused = this._nodes.get(this._focused);
    return focused?.type === "database"
      ? { databaseId: focused.id, collectionId: null }
      : null;
  }
  get viewState() {
    return {
      expanded: [...this._expanded],
      collection: this._collection,
      selected: this._selected,
      focused: this._focused,
      objectFocus: this._objectFocus,
      drafts: [...this._drafts]
        .filter(([, draft]) => draft.text !== draft.base || draft.uncertain)
        .map(([key, draft]) => [
          key,
          { ...draft, pending: false, confirmDelete: false },
        ]),
      queries: [...this._queries].map(([key, state]) => [
        key,
        { ...state, pending: false },
      ]),
      scrollTop: this.shadowRoot.querySelector(".tree")?.scrollTop || 0,
      objectsScrollTop:
        this.shadowRoot.querySelector(".object-list")?.scrollTop || 0,
      jsonScrollTop: this.shadowRoot.querySelector(".json")?.scrollTop || 0,
    };
  }
  set viewState(value) {
    if (!value) return;
    this._drafts = new Map(value.drafts || []);
    this._queries = new Map(value.queries || []);
    this._expanded = new Set(
      (value.expanded || []).filter(
        (key) => this._nodes.get(key)?.type === "database",
      ),
    );
    const selected = this._nodes.get(value.selected);
    const collection = this._nodes.get(value.collection || selected?.parent);
    this._collection =
      collection?.type === "collection" ? collection.key : null;
    this._selected =
      selected?.type === "object" && selected.parent === this._collection
        ? selected.key
        : null;
    this._focused = this._nodes.has(value.focused) ? value.focused : null;
    this._objectFocus = value.objectFocus || this._selected;
    this._render();
    this.shadowRoot.querySelector(".tree").scrollTop = value.scrollTop || 0;
    this.shadowRoot.querySelector(".object-list").scrollTop =
      value.objectsScrollTop || 0;
    const json = this.shadowRoot.querySelector(".json");
    if (json) json.scrollTop = value.jsonScrollTop || 0;
  }
  selectDatabase(databaseId) {
    const key = keyFor("database", databaseId);
    if (!this._nodes.has(key)) return;
    this._expanded.add(key);
    this._collection = this._selected = this._objectFocus = null;
    this._focused = key;
    this._render({ resetObjects: true, resetJson: true });
    this._focus(key);
  }
  selectCollection(databaseId, collectionId) {
    const node = this._nodes.get(
      keyFor("collection", databaseId, collectionId),
    );
    if (!node) return;
    const changed = this._collection !== node.key;
    if (changed) this._selected = this._objectFocus = null;
    this._collection = node.key;
    this._expanded.add(node.parent);
    this._focused = node.key;
    this._render({ resetObjects: changed, resetJson: changed });
    this._focus(node.key);
    this._emit("collection-select", { databaseId, collectionId });
  }
  _emit(name, detail = {}) {
    this.dispatchEvent(
      new CustomEvent(name, { bubbles: true, composed: true, detail }),
    );
  }
  async _request(name, detail, kind) {
    let work;
    this._emit(name, {
      ...detail,
      respondWith(promise) {
        if (work) throw new Error(`A ${kind} handler is already registered.`);
        work = Promise.resolve(promise);
      },
    });
    if (!work) throw new Error(`No ${kind} handler is connected.`);
    return work;
  }
  _queryState() {
    const collection = this._nodes.get(this._collection);
    if (!collection) return null;
    if (!this._queries.has(collection.key))
      this._queries.set(collection.key, {
        text: collection.query ? JSON.stringify(collection.query) : "",
        pending: false,
        error: "",
      });
    return this._queries.get(collection.key);
  }
  _updateQuery() {
    const collection = this._nodes.get(this._collection),
      state = this._queryState();
    const input = this.shadowRoot.querySelector(".query-input");
    if (!input) return;
    const locked =
      !collection || this._busy || state?.pending || collection.loading;
    input.disabled = !collection;
    input.readOnly = Boolean(locked);
    input.style.height = "28px";
    input.style.height = `${Math.min(112, Math.max(28, input.scrollHeight))}px`;
    this.shadowRoot.querySelector("[data-run-query]").disabled =
      Boolean(locked);
    this.shadowRoot.querySelector("[data-build-query]").disabled = Boolean(locked);
    const clear = this.shadowRoot.querySelector("[data-clear-query]");
    clear.hidden = !state?.text && !collection?.query;
    clear.disabled = Boolean(locked);
    let changed = false;
    if (state) {
      try {
        changed =
          JSON.stringify(JSON.parse(state.text.trim() || "{}")) !==
          JSON.stringify(collection.query || {});
      } catch {
        changed = true;
      }
    }
    const status = this.shadowRoot.querySelector(".query-message");
    status.textContent =
      state?.error ||
      (state?.pending
        ? "Running…"
        : changed
          ? "Not run · results below are from the previous query"
          : collection?.directQuery
            ? "Returned rows · pagination follows your query"
            : "");
    status.classList.toggle("error", Boolean(state?.error));
  }
  async _runQuery(clear = false) {
    const collection = this._nodes.get(this._collection),
      state = this._queryState();
    if (
      !collection ||
      !state ||
      state.pending ||
      this._busy ||
      collection.loading
    )
      return;
    if (clear) state.text = "";
    let query;
    try {
      query = parseObjectJSON(state.text.trim() || "{}",
        "Enter valid JSON. Results have not changed.", "Enter a JSON query object.");
    } catch (error) {
      state.error = error.message;
      this._updateQuery();
      return;
    }
    state.pending = true;
    state.error = "";
    this._render();
    try {
      await this._request("run-query", {
        databaseId: collection.databaseId,
        collectionId: collection.id,
        query,
      }, "query");
    } catch (error) {
      state.error = `${error.message} Previous results were kept.`;
    } finally {
      state.pending = false;
      this._updateQuery();
    }
  }
  _draft(node) {
    if (!node) return null;
    const base = format(node.object);
    let draft = this._drafts.get(node.key);
    if (
      !draft ||
      (draft.text === draft.base &&
        !draft.pending &&
        !draft.uncertain &&
        base !== draft.base)
    ) {
      draft = {
        base,
        text: base,
        pending: false,
        uncertain: false,
        error: "",
        message: "",
        confirmDelete: false,
      };
      this._drafts.set(node.key, draft);
    }
    return draft;
  }
  _updateEditor() {
    this._updateQuery();
    for (const button of this.shadowRoot.querySelectorAll(
      "[data-add-database],[data-add-collection],[data-delete-scope]",
    ))
      button.disabled = this._busy;
    for (const button of this.shadowRoot.querySelectorAll(
      "[data-add-objects],[data-manage-collection]",
    ))
      button.disabled = this._busy || !this._collection;
    const node = this._nodes.get(this._selected),
      draft = this._draft(node);
    if (!draft) return;
    const root = this.shadowRoot,
      locked = this._busy || draft.pending,
      dirty = draft.text !== draft.base;
    const editor = root.querySelector(".json");
    if (!editor) return;
    editor.readOnly = Boolean(locked || node.readOnly);
    root.querySelector(".editor-actions").hidden = Boolean(node.readOnly);
    root.querySelector(".attachment-bar").hidden = Boolean(node.readOnly);
    const attach = root.querySelector("[data-attach-file]");
    attach.disabled = Boolean(locked || dirty || draft.uncertain || node.readOnly);
    attach.title = dirty || draft.uncertain ? "Save or undo JSON changes before attaching a file" : attach.textContent;
    const open = root.querySelector("[data-open-file]");
    if (open) open.disabled = Boolean(locked || node.readOnly);
    root.querySelector("[data-save]").disabled =
      locked || !dirty || draft.uncertain;
    root.querySelector("[data-save]").textContent =
      draft.pending && draft.action === "save-object" ? "Saving…" : "Save";
    root.querySelector("[data-undo]").disabled =
      locked || (!dirty && !draft.uncertain && !draft.confirmDelete);
    root.querySelector("[data-undo]").textContent = draft.confirmDelete
      ? "Cancel"
      : "Undo";
    const remove = root.querySelector("[data-delete]");
    remove.disabled = locked || draft.uncertain;
    remove.textContent =
      draft.pending && draft.action === "delete-object"
        ? "Deleting…"
        : draft.confirmDelete
          ? "Confirm delete"
          : "Delete";
    remove.setAttribute(
      "aria-label",
      draft.confirmDelete ? "Confirm delete object" : "Delete object",
    );
    root.querySelector(".dirty-dot").hidden = !dirty;
    const status = root.querySelector(".editor-status");
    status.textContent = node.readOnly
      ? "Query result · read only"
      : draft.error ||
        (draft.confirmDelete
          ? "Delete this object from the server?"
          : draft.message || (dirty ? "Unsaved changes" : ""));
    status.classList.toggle(
      "error",
      Boolean(draft.error || draft.confirmDelete),
    );
  }
  async _write(name, node) {
    const draft = this._draft(node);
    if (
      !draft ||
      node.readOnly ||
      this._busy ||
      draft.pending ||
      draft.uncertain
    )
      return;
    if (name === "save-object" && draft.text === draft.base) return;
    let object;
    if (name === "save-object") {
      try {
        object = parseObjectJSON(draft.text, "Enter valid JSON before saving.");
        if (object._id !== node.object._id)
          throw new Error("_id cannot be changed or removed.");
        if (
          node.object._id == null &&
          (node.object.id == null || object.id !== node.object.id)
        )
          throw new Error("This object needs a stable ID to save changes.");
      } catch (error) {
        draft.error = error.message;
        this._updateEditor();
        return;
      }
    }
    draft.pending = true;
    draft.action = name;
    draft.error = "";
    draft.confirmDelete = false;
    this._updateEditor();
    try {
      await this._request(name, {
        databaseId: node.databaseId,
        collectionId: node.collectionId,
        objectId: node.object._id ?? node.object.id,
        object,
        original: JSON.parse(draft.base),
      }, "database write");
      if (this._drafts.get(node.key) !== draft) return;
      this._drafts.delete(node.key);
      this._render();
      if (name === "save-object") {
        const saved = this._draft(this._nodes.get(node.key));
        if (saved) saved.message = "Saved";
      }
    } catch (error) {
      draft.error = error.message;
      draft.uncertain = Boolean(error.writeMayHaveSucceeded);
    } finally {
      draft.pending = false;
      this._updateEditor();
    }
  }
  _visibleNodes() {
    const result = [];
    for (const node of this._nodes.values())
      if (node.type === "database") {
        result.push(node);
        if (this._expanded.has(node.key))
          result.push(...node.children.map((key) => this._nodes.get(key)));
      }
    return result;
  }
  _nodeMarkup(node) {
    const database = node.type === "database";
    const expanded = this._expanded.has(node.key);
    const button = `<button type="button" class="node ${node.type}" role="treeitem" aria-label="${escape(node.name)}, ${node.type}" aria-level="${database ? 1 : 2}" ${database ? `aria-expanded="${expanded}"` : ""} aria-selected="${this._collection === node.key}" data-node="${escape(node.key)}" tabindex="${this._focused === node.key ? "0" : "-1"}" title="${escape(node.name)}">${database ? `<span class="chevron">${svg("chevron")}</span>` : ""}<span class="node-icon">${svg(node.type)}</span><span class="label">${escape(node.name)}</span>${database ? "" : `<span class="count" aria-hidden="true">${node.count ?? "–"}</span>`}</button>`;
    const remove = database && node.id === "_global" ? "" : `<button type="button" class="icon-button scope-delete" data-delete-scope="${escape(node.key)}" aria-label="Delete ${node.type} ${escape(database ? node.name : `${node.databaseId}/${node.name}`)}" title="Delete ${node.type}">${svg("trash")}</button>`;
    if (!database) return `<div class="node-row" role="none">${button}${remove}</div>`;
    return `<div role="none"><div class="node-row" role="none">${button}${remove}<button type="button" class="icon-button" data-add-collection="${escape(node.key)}" aria-label="Add collection to ${escape(node.name)}" title="Add collection">${svg("plus")}</button></div>${expanded ? `<div role="group" aria-label="Collections in ${escape(node.name)}">${node.children.map((key) => this._nodeMarkup(this._nodes.get(key))).join("") || '<div class="tree-note">No collections</div>'}</div>` : ""}</div>`;
  }
  _render({ resetObjects = false, resetJson = false } = {}) {
    const previousQuery = this.shadowRoot.querySelector(".query-input");
    const querying =
      this.shadowRoot.activeElement === previousQuery && previousQuery;
    const queryCaret = querying
      ? [previousQuery.selectionStart, previousQuery.selectionEnd]
      : null;
    const previousEditor = this.shadowRoot.querySelector(".json");
    const editing =
      this.shadowRoot.activeElement === previousEditor && previousEditor;
    const caret = editing
      ? [previousEditor.selectionStart, previousEditor.selectionEnd]
      : null;
    const scrolls = [".tree", ".object-list", ".json"].map(
      (selector) => this.shadowRoot.querySelector(selector)?.scrollTop || 0,
    );
    const visible = this._visibleNodes();
    if (!visible.some((node) => node.key === this._focused))
      this._focused = visible[0]?.key || null;
    const collection = this._nodes.get(this._collection);
    const queryState = this._queryState(),
      resultCount = collection?.resultCount ?? collection?.count;
    const objects = (collection?.children || []).map((key) =>
      this._nodes.get(key),
    );
    if (!objects.some((node) => node.key === this._objectFocus))
      this._objectFocus = this._selected || objects[0]?.key || null;
    const selected = this._nodes.get(this._selected),
      draft = this._draft(selected);
    const databases = [...this._nodes.values()].filter(
      (node) => node.type === "database",
    );
    this.shadowRoot.innerHTML = `<style>${styles}</style><section class="explorer" aria-label="Data Explorer"><div class="panes">
      <div class="pane tree-pane"><header class="pane-head"><h2>Databases</h2><button type="button" class="icon-button" data-add-database aria-label="Add database" title="Add database">${svg("plus")}</button></header><div class="tree" role="tree" aria-label="Databases">${databases.map((node) => this._nodeMarkup(node)).join("") || '<div class="empty-list">No databases</div>'}</div></div>
      <div class="workspace"><div class="query-panel"><form class="query-bar" aria-label="Collection query"><textarea class="query-input" rows="1" aria-label="JSON query" placeholder="${collection ? "JSON query…  {}" : "Select a collection to query"}" title="Enter inserts a new line. Command+Enter or Ctrl+Enter runs the query." spellcheck="false" autocomplete="off" autocapitalize="off">${escape(queryState?.text || "")}</textarea><button type="button" class="icon-button" data-build-query aria-label="Query builder" title="Query builder">${svg("settings")}</button><button type="button" class="icon-button" data-clear-query aria-label="Clear query" title="Clear query">${svg("close")}</button><button type="submit" class="icon-button" data-run-query aria-label="Run query" aria-keyshortcuts="Meta+Enter Control+Enter" title="Run query (⌘/Ctrl+Enter)">${svg("run")}</button></form><div class="query-message" role="status" aria-live="polite"></div></div><div class="results-panes">
      <div class="pane objects-pane"><header class="pane-head"><h2 title="${escape(collection?.name || "")}">${escape(collection?.name || "Objects")}</h2>${collection ? `<span class="count" aria-label="${objects.length} loaded${resultCount == null ? "" : ` of ${resultCount}`} results">${resultCount ?? "–"}</span>` : ""}<button type="button" class="icon-button" data-manage-collection aria-label="Collection metadata" title="Collection metadata" ${collection ? "" : "disabled"}>${svg("settings")}</button><button type="button" class="icon-button" data-add-objects aria-label="Add objects" title="${collection ? "Add objects" : "Select a collection to add objects"}" ${collection ? "" : "disabled"}>${svg("plus")}</button></header><div class="object-list" role="listbox" aria-label="${collection ? `Objects in ${escape(collection.name)}` : "Objects"}">${objects.map((node) => `<button type="button" class="object-row" role="option" aria-selected="${this._selected === node.key}" aria-label="${escape(node.name)}" data-object="${escape(node.key)}" tabindex="${this._objectFocus === node.key ? "0" : "-1"}"><span class="node-icon">${svg("object")}</span><span class="object-text"><span class="object-label" title="${escape(node.name)}">${escape(node.name)}</span><span class="object-preview">${escape(preview(node.object))}</span></span></button>`).join("") || `<div class="empty-list">${collection ? (collection.loading ? "Loading…" : collection.error ? "Could not load objects" : !collection.loaded ? "Select to load" : collection.query ? "No matches" : "No objects") : "Select a collection"}</div>`}</div>${collection?.error ? `<div class="load-state" role="alert">${escape(collection.error)}<button type="button" data-load-objects>Retry</button></div>` : collection?.loading ? '<div class="load-state" role="status">Loading…</div>' : collection?.hasMore ? '<div class="load-state"><button type="button" data-load-objects data-more="true">Load more</button></div>' : ""}</div>
      <div class="pane viewer" role="region" aria-label="Object JSON"><header class="pane-head"><h2 title="${escape(selected?.name || "")}">${escape(selected?.name || "JSON")}</h2>${selected ? '<span class="dirty-dot" aria-label="Unsaved changes" hidden></span>' : ""}${selected ? `<button type="button" class="icon-button" data-copy aria-label="Copy object JSON" title="Copy JSON">${svg("copy")}</button>` : ""}</header>${selected ? `<textarea class="json" aria-label="JSON for ${escape(selected.name)}" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off">${escape(draft.text)}</textarea><div class="attachment-bar">${svg("attachment")}<span title="${escape(selected.object._file?.mimeType || "")}">${escape(selected.object._file ? selected.object.name || selected.object._file.mimeType || "Attachment" : "No attachment")}</span>${selected.object._file ? `<button type="button" class="icon-button" data-open-file aria-label="Open attachment" title="Open attachment">${svg("open")}</button>` : ""}<button type="button" data-attach-file>${selected.object._file ? "Replace file" : "Attach file"}</button></div><footer class="editor-actions"><button type="button" class="save" data-save>Save</button><button type="button" class="undo" data-undo>Undo</button><button type="button" class="delete" data-delete aria-label="Delete object">Delete</button></footer><div class="editor-status" role="status" aria-live="polite"></div>` : '<div class="empty-view">Select an object</div>'}</div>
      </div></div></div><span class="sr-only" role="status" aria-live="polite"></span></section>`;
    this.shadowRoot.querySelector(".tree").scrollTop = scrolls[0];
    this.shadowRoot.querySelector(".object-list").scrollTop = resetObjects
      ? 0
      : scrolls[1];
    const json = this.shadowRoot.querySelector(".json");
    if (json) {
      json.scrollTop = resetJson ? 0 : scrolls[2];
      if (editing && !resetJson) {
        json.focus({ preventScroll: true });
        json.setSelectionRange(...caret);
      }
    }
    this._updateEditor();
    if (querying && !resetObjects) {
      const input = this.shadowRoot.querySelector(".query-input");
      input.focus({ preventScroll: true });
      input.setSelectionRange(...queryCaret);
    }
  }
  _focus(key, moveFocus = true) {
    const object = this._nodes.get(key)?.type === "object";
    if (object) this._objectFocus = key;
    else this._focused = key;
    for (const button of this.shadowRoot.querySelectorAll(
      object ? "[data-object]" : "[data-node]",
    )) {
      const matches =
        (object ? button.dataset.object : button.dataset.node) === key;
      button.tabIndex = matches ? 0 : -1;
      if (moveFocus && matches) button.focus({ preventScroll: true });
    }
  }
  _toggle(node, expanded = !this._expanded.has(node.key)) {
    expanded ? this._expanded.add(node.key) : this._expanded.delete(node.key);
    this._focused = node.key;
    this._render();
    this._focus(node.key);
  }
  _selectObject(node) {
    this._selected = node.key;
    this._objectFocus = node.key;
    this._render({ resetJson: true });
    this._focus(node.key);
    this._emit("object-select", {
      databaseId: node.databaseId,
      collectionId: node.collectionId,
      object: node.object,
    });
  }
  async _onClick(event) {
    if (event.target.closest("[data-build-query]")) {
      const collection = this._nodes.get(this._collection), state = this._queryState();
      if (!collection || this._busy || state.pending || collection.loading) return;
      return this._emit("build-query", {
        databaseId: collection.databaseId, collectionId: collection.id, text: state.text,
        apply: (query) => {
          if (this._queryState() !== state) throw new Error("The selected collection changed. Reopen the builder.");
          state.text = format(query);
          state.error = "";
          this._render();
          return this.shadowRoot.querySelector(".query-input");
        },
      });
    }
    const scope = event.target.closest("[data-delete-scope]");
    if (scope) {
      if (this._busy) return;
      const node = this._nodes.get(scope.dataset.deleteScope);
      return this._emit("delete-scope", node.type === "database" ? { databaseId: node.id } : { databaseId: node.databaseId, collectionId: node.id });
    }
    if (event.target.closest("[data-clear-query]"))
      return this._runQuery(true);
    const selected = this._nodes.get(this._selected),
      draft = this._draft(selected);
    const attach = event.target.closest("[data-attach-file]"),
      open = event.target.closest("[data-open-file]");
    if (attach || open) {
      if (!selected || selected.readOnly || this._busy || draft.pending || (attach && (draft.text !== draft.base || draft.uncertain))) return;
      return this._emit(attach ? "attach-file" : "open-file", {
        databaseId: selected.databaseId, collectionId: selected.collectionId,
        objectId: selected.object._id ?? selected.object.id, original: JSON.parse(draft.base),
      });
    }
    if (event.target.closest("[data-save]"))
      return this._write("save-object", selected);
    if (event.target.closest("[data-undo]")) {
      if (!draft || this._busy || draft.pending) return;
      if (draft.confirmDelete) {
        draft.confirmDelete = false;
        return this._updateEditor();
      }
      this._drafts.delete(selected.key);
      this._render();
      return;
    }
    if (event.target.closest("[data-delete]")) {
      if (!draft || this._busy || draft.pending || draft.uncertain) return;
      if (draft.confirmDelete) return this._write("delete-object", selected);
      draft.confirmDelete = true;
      draft.error = "";
      this._updateEditor();
      return;
    }
    if (event.target.closest("[data-manage-collection]")) {
      const collection = this._nodes.get(this._collection);
      if (collection)
        this._emit("manage-collection", {
          databaseId: collection.databaseId,
          collectionId: collection.id,
        });
      return;
    }
    const load = event.target.closest("[data-load-objects]");
    if (load) {
      const c = this._nodes.get(this._collection);
      return this._emit("load-objects", {
        databaseId: c.databaseId,
        collectionId: c.id,
        more: load.dataset.more === "true",
      });
    }
    if (event.target.closest("[data-add-database]"))
      return this._emit("create-database");
    if (event.target.closest("[data-add-objects]")) {
      const collection = this._nodes.get(this._collection);
      if (collection)
        this._emit("create-objects", {
          databaseId: collection.databaseId,
          collectionId: collection.id,
        });
      return;
    }
    const addCollection = event.target.closest("[data-add-collection]");
    if (addCollection)
      return this._emit("create-collection", {
        databaseId: this._nodes.get(addCollection.dataset.addCollection).id,
      });
    if (event.target.closest("[data-copy]")) {
      const selected = this._nodes.get(this._selected);
      if (!selected) return;
      try {
        await navigator.clipboard.writeText(this._draft(selected).text);
        if (this._selected !== selected.key) return;
        const button = this.shadowRoot.querySelector("[data-copy]");
        if (button) {
          button.innerHTML = svg("check");
          button.setAttribute("aria-label", "Object JSON copied");
        }
        this.shadowRoot.querySelector('[role="status"]').textContent =
          "JSON copied";
      } catch {
        this.shadowRoot.querySelector('[role="status"]').textContent =
          "Select the JSON and copy it manually.";
        this.shadowRoot.querySelector(".json")?.focus();
      }
      return;
    }
    const button = event.target.closest("[data-node],[data-object]");
    if (!button) return;
    const node = this._nodes.get(
      button.dataset.node || button.dataset.object,
    );
    if (node.type === "database") return this._toggle(node);
    if (node.type === "collection")
      return this.selectCollection(node.databaseId, node.id);
    this._selectObject(node);
  }
  _onKeyDown(event) {
    if (
      event.target.matches(".query-input") &&
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      !event.isComposing
    ) {
      event.preventDefault();
      if (!event.repeat) this._runQuery();
      return;
    }
    if (
      event.target.matches(".json") &&
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === "s"
    ) {
      event.preventDefault();
      this._write("save-object", this._nodes.get(this._selected));
      return;
    }
    const button = event.target.closest("[data-node],[data-object]");
    if (
      !button ||
      ![
        "ArrowDown",
        "ArrowUp",
        "ArrowRight",
        "ArrowLeft",
        "Home",
        "End",
      ].includes(event.key)
    )
      return;
    const node = this._nodes.get(
      button.dataset.node || button.dataset.object,
    );
    event.preventDefault();
    if (node.type === "object") {
      const objects = this._nodes
        .get(node.parent)
        .children.map((key) => this._nodes.get(key));
      const index = objects.indexOf(node);
      if (event.key === "ArrowLeft") return this._focus(node.parent);
      if (event.key === "ArrowRight")
        return this.shadowRoot.querySelector(".json")?.focus();
      const next =
        event.key === "Home"
          ? objects[0]
          : event.key === "End"
            ? objects.at(-1)
            : objects[
                Math.max(
                  0,
                  Math.min(
                    objects.length - 1,
                    index + (event.key === "ArrowDown" ? 1 : -1),
                  ),
                )
              ];
      this._selectObject(next);
    } else {
      const visible = this._visibleNodes(),
        index = visible.indexOf(node);
      let next;
      if (event.key === "ArrowDown")
        next = visible[Math.min(index + 1, visible.length - 1)];
      if (event.key === "ArrowUp") next = visible[Math.max(index - 1, 0)];
      if (event.key === "Home") next = visible[0];
      if (event.key === "End") next = visible.at(-1);
      if (event.key === "ArrowRight") {
        if (node.type === "database") {
          if (!this._expanded.has(node.key)) return this._toggle(node, true);
          next = this._nodes.get(node.children[0]);
        } else {
          this.selectCollection(node.databaseId, node.id);
          next = this._nodes.get(this._objectFocus);
        }
      }
      if (event.key === "ArrowLeft") {
        if (node.type === "database" && this._expanded.has(node.key))
          return this._toggle(node, false);
        next = this._nodes.get(node.parent);
      }
      if (next) this._focus(next.key);
    }
    this.shadowRoot.activeElement?.scrollIntoView({ block: "nearest" });
  }
}
if (!customElements.get("objy-data-explorer"))
  customElements.define("objy-data-explorer", DataExplorer);
