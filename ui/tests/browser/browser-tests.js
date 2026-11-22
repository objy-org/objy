const frame = document.querySelector("#app"),
  results = document.querySelector("#results"),
  status = document.querySelector("#status");
const doc = () => frame.contentDocument;
const explorer = () => doc().querySelector("objy-data-explorer")?.shadowRoot;
const find = (selector, root = explorer()) => root?.querySelector(selector);
const rows = () => [...explorer().querySelectorAll("[data-object]")];
const assert = (value, message) => {
  if (!value) throw new Error(message);
};
async function until(check, message = "Timed out waiting for UI") {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const result = check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}
function click(selector, root = explorer()) {
  const target = find(selector, root);
  assert(target && !target.disabled, `Missing or disabled: ${selector}`);
  target.focus();
  target.click();
}
function fill(selector, value, root = explorer()) {
  const target = find(selector, root);
  assert(target, `Missing: ${selector}`);
  target.value = value;
  target.dispatchEvent(
    new frame.contentWindow.Event("input", { bubbles: true, composed: true }),
  );
  return target;
}
function captureTabs(win) {
  const open = win.open, tabs = [];
  win.open = () => {
    const tab = { opener: win, document: { body: {} }, closed: false,
      location: { replace(url) { tab.url = url; } }, close() { tab.closed = true; } };
    tabs.push(tab);
    return tab;
  };
  return { tabs, restore() { tabs.forEach(tab => tab.close()); win.open = open; } };
}
function chooseFile(text, name = "note.txt") {
  const transfer = new frame.contentWindow.DataTransfer();
  transfer.items.add(new frame.contentWindow.File([text], name, { type: "text/plain" }));
  const input = find('[name="file"]', doc());
  input.files = transfer.files;
  input.dispatchEvent(new frame.contentWindow.Event("change", { bubbles: true }));
}
function key(target, key, extra = {}) {
  return target.dispatchEvent(
    new frame.contentWindow.KeyboardEvent("keydown", {
      key,
      bubbles: true,
      composed: true,
      cancelable: true,
      ...extra,
    }),
  );
}
async function selectCollection(name) {
  if (!find(`[aria-label="${name}, collection"]`) &&
      find('[aria-label="ui_regression, database"]')?.getAttribute("aria-expanded") === "false")
    click('[aria-label="ui_regression, database"]');
  await until(() => find(`[aria-label="${name}, collection"]`));
  click(`[aria-label="${name}, collection"]`);
  await until(
    () =>
      find(".objects-pane h2")?.textContent === name &&
      !find(".load-state")?.textContent.includes("Loading"),
  );
}
async function runQuery(value, modifier) {
  const input = fill(".query-input", value);
  if (modifier) key(input, "Enter", { [modifier]: true });
  else click("[data-run-query]");
  await until(
    () =>
      !find("[data-run-query]").disabled &&
      !find(".query-message").textContent.includes("Running"),
  );
}
function reload() {
  return new Promise((resolve) => {
    frame.onload = resolve;
    frame.src = "/ui";
  });
}

