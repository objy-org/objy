import { escapeHTML as esc, icon, parseObjectJSON } from "./markup.js";

export const operators = { $eq: "is", $ne: "is not", $gt: ">", $gte: "≥", $lt: "<", $lte: "≤", $contains: "contains", $in: "one of", $nin: "not one of", $exists: "exists" };
const aggregates = { "": "None", $count: "Count", $sum: "Sum", $avg: "Average", $min: "Minimum", $max: "Maximum" };
const plain = (value) => value && typeof value === "object" && !Array.isArray(value);
const unsupported = () => { throw new Error("This query uses options the simple builder cannot edit. Keep editing it in the JSON input."); };
const fieldName = (value) => {
  if (!value.trim() || value.trim().startsWith("$")) throw new Error("Enter a field name without a leading $.");
  return value.trim();
};
function valueFrom(text) {
  try { return JSON.parse(text); }
  catch {
    if (/^[\s]*[\[{"]/.test(text)) throw new Error("Enter valid JSON for this filter value.");
    return text.trim();
  }
}

export function buildQuery(state) {
  const clauses = state.filters.filter((row) => row.field.trim() || row.value.trim()).map((row) => {
    const field = fieldName(row.field), value = valueFrom(row.value);
    if (!Object.hasOwn(operators, row.op)) throw new Error("Choose a filter operator.");
    if (["$in", "$nin"].includes(row.op) && !Array.isArray(value)) throw new Error('Use an array for “one of”, for example ["active", "pending"].');
    if (row.op === "$exists" && typeof value !== "boolean") throw new Error("Exists needs true or false.");
    return { [field]: { [row.op]: value } };
  });
  const query = clauses.length > 1 ? { [state.mode === "$or" ? "$or" : "$and"]: clauses } : clauses[0] || {};
  let target = query;
  if (state.aggregate) {
    if (!Object.hasOwn(aggregates, state.aggregate)) throw new Error("Choose an aggregation.");
    const alias = fieldName(state.alias || state.aggregate.slice(1));
    if (state.group.trim() === alias) throw new Error(`Group field and result name “${alias}” must differ.`);
    target = query.$aggregate = {
      ...(state.group.trim() ? { groupBy: fieldName(state.group) } : {}),
      fields: { [alias]: { [state.aggregate]: state.aggregate === "$count" ? true : fieldName(state.field) } },
    };
    if (state.sortField.trim() && ![alias, state.group.trim()].includes(state.sortField.trim()))
      throw new Error(`Sort aggregated results by ${[alias, state.group.trim()].filter(Boolean).join(" or ")}.`);
  }
  if (state.sortField.trim()) target.$sort = { [fieldName(state.sortField)]: Number(state.direction) === -1 ? -1 : 1 };
  return query;
}

// Decode only what the controls can represent; never silently discard query options.
export function readQuery(text) {
  const query = parseObjectJSON(text.trim() || "{}"),
    state = { filters: [], mode: "$and", sortField: "", direction: 1, aggregate: "", field: "", group: "", alias: "" };
  const filters = Object.entries(query).filter(([key]) => !["$sort", "$aggregate"].includes(key));
  let terms = filters;
  if (filters.some(([key]) => ["$and", "$or"].includes(key))) {
    if (filters.length !== 1 || !Array.isArray(filters[0][1]) || !filters[0][1].length) unsupported();
    state.mode = filters[0][0];
    terms = filters[0][1].flatMap((term) => {
      if (!plain(term) || Object.keys(term).length !== 1) unsupported();
      return Object.entries(term);
    });
  }
  for (const [field, value] of terms) {
    if (!field || field !== field.trim() || field.startsWith("$") || Array.isArray(value)) unsupported();
    const entries = plain(value) ? Object.entries(value) : [["$eq", value]];
    if (!entries.length || (state.mode === "$or" && entries.length !== 1)) unsupported();
    for (const [op, operand] of entries) {
      if (!Object.hasOwn(operators, op)) unsupported();
      state.filters.push({ field, op, value: JSON.stringify(operand) });
    }
  }
  let sort = query.$sort;
  if (query.$aggregate !== undefined) {
    const aggregate = query.$aggregate;
    if (!plain(aggregate) || Object.keys(aggregate).some((key) => !["groupBy", "fields", "$sort"].includes(key)) || sort !== undefined ||
        !plain(aggregate.fields) || Object.keys(aggregate.fields).length !== 1 || (aggregate.groupBy !== undefined && typeof aggregate.groupBy !== "string")) unsupported();
    const [alias, expression] = Object.entries(aggregate.fields)[0];
    if (!alias || alias !== alias.trim() || !plain(expression) || Object.keys(expression).length !== 1) unsupported();
    const [op, field] = Object.entries(expression)[0];
    if (!op || !Object.hasOwn(aggregates, op) || (op === "$count" ? field !== true : typeof field !== "string")) unsupported();
    Object.assign(state, { aggregate: op, alias, field: op === "$count" ? "" : field, group: aggregate.groupBy || "" });
    sort = aggregate.$sort;
  }
  if (sort !== undefined) {
    if (!plain(sort) || Object.keys(sort).length !== 1 || ![1, -1].includes(Object.values(sort)[0])) unsupported();
    [state.sortField, state.direction] = Object.entries(sort)[0];
  }
  if ([state.field, state.group, state.sortField].some((field) => field !== field.trim())) unsupported();
  buildQuery(state); // Reject values that the controls cannot safely regenerate.
  return state;
}

export function showQueryBuilder(dialog, { text, fields, apply }) {
  let state;
  try { state = readQuery(text); }
  catch (error) {
    dialog.show("Query builder", `<p class="modal-description">${esc(error.message)}</p>`);
    return;
  }
  const options = (values, selected) => Object.entries(values).map(([value, label]) => `<option value="${esc(value)}" ${String(selected) === value ? "selected" : ""}>${esc(label)}</option>`).join("");
  const input = (label, value = "", extra = "") => `<input aria-label="${label}" placeholder="${label}" value="${esc(value)}" ${extra}>`;
  const row = ({ field = "", op = "$eq", value = "" } = {}) => `<div class="builder-filter">${input("Filter field", field, 'list="builder-fields"')}<select aria-label="Filter operator">${options(operators, op)}</select>${input("Value", value, 'title="Text or JSON. Quote numeric text; use arrays for one of."')}<button type="button" data-remove-filter aria-label="Remove filter">${icon("close")}</button></div>`;
  const modal = dialog.show("Query builder", `<form class="query-builder">
    <datalist id="builder-fields">${fields.map((field) => `<option value="${esc(field)}"></option>`).join("")}</datalist>
    <div class="builder-heading"><span>Filters</span><div class="builder-logic" role="radiogroup" aria-label="Combine filters">${["$and", "$or"].map((mode) => `<label title="${mode === "$and" ? "Every filter must match" : "At least one filter must match"}"><input type="radio" name="mode" value="${mode}" ${state.mode === mode ? "checked" : ""}><span>${mode.slice(1).toUpperCase()}</span></label>`).join("")}</div><button type="button" data-add-filter aria-label="Add filter">${icon("plus")}</button></div>
    <div class="builder-filters">${(state.filters.length ? state.filters : [{}]).map(row).join("")}</div>
    <div class="builder-row"><span>Summarize</span><select name="aggregate" aria-label="Aggregation">${options(aggregates, state.aggregate)}</select>${input("Aggregate field", state.field, 'name="field" list="builder-fields"')}</div>
    <div class="builder-row" data-group><span>Group by</span>${input("Group field", state.group, 'name="group" list="builder-fields"')}<span class="builder-result"></span></div>
    <div class="builder-row"><span>Sort by</span>${input("Sort field", state.sortField, 'name="sortField" list="builder-sort-fields"')}<select name="direction" aria-label="Sort direction">${options({ 1: "Ascending", "-1": "Descending" }, state.direction)}</select></div>
    <datalist id="builder-sort-fields"></datalist>
    <div class="modal-actions"><button type="button" class="secondary-btn" data-action="close-modal">Cancel</button><button type="submit" class="primary-btn">Apply query</button></div>
  </form>`, () => {
    for (const name of ["mode", "aggregate", "field", "group", "sortField", "direction"]) state[name] = form.elements[name].value;
    state.filters = [...form.querySelectorAll(".builder-filter")].map((row) => {
      const [field, op, value] = row.querySelectorAll("input,select");
      return { field: field.value, op: op.value, value: value.value };
    });
    dialog.returnFocus = apply(buildQuery(state));
    dialog.close(true);
  }, { className: "query-builder-modal" });
  const form = modal.querySelector("form");
  const update = () => {
    form.querySelector(".builder-filters").dataset.mode = form.elements.mode.value;
    const aggregate = form.elements.aggregate.value, grouped = Boolean(aggregate);
    form.elements.field.hidden = !aggregate || aggregate === "$count";
    modal.querySelector("[data-group]").hidden = !grouped;
    const alias = state.alias || aggregate.slice(1);
    modal.querySelector(".builder-result").textContent = `→ ${alias}`;
    const suggestions = grouped ? [alias, form.elements.group.value].filter(Boolean) : fields;
    modal.querySelector("#builder-sort-fields").innerHTML = suggestions.map((field) => `<option value="${esc(field)}"></option>`).join("");
  };
  form.querySelector(".builder-logic").addEventListener("change", update);
  form.elements.aggregate.addEventListener("change", () => { state.alias = ""; update(); });
  form.elements.group.addEventListener("input", update);
  form.querySelector("[data-add-filter]").addEventListener("click", () => {
    form.querySelector(".builder-filters").insertAdjacentHTML("beforeend", row());
    form.querySelector(".builder-filter:last-child input").focus();
  });
  form.addEventListener("click", (event) => {
    event.target.closest("[data-remove-filter]")?.closest(".builder-filter").remove();
  });
  update();
}
