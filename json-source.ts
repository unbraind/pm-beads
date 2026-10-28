/** Source spans for syntax-validated JSON; opaque values never pass through a number serializer. */
export interface JsonSourceEntry {
  /** Start of an object key or array value, excluding surrounding whitespace. */
  start: number;
  /** Start of the value token, after an object's key and colon. */
  valueStart: number;
  /** Exclusive end of the original value token. */
  end: number;
  /** Decoded object key; omitted for array elements. */
  key?: string;
}

/** Skip JSON whitespace in a source whose syntax has already been validated. */
function whitespace(text: string, start: number): number {
  while (/\s/.test(text[start])) start++;
  return start;
}

/** Locate an entire token without interpreting its numeric or nested object values. */
function valueEnd(text: string, start: number): number {
  if (text[start] === '"') {
    let cursor = start + 1;
    while (text[cursor] !== '"') { if (text[cursor] === "\\") cursor++; cursor++; }
    return cursor + 1;
  }
  if (text[start] === "{" || text[start] === "[") {
    let depth = 1, cursor = start + 1;
    while (depth) {
      if (text[cursor] === '"') { cursor = valueEnd(text, cursor); continue; }
      if (text[cursor] === "{" || text[cursor] === "[") depth++;
      if (text[cursor] === "}" || text[cursor] === "]") depth--;
      cursor++;
    }
    return cursor;
  }
  let cursor = start;
  while (cursor < text.length && !/[\s,}\]]/.test(text[cursor])) cursor++;
  return cursor;
}

/** Enumerate direct members of a syntax-validated object or array, retaining duplicates in source order. */
export function jsonSourceEntries(text: string, start = 0): JsonSourceEntry[] {
  start = whitespace(text, start);
  const object = text[start] === "{", entries: JsonSourceEntry[] = [];
  let cursor = whitespace(text, start + 1);
  while (text[cursor] !== "}" && text[cursor] !== "]") {
    const begin = cursor;
    let key: string | undefined;
    if (object) {
      const end = valueEnd(text, cursor);
      key = JSON.parse(text.slice(cursor, end)) as string;
      cursor = whitespace(text, whitespace(text, end) + 1);
    }
    const end = valueEnd(text, cursor);
    entries.push({ start: begin, valueStart: cursor, end, ...(object ? { key } : {}) });
    cursor = whitespace(text, end);
    if (text[cursor] === ",") cursor = whitespace(text, cursor + 1);
  }
  return entries;
}

/** Replace the effective field, append a new field, or delete every alias occurrence without touching other bytes. */
export function replaceJsonField(text: string, key: string, replacement: string | undefined): string {
  const entries = jsonSourceEntries(text), matching = entries.filter(entry => entry.key === key);
  if (replacement !== undefined) {
    const effective = matching.at(-1);
    if (effective) return text.slice(0, effective.valueStart) + replacement + text.slice(effective.end);
    const previous = entries.at(-1), offset = previous ? previous.end : text.indexOf("{") + 1;
    return text.slice(0, offset) + (previous ? "," : "") + JSON.stringify(key) + ":" + replacement + text.slice(offset);
  }
  const cuts: { start: number; end: number }[] = [];
  for (let index = 0; index < entries.length; index++) {
    if (entries[index].key !== key) continue;
    const first = index;
    while (index + 1 < entries.length && entries[index + 1].key === key) index++;
    for (let member = first; member <= index; member++) cuts.push({ start: entries[member].start, end: entries[member].end });
    const trailing = index + 1 === entries.length;
    for (let comma = trailing && first > 0 ? first - 1 : first; comma <= (trailing ? index - 1 : index); comma++) {
      const offset = whitespace(text, entries[comma].end);
      cuts.push({ start: offset, end: offset + 1 });
    }
  }
  for (const cut of cuts.sort((left, right) => right.start - left.start)) text = text.slice(0, cut.start) + text.slice(cut.end);
  return text;
}

/** Normalize decimal notation exactly, without treating a binary float as the reference value. */
function decimalIdentity(raw: string): string {
  const [mantissa, exponent = "0"] = raw.toLowerCase().split("e"), fraction = mantissa.split(".")[1] ?? "";
  const digits = mantissa.replace(/[-.]/g, "").replace(/^0+/, "");
  if (!digits) return "0";
  const significant = digits.replace(/0+$/, "");
  return `${raw.startsWith("-") ? "-" : ""}${significant}e${Number(exponent) - fraction.length + digits.length - significant.length}`;
}

/** Detect numeric literals a typed JSON envelope cannot emit exactly, before any rounded value is persisted. */
export function hasLossyJsonNumbers(text: string): boolean {
  for (let cursor = 0; cursor < text.length; cursor++) {
    if (text[cursor] === '"') { cursor = valueEnd(text, cursor) - 1; continue; }
    if (!/[-0-9]/.test(text[cursor])) continue;
    const end = valueEnd(text, cursor), raw = text.slice(cursor, end), value = Number(raw);
    if (!Number.isFinite(value) || Object.is(value, -0) || decimalIdentity(raw) !== decimalIdentity(String(value))) return true;
    cursor = end - 1;
  }
  return false;
}