document.querySelector("#run").addEventListener("click", async (event) => {
  event.target.disabled = true;
  const report = { passed: 0, failed: 0, checks: [] },
    errors = [];
  async function test(name, check) {
    status.textContent = name;
    const item = document.createElement("li");
    results.append(item);
    try {
      await check();
      item.textContent = `✓ ${name}`;
      item.className = "pass";
      report.passed++;
      report.checks.push({ name, passed: true });
    } catch (error) {
      item.textContent = `✗ ${name}: ${error.message}`;
      item.className = "fail";
      report.failed++;
      report.checks.push({ name, passed: false, error: error.message });
      throw error;
    }
  }
  try {
    await reload();
    frame.contentWindow.addEventListener("error", (event) =>
      errors.push(event.message),
    );
    frame.contentWindow.addEventListener("unhandledrejection", (event) =>
      errors.push(String(event.reason)),
    );
    await test("Connect through the actual connection form", async () => {
      await until(() => find("#connection-control", doc()));
      click("#connection-control", doc());
      assert(
        find("[name=url]", doc()).value === location.origin,
        "Hosting server was not prefilled",
      );
      fill("[name=username]", "admin", doc());
      fill("[name=password]", "ui-regression-only", doc());
      click(".modal [type=submit]", doc());
      await until(() => find('[aria-label="ui_regression, database"]'));
      assert(!find(".modal", doc()), "Connection dialog did not close");
    });
    await test("Collection selection and incremental paging retain unique IDs", async () => {
      await selectCollection("items");
      await until(() => rows().length === 50);
      click("[data-load-objects]");
      await until(() => rows().length === 100);
      click("[data-load-objects]");
      await until(() => rows().length === 110);
      assert(
        new Set(rows().map((row) => row.getAttribute("aria-label"))).size ===
          110,
        "Duplicate rows",
      );
      assert(
        !find("[data-load-objects]"),
        "Load more remains after the last page",
      );
    });
    await test("Drafts stay with their object when switching collections; Undo resets them", async () => {
      click('[aria-label="item-000"]');
      const original = find(".json").value;
      fill(
        ".json",
        JSON.stringify({ ...JSON.parse(original), name: "Unsaved" }),
      );
      await selectCollection("other");
      await until(() => rows().length === 1);
      click('[aria-label="other"]');
      assert(
        JSON.parse(find(".json").value).name === "Other collection",
        "Draft leaked into another collection",
      );
      await selectCollection("items");
      click('[aria-label="item-000"]');
      assert(
        JSON.parse(find(".json").value).name === "Unsaved",
        "Draft lost during navigation",
      );
      click("[data-undo]");
      assert(
        find(".json").value === original,
        "Undo did not restore loaded JSON",
      );
    });
    await test("Plain Enter is left to the browser; Command/Ctrl+Enter run multiline queries", async () => {
      const input = fill(".query-input", '{\n  "active": true\n}');
      assert(key(input, "Enter"), "Plain Enter was intercepted");
      await runQuery('{\n  "active": true\n}', "metaKey");
      await until(() => find(".objects-pane .count").textContent === "55");
      assert(
        rows().length === 50 &&
          find(".objects-pane .count").textContent === "55",
        "Command+Enter did not filter",
      );
      await runQuery('{"active":false}', "ctrlKey");
      click('[aria-label="item-001"]');
      assert(
        JSON.parse(find(".json").value).active === false,
        "Ctrl+Enter did not filter",
      );
    });
    await test("Malformed JSON and failed server queries retain results and recover on retry", async () => {
      const previous = rows()
        .map((row) => row.getAttribute("aria-label"))
        .join();
      await runQuery("{broken");
      assert(
        find(".query-message").textContent.includes("valid JSON"),
        "Missing validation message",
      );
      assert(
        rows()
          .map((row) => row.getAttribute("aria-label"))
          .join() === previous,
        "Invalid query changed results",
      );
      await fetch("/__qa/fail-query", { method: "POST" });
      await runQuery('{"active":true}');
      assert(
        find(".query-message").textContent.includes(
          "Previous results were kept",
        ),
        "Missing server error",
      );
      assert(
        rows()
          .map((row) => row.getAttribute("aria-label"))
          .join() === previous,
        "Failed query changed results",
      );
      await runQuery('{"active":true}');
      assert(
        find(".query-message").textContent === "",
        "Retry did not clear error",
      );
      click("[data-clear-query]");
      await until(() => !find("[data-run-query]").disabled);
    });
    await test("Query builder applies filters and grouped counts without losing JSON or running on cancel", async () => {
      const before = rows().map((row) => row.getAttribute("aria-label")).join();
      click("[data-build-query]");
      fill('[aria-label="Filter field"]', "active", doc());
      fill('[aria-label="Value"]', "true", doc());
      click("[data-add-filter]", doc());
      fill('.builder-filter:last-child [aria-label="Filter field"]', "value", doc());
      fill('.builder-filter:last-child [aria-label="Filter operator"]', "$gte", doc());
      fill('.builder-filter:last-child [aria-label="Value"]', "100", doc());
      fill('[name="sortField"]', "value", doc());
      fill('[name="direction"]', "-1", doc());
      click(".modal [type=submit]", doc());
      await until(() => !find(".modal", doc()));
      assert(rows().map((row) => row.getAttribute("aria-label")).join() === before, "Applying ran the query immediately");
      assert(explorer().activeElement === find(".query-input"), "Apply did not return focus to query input");
      await runQuery(find(".query-input").value);
      assert(rows().length === 5 && rows()[0].getAttribute("aria-label") === "item-108", "Builder filters or sorting failed");
      click("[data-build-query]");
      assert(doc().querySelectorAll(".builder-filter").length === 2, "Builder lost existing filter rows");
      const aggregate = fill('[name="aggregate"]', "$count", doc());
      aggregate.dispatchEvent(new frame.contentWindow.Event("change", { bubbles: true }));
      fill('[name="group"]', "active", doc());
      fill('[name="sortField"]', "", doc());
      click(".modal [type=submit]", doc());
      await until(() => !find(".modal", doc()));
      await runQuery(find(".query-input").value);
      assert(rows().length === 1, "Grouped count did not return one result");
      rows()[0].click();
      const result = JSON.parse(find(".json").value);
      assert(result.active === true && result.count === 5 && find(".json").readOnly, "Incorrect or editable aggregation result");
      const saved = find(".query-input").value;
      click("[data-build-query]");
      assert(find('[name="aggregate"]', doc()).value === "$count", "Aggregation did not reopen");
      click("[data-remove-filter]", doc());
      click('[data-action="close-modal"]', doc());
      assert(find(".query-input").value === saved, "Cancel modified the query");
      const advanced = '{"$limit":7,"$sort":{"value":-1}}';
      fill(".query-input", advanced);
      click("[data-build-query]");
      assert(find(".modal", doc()).textContent.includes("simple builder cannot edit") && !find(".modal [type=submit]", doc()), "Unsupported query could be silently overwritten");
      click('[data-action="close-modal"]', doc());
      assert(find(".query-input").value === advanced, "Unsupported query changed");
      await runQuery("{}");
    });
    await test("Save validates JSON and immutable IDs, then persists an edit", async () => {
      click('[aria-label="item-000"]');
      const original = JSON.parse(find(".json").value);
      fill(".json", "{broken");
      click("[data-save]");
      assert(
        find(".editor-status").textContent.includes("valid JSON"),
        "Malformed save accepted",
      );
      fill(".json", JSON.stringify({ ...original, _id: "wrong" }));
      click("[data-save]");
      assert(
        find(".editor-status").textContent.includes("_id"),
        "ID change accepted",
      );
      fill(".json", JSON.stringify({ ...original, name: "Saved in browser" }));
      key(find(".json"), "s", { metaKey: true });
      await until(() => find(".editor-status").textContent === "Saved");
      click('[aria-label="item-001"]');
      click('[aria-label="item-000"]');
      assert(
        JSON.parse(find(".json").value).name === "Saved in browser",
        "Save did not survive reselection",
      );
    });
    await test("Collection metadata is editable through the modal", async () => {
      click("[data-manage-collection]");
      await until(() => find('[aria-label="Collection metadata JSON"]', doc()));
      const value = JSON.parse(find("[name=json]", doc()).value);
      fill(
        "[name=json]",
        JSON.stringify({ ...value, label: "Edited in browser" }),
        doc(),
      );
      click(".modal [type=submit]", doc());
      await until(() => !find(".modal", doc()));
    });
    await test("Delete requires confirmation and removes only the selected object", async () => {
      click("[data-delete]");
      assert(
        find("[data-delete]").textContent === "Confirm delete",
        "Confirmation missing",
      );
      click("[data-undo]");
      assert(find('[aria-label="item-000"]'), "Cancel deleted data");
      click("[data-delete]");
      click("[data-delete]");
      await until(() => !find('[aria-label="item-000"]'));
      assert(
        find(".objects-pane .count").textContent === "109",
        "Delete count did not update",
      );
    });
    await test("Database, collection and object creation work through the forms", async () => {
      click("[data-add-database]");
      fill("[name=name]", "created_in_ui", doc());
      click(".modal [type=submit]", doc());
      await until(
        () =>
          find('[aria-label="created_in_ui, database"]') &&
          !find(".modal", doc()),
      );
      click('[aria-label="Add collection to created_in_ui"]');
      fill("[name=name]", "entries", doc());
      click(".modal [type=submit]", doc());
      await until(
        () =>
          find(".objects-pane h2").textContent === "entries" &&
          !find(".modal", doc()),
      );
      click("[data-add-objects]");
      fill("[name=json]", '{"name":"Created in browser"}', doc());
      click(".modal [type=submit]", doc());
      await until(() => rows().length === 1 && !find(".modal", doc()));
    });
    await test("Attachments upload, replace, download and preserve object fields", async () => {
      click("[data-add-objects]");
      chooseFile("file version 1");
      fill("[name=json]", "[]", doc());
      click(".modal [type=submit]", doc());
      await until(() => !find(".modal .modal-error", doc()).hidden);
      assert(find(".modal .modal-error", doc()).textContent.includes("one JSON object"), "File accepted with an array");
      fill("[name=json]", JSON.stringify({ _id: "attachment", name: "note.txt", nested: { keep: true } }), doc());
      click(".modal [type=submit]", doc());
      await until(() => !find(".modal", doc()) && rows().length === 2);
      click('[aria-label="attachment"]');
      const original = JSON.parse(find(".json").value);
      assert(original._file?.key, "Upload did not attach a file");
      fill(".json", JSON.stringify({ ...original, label: "JSON preserved" }));
      assert(find("[data-attach-file]").disabled, "File replacement allowed with unsaved JSON");
      click("[data-save]");
      await until(() => find(".editor-status").textContent === "Saved");
      click("[data-attach-file]");
      chooseFile("canceled");
      click('[data-action="close-modal"]', doc());
      assert(JSON.parse(find(".json").value)._file.key === original._file.key, "Cancel changed attachment");
      click("[data-attach-file]");
      chooseFile("file version 2", "replacement.txt");
      click(".modal [type=submit]", doc());
      await until(() => !find(".modal", doc()));
      const replaced = JSON.parse(find(".json").value);
      assert(replaced._file.key !== original._file.key && replaced.nested.keep && replaced.label === "JSON preserved", "Replacement lost fields or kept old file");
      // Capture the real SDK download at the native tab boundary.
      const win = frame.contentWindow, create = win.URL.createObjectURL;
      const captured = captureTabs(win);
      let downloaded;
      win.URL.createObjectURL = (blob) => { downloaded = blob; return create.call(win.URL, blob); };
      try {
        click("[data-open-file]");
        await until(() => captured.tabs.at(-1)?.url);
        assert(captured.tabs.at(-1).document.title === "note.txt", "Attachment title lost");
        assert(await downloaded.text() === "file version 2", "Downloaded incorrect bytes");
      } finally {
        captured.restore();
        win.URL.createObjectURL = create;
      }
      rows().find((row) => row.getAttribute("aria-label") !== "attachment").click();
      click("[data-attach-file]");
      chooseFile("", "empty.txt");
      click(".modal [type=submit]", doc());
      await until(() => !find(".modal", doc()));
      assert(JSON.parse(find(".json").value).name === "Created in browser" && JSON.parse(find(".json").value)._file, "Attach to existing object lost fields");
    });
    await test("Collection and database deletion confirm exact scope and clear selection and drafts", async () => {
      click('[aria-label="delete_in_ui, database"]');
      await until(() => find('[aria-label="remove_me, collection"]'));
      click('[aria-label="remove_me, collection"]');
      await until(() => rows().length === 1 && find('[aria-label="file"]'));
      click('[aria-label="file"]');
      fill(".json", '{"_id":"file","unsaved":true}');
      fill(".query-input", '{"unsaved":true}');
      click('[aria-label="Delete collection delete_in_ui/remove_me"]');
      assert(find(".modal [type=submit]", doc()).disabled, "Deletion lacks confirmation");
      fill("[name=confirmation]", "wrong", doc());
      assert(find(".modal [type=submit]", doc()).disabled, "Wrong name accepted");
      click('[data-action="close-modal"]', doc());
      assert(find('[aria-label="remove_me, collection"]') && rows().length === 1, "Cancel deleted collection");
      click('[aria-label="Delete collection delete_in_ui/remove_me"]');
      fill("[name=confirmation]", "remove_me", doc());
      click(".modal [type=submit]", doc());
      await until(() => !find(".modal", doc()) && !find('[aria-label="remove_me, collection"]'));
      assert(!find(".json") && rows().length === 0 && find('[aria-label="keep_me, collection"]'), "Deletion kept selection or removed sibling");
      const view = doc().querySelector("objy-data-explorer").viewState;
      assert(!view.drafts.some(([key]) => key.includes("remove_me")) && !view.queries.some(([key]) => key.includes("remove_me")), "Deleted collection retained drafts");
      click('[aria-label="keep_me, collection"]');
      await until(() => rows().length === 1);
      click('[aria-label="Delete database delete_in_ui"]');
      fill("[name=confirmation]", "delete_in_ui", doc());
      click(".modal [type=submit]", doc());
      await until(() => !find(".modal", doc()) && !find('[aria-label="delete_in_ui, database"]'));
      assert(rows().length === 0 && !find(".json"), "Deleted database left active content");
      assert(find('[aria-label="created_in_ui, database"]'), "Unrelated database removed");
      assert(!find('[aria-label="Delete database _global"]'), "Protected global database has a delete action");
    });
    await test("Attachments open native tabs; executable formats download; closed tabs release URLs", async () => {
      await selectCollection("previews");
      await until(() => rows().length === 6);
      const win = frame.contentWindow, revoke = win.URL.revokeObjectURL, anchorClick = win.HTMLAnchorElement.prototype.click;
      const captured = captureTabs(win), downloaded = [], revoked = [];
      win.URL.revokeObjectURL = (url) => { revoked.push(url); return revoke.call(win.URL, url); };
      win.HTMLAnchorElement.prototype.click = function () { downloaded.push(this.download); };
      try {
        for (const [id, type] of [["png", "image/png"], ["pdf", "application/pdf"], ["broken", "image/png"], ["brokenpdf", "application/pdf"]]) {
          click(`[aria-label="${id}"]`);
          click("[data-open-file]");
          const tab = captured.tabs.at(-1);
          assert(tab, "Tab was not reserved during the click");
          assert(tab.opener === null, "Attachment tab retains an opener");
          await until(() => tab.url);
          assert(!find(".modal", doc()), "Opening an attachment created a viewer modal");
          const response = await fetch(tab.url);
          assert(response.headers.get("content-type") === type, "Native viewer lost the file MIME type");
          assert((await response.blob()).size > 0, "Native tab received empty bytes");
          assert(!revoked.includes(tab.url), "Blob revoked while native viewer remains open");
          tab.close();
          await until(() => revoked.includes(tab.url));
        }
        assert(downloaded.length === 0, "Passive types were forced to download");
        for (const [id, name] of [["html", "pretend-image.jpg"], ["svg", "preview.svg"]]) {
          click(`[aria-label="${id}"]`);
          click("[data-open-file]");
          const tab = captured.tabs.at(-1);
          await until(() => downloaded.at(-1) === name && tab.closed);
          assert(!tab.url, "Executable document was opened with the application's origin");
        }
        win.open = () => null;
        click('[aria-label="png"]');
        click("[data-open-file]");
        await until(() => find("#toast", doc()).textContent.includes("Allow pop-ups"));
        assert(!find(".modal", doc()), "Blocked pop-up left a modal behind");
      } finally {
        captured.restore();
        win.URL.revokeObjectURL = revoke;
        win.HTMLAnchorElement.prototype.click = anchorClick;
      }
    });
    await test("Node statistics use RSS and detailed metrics, refresh manually, and restore focus", async () => {
      await until(
        () =>
          find('[data-action="node-details"]', doc()) &&
          !find("#connection-control", doc()).disabled,
      );
      const requestCount = async () =>
        (await (await fetch("/__qa/config-requests")).json()).count;
      const initialRequests = await requestCount();
      click('[data-action="node-details"]', doc());
      const modal = find(".node-modal", doc());
      assert(
        modal.querySelectorAll("[role=meter]").length === 2,
        "Expected RSS and compression savings meters",
      );
      assert(!modal.textContent.includes("Heap"), "Heap is still displayed");
      for (const text of [
        "Memory · RSS",
        "Index readiness",
        "Active workers",
        "Compression saved",
        "Manual refresh",
      ])
        assert(modal.textContent.includes(text), `Missing ${text}`);
      assert(
        /(?:KiB|MiB|GiB)/.test(
          modal.querySelector(".node-usage-heading strong").textContent,
        ),
        "RSS should show actual bytes",
      );
      const original = find("#node-details", doc()).textContent;
      doc().dispatchEvent(new frame.contentWindow.Event("visibilitychange"));
      frame.contentWindow.dispatchEvent(
        new frame.contentWindow.Event("pagehide"),
      );
      frame.contentWindow.dispatchEvent(
        new frame.contentWindow.Event("pageshow"),
      );
      await new Promise((resolve) => setTimeout(resolve, 16_000));
      assert(
        (await requestCount()) === initialRequests,
        "Statistics refreshed without a user action",
      );
      assert(
        find("#node-details", doc()).textContent === original,
        "Snapshot changed automatically",
      );
      click('[data-action="refresh-node"]', doc());
      await until(
        () =>
          find('[data-action="refresh-node"]', doc()).getAttribute(
            "aria-disabled",
          ) === "false",
      );
      assert(
        (await requestCount()) === initialRequests + 1,
        "Manual refresh should issue one config request",
      );
      assert(
        doc().activeElement.dataset.action === "refresh-node",
        "Refresh lost focus",
      );
      key(find('[aria-label="Close dialog"]', doc()), "Escape");
      assert(!find(".modal", doc()), "Escape did not close modal");
      assert(
        doc().activeElement.dataset.action === "node-details",
        "Focus did not return to pill",
      );
    });
    await test("Large lists keep bounded DOM, keyboard navigation and isolated drafts", async () => {
      const component = doc().createElement("objy-data-explorer");
      component.style.cssText = "position:fixed;inset:0;z-index:9999;width:100%;height:100%";
      component.setAttribute("fill", "");
      doc().body.append(component);
      try {
        const objects = Array.from({ length: 5000 }, (_, i) => ({ _id: `row-${i}`, value: i, payload: "x".repeat(300) }));
        component.databases = [{ id: "perf", collections: [
          { id: "large", objects, count: 5000 }, { id: "other", objects: [{ _id: "other" }] },
        ] }];
        component.selectCollection("perf", "large");
        const root = component.shadowRoot, list = root.querySelector(".object-list");
        const tree = root.querySelector("[data-node]"), query = root.querySelector(".query-input");
        const first = root.querySelector('[aria-label="row-0"]');
        first.click();
        assert(root.querySelector("[data-node]") === tree, "Selection rebuilt the tree");
        assert(root.querySelector(".query-input") === query, "Selection replaced the query input");
        assert(root.querySelector('[aria-label="row-0"]') === first, "Selection rebuilt the object list");
        assert(root.querySelectorAll("[data-object]").length < 80, "Large list was not virtualized");
        const editor = root.querySelector(".json");
        editor.value = '{"_id":"row-0","value":"draft"}';
        editor.dispatchEvent(new frame.contentWindow.Event("input", { bubbles: true }));
        key(first, "End");
        assert(root.activeElement?.getAttribute("aria-label") === "row-4999", "End did not reach the final virtual row");
        assert(JSON.parse(root.querySelector(".json").value).value === 4999, "Wrong last-row JSON");
        key(root.activeElement, "Home");
        assert(root.querySelector(".json").value.includes('"draft"'), "Keyboard navigation lost the draft");
        component.selectCollection("perf", "other");
        // Simulate the host evicting an inactive page, then reloading it.
        component.databases = [{ id: "perf", collections: [
          { id: "large", objects: [], loaded: false }, { id: "other", objects: [{ _id: "other" }] },
        ] }];
        component.databases = [{ id: "perf", collections: [{ id: "large", objects, count: 5000 }] }];
        component.selectCollection("perf", "large");
        root.querySelector('[aria-label="row-0"]').click();
        assert(root.querySelector(".json").value.includes('"draft"'), "Cache eviction lost an unsaved draft");
        list.scrollTop = 150000;
        list.dispatchEvent(new frame.contentWindow.Event("scroll"));
        assert(root.querySelectorAll("[data-object]").length < 80, "Scrolling grew the DOM");
      } finally { component.remove(); }
    });
    await test("Reload restores the saved connection without losing server changes", async () => {
      await reload();
      await until(() => find('[aria-label="ui_regression, database"]'));
      if (
        find('[aria-label="ui_regression, database"]').getAttribute(
          "aria-expanded",
        ) === "false"
      )
        click('[aria-label="ui_regression, database"]');
      await selectCollection("items");
      await until(() => rows().length === 50);
      assert(!find('[aria-label="item-000"]'), "Deleted object returned");
      click("[data-manage-collection]");
      await until(() => find("[name=json]", doc()));
      assert(
        JSON.parse(find("[name=json]", doc()).value).label ===
          "Edited in browser",
        "Metadata did not persist on server",
      );
      click('[aria-label="Close dialog"]', doc());
      assert(errors.length === 0, errors.join("\n"));
    });
  } catch (error) {
    console.error(error);
  }
  status.textContent = `${report.passed} passed, ${report.failed} failed. Verifying server state…`;
  const verified = await (
    await fetch("/__qa/result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    })
  ).json();
  status.textContent = `${report.passed} passed, ${report.failed} failed. Server state ${verified.serverStateVerified ? "verified" : "did not match"}.`;
  status.dataset.result = verified.passed ? "passed" : "failed";
});
