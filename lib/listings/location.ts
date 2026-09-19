/**
 * Pure location helpers shared by every read model (table, tracker, detail).
 * Kept free of Prisma so client components can import them.
 */

const US_STATE_RE =
  /\b(A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[DLNA]|K[SY]|LA|M[EDAINSOT]|N[EVHJMYCD]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[TA]|W[AVIY])\b/;

/**
 * The location to show for a multi-location posting: a US one wins when the
 * listing has one. These are multi-country postings, and showing "Canada"
 * first for a role that is also in Santa Clara reads as ineligible when it isn't.
 */
export function primaryLocation(locations: string[], remote: boolean): string {
  if (remote) return "Remote";
  if (locations.length === 0) return "—";
  return (
    locations.find((l) => US_STATE_RE.test(l) || /\b(USA|United States|US)\b/i.test(l)) ??
    locations[0]
  );
}
