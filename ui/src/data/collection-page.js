// Query bodies remain native OBJY JSON. Explicit windows and derived results
// pass through unchanged; ordinary filters use the explorer's paged browsing.
export async function collectionPage(
  adapter,
  database,
  collection,
  limit,
  query = null,
  { previous } = {},
) {
  const body = query || {};
  const direct = [
    "$aggregate",
    "$vector",
    "$limit",
    "$skip",
    "$offset",
    "$page",
    "$pageSize",
    "$cursor",
  ].some((key) => Object.hasOwn(body, key));
  const readOnly =
    Object.hasOwn(body, "$aggregate") ||
    Object.hasOwn(body, "$vector") ||
    Number(body.$refDepth) > 0;
  const refOptions = body.$refDepth === undefined ? { refDepth: 0 } : {};
  const count = previous?.count ?? (await adapter.count(database, collection));
  if (direct) {
    const objects = await adapter.search(
      database,
      collection,
      body,
      refOptions,
    );
    return {
      objects,
      count,
      resultCount: objects.length,
      loaded: true,
      hasMore: false,
      query,
      readOnly,
      directQuery: true,
    };
  }
  const resultCount =
    previous?.resultCount ??
    (query ? await adapter.count(database, collection, body) : count);
  const objects = [...(previous?.objects || [])];
  const positions = new Map(
    objects.map((object, index) => [object._id, index]),
  );
  const start = previous?.nextOffset ?? previous?.objects.length ?? 0;
  let fetched = 0,
    exhausted = false;
  // Append only the new page. Offset tracks server rows, including duplicates
  // caused by concurrent inserts before the current offset. Refresh resets it.
  while (fetched < limit) {
    const size = Math.min(250, limit - fetched);
    const rows = await adapter.search(database, collection, body, {
      ...refOptions,
      limit: size,
      offset: start + fetched,
    });
    fetched += rows.length;
    for (const row of rows) {
      if (row._id != null && positions.has(row._id))
        objects[positions.get(row._id)] = row;
      else {
        if (row._id != null) positions.set(row._id, objects.length);
        objects.push(row);
      }
    }
    if (rows.length < size) {
      exhausted = true;
      break;
    }
  }
  const nextOffset = start + fetched;
  return {
    objects,
    count,
    resultCount,
    loaded: true,
    hasMore: !exhausted && nextOffset < resultCount,
    nextOffset,
    query,
    readOnly,
    directQuery: false,
  };
}
