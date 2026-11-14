export function objectValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object.");
  return value;
}

export function sameJSON(a, b) {
  const normalize = (value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, normalize(value[key])]),
        )
      : Array.isArray(value)
        ? value.map(normalize)
        : value;
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
