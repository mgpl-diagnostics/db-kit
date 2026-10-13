/** JSON that keeps Dates (as {"$d": iso}), so cached entities come back with real Date fields. */
export function encode(value: unknown): string {
  return JSON.stringify(value, function (this: any, key, val) {
    const raw = this[key];
    return raw instanceof Date ? { $d: raw.toISOString() } : val;
  });
}

export function decode<T>(text: string): T {
  return JSON.parse(text, (_key, val) =>
    val && typeof val === "object" && typeof val.$d === "string" && Object.keys(val).length === 1 ? new Date(val.$d) : val,
  );
}
