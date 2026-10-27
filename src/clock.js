export function makeClock(id) {
  return { c: 0, n: id };
}

export function nextTs(clock) {
  return { c: ++clock.c, n: clock.n };
}

export function touch(clock, ts) {
  if (ts && ts.c > clock.c) clock.c = ts.c;
}

export function gt(a, b) {
  if (!a) return true;
  if (!b) return a != null;
  if (a.c !== b.c) return a.c > b.c;
  return a.n > b.n;
}
