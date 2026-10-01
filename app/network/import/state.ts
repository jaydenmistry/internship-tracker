/**
 * Pure selection logic for the contacts import review. Rows are keyed by
 * their line number in the pasted text, which is unique per parse.
 */

export function initialSelection(rows: ReadonlyArray<{ lineNumber: number; duplicate: unknown }>): Set<number> {
  // Duplicates start unticked: importing the same person twice is the
  // mistake worth a click to make.
  return new Set(rows.filter((r) => !r.duplicate).map((r) => r.lineNumber));
}

export function toggleRow(selected: ReadonlySet<number>, lineNumber: number): Set<number> {
  const next = new Set(selected);
  if (next.has(lineNumber)) next.delete(lineNumber);
  else next.add(lineNumber);
  return next;
}
