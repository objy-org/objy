import { compareSortValues, getPathValue } from "./query.js";

export function compareOrderKeys(left, leftId, right, rightId, direction = 1) {
  return compareSortValues(left, right) * direction || compareSortValues(String(leftId), String(rightId));
}

export function objectOrder(options = {}) {
  const direction = options.sort === "desc" ? -1 : 1;
  return (left, right) => compareOrderKeys(
    getPathValue(left, options.sortBy), left._id,
    getPathValue(right, options.sortBy), right._id,
    direction,
  );
}

// Keep only the requested prefix; full object bodies never belong in this heap.
export function selectOrdered(values, compare, { offset = 0, limit = Infinity } = {}) {
  if (limit <= 0) return [];
  const size = offset + limit;
  if (!Number.isFinite(size)) return [...values].sort(compare).slice(offset);
  const heap = [];
  const worstFirst = (left, right) => compare(right, left);
  for (const value of values) {
    if (heap.length < size) heapPush(heap, value, worstFirst);
    else if (compare(value, heap[0]) < 0) heapReplace(heap, value, worstFirst);
  }
  return heap.sort(compare).slice(offset);
}

export function* mergeOrdered(streams, compare) {
  const heap = [];
  const compareHeads = (left, right) => compare(left.value, right.value);
  for (const stream of streams) {
    const iterator = stream[Symbol.iterator]();
    const head = iterator.next();
    if (!head.done) heapPush(heap, { value: head.value, iterator }, compareHeads);
  }
  while (heap.length) {
    const head = heap[0];
    yield head.value;
    const next = head.iterator.next();
    if (next.done) {
      const last = heap.pop();
      if (heap.length) heapReplace(heap, last, compareHeads);
    } else {
      heapReplace(heap, { value: next.value, iterator: head.iterator }, compareHeads);
    }
  }
}

function heapPush(heap, value, compare) {
  let index = heap.length;
  heap.push(value);
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (compare(heap[parent], value) <= 0) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = value;
}

function heapReplace(heap, value, compare) {
  let index = 0;
  for (;;) {
    let child = index * 2 + 1;
    if (child >= heap.length) break;
    if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) < 0) child++;
    if (compare(value, heap[child]) <= 0) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = value;
}
