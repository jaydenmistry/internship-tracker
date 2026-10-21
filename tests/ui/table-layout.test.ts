import { describe, expect, it } from "vitest";
import {
  COLUMN_DEFS,
  compactColumns,
  DEFAULT_LAYOUT,
  dragShifts,
  dropIndex,
  gridTemplate,
  MAX_COLUMN_WIDTH,
  moveColumn,
  parseLayout,
  resizeColumn,
  serializeLayout,
  toggleColumn,
  toggleToolbarItem,
  visibleColumns,
  type TableLayout,
} from "@/app/listings/table-layout";

const DEFAULT_ORDER = COLUMN_DEFS.map((c) => c.id);
const cookie = (value: unknown) => encodeURIComponent(JSON.stringify(value));

describe("parseLayout — the cookie is untrusted", () => {
  it("falls back to the default for nothing, garbage and the wrong shape", () => {
    for (const raw of [undefined, null, "", "%", "not json", cookie([1, 2]), cookie({ o: "rank" }), cookie({ w: { rank: "wide" } })]) {
      expect(parseLayout(raw)).toEqual(DEFAULT_LAYOUT);
    }
  });

  it("round-trips through serializeLayout, encoded or already decoded", () => {
    let layout: TableLayout = moveColumn(DEFAULT_LAYOUT, "company", 4);
    layout = toggleColumn(layout, "source");
    layout = resizeColumn(layout, "location", 220);
    layout = toggleToolbarItem(layout, "f-term");
    const raw = serializeLayout(layout);
    expect(parseLayout(raw)).toEqual(layout);
    expect(parseLayout(decodeURIComponent(raw))).toEqual(layout);
  });

  it("writes nothing for the default layout", () => {
    expect(decodeURIComponent(serializeLayout(DEFAULT_LAYOUT))).toBe("{}");
  });

  it("drops unknown and duplicate ids and restores missing columns in their default place", () => {
    const layout = parseLayout(cookie({ o: ["score", "rank", "<script>", "score", "role"], h: ["nope", "age", "age"], t: ["f-term", "bogus"] }));
    // company follows score, its default predecessor, wherever score now is.
    expect(layout.order).toEqual(["score", "company", "rank", "role", "location", "age", "deadline", "status", "source"]);
    expect(layout.hidden).toEqual(["age"]);
    expect(layout.toolbarHidden).toEqual(["f-term"]);
  });

  it("never hides the locked role column", () => {
    expect(parseLayout(cookie({ h: ["role", "company"] })).hidden).toEqual(["company"]);
    expect(toggleColumn(DEFAULT_LAYOUT, "role")).toBe(DEFAULT_LAYOUT);
  });

  it("clamps widths and ignores unknown columns", () => {
    const { widths } = parseLayout(cookie({ w: { location: 5, company: 1e9, ghost: 100 } }));
    expect(widths).toEqual({ location: 64, company: MAX_COLUMN_WIDTH });
  });
});

describe("moveColumn", () => {
  it("moves among the visible columns and keeps hidden ones in place", () => {
    const layout = toggleColumn(DEFAULT_LAYOUT, "location");
    // visible: rank score company role age deadline status source
    const moved = moveColumn(layout, "company", 4); // after age
    expect(visibleColumns(moved).map((c) => c.id)).toEqual(["rank", "score", "role", "age", "company", "deadline", "status", "source"]);
    expect(moved.order.indexOf("location")).toBe(moved.order.indexOf("role") + 1);
  });

  it("moves to either end", () => {
    expect(moveColumn(DEFAULT_LAYOUT, "source", 0).order[0]).toBe("source");
    expect(moveColumn(DEFAULT_LAYOUT, "rank", 99).order.at(-1)).toBe("rank");
    expect(moveColumn(DEFAULT_LAYOUT, "rank", 0)).toBe(DEFAULT_LAYOUT);
  });
});

describe("dragging", () => {
  // Three 100px columns 10px apart, then a 50px one.
  const rects = [
    { left: 0, width: 100 },
    { left: 110, width: 100 },
    { left: 220, width: 100 },
    { left: 330, width: 50 },
  ];

  it("passes a neighbour once its leading edge crosses the neighbour's midpoint", () => {
    expect(dropIndex(rects, 0, 0)).toBe(0);
    expect(dropIndex(rects, 0, 59)).toBe(0);
    expect(dropIndex(rects, 0, 61)).toBe(1);
    expect(dropIndex(rects, 2, -59)).toBe(2);
    expect(dropIndex(rects, 2, -61)).toBe(1);
    expect(dropIndex(rects, 0, 400)).toBe(3);
    expect(dropIndex(rects, 3, -400)).toBe(0);
  });

  it("slides passed columns by exactly where the committed order puts them", () => {
    // Column 0 dragged to index 2: columns 1 and 2 move left by 110, and the
    // dragged one rests where column 2 ended.
    expect(dragShifts(rects, 0, 2, 10)).toEqual([220, -110, -110, 0]);
    // The narrow last column dragged to the front pushes the rest right by 60.
    expect(dragShifts(rects, 3, 0, 10)).toEqual([60, 60, 60, -330]);
    expect(dragShifts(rects, 1, 1, 10)).toEqual([0, 0, 0, 0]);
  });
});

describe("templates", () => {
  it("gives role the leftover space and every other column a fixed width", () => {
    const template = gridTemplate(resizeColumn(DEFAULT_LAYOUT, "company", 240)).split(" ");
    expect(template[2]).toBe("240px");
    expect(template[3]).toMatch(/^minmax\(\d+px,$/);
  });

  it("keeps the phone layout to the core columns, in the user's order", () => {
    const layout = moveColumn(DEFAULT_LAYOUT, "company", 0);
    expect(compactColumns(layout).map((c) => c.id)).toEqual(["company", "rank", "score", "role"]);
    // A hidden core column leaves the phone layout too, or the template
    // would have a track with no cell in it.
    expect(compactColumns(toggleColumn(layout, "score")).map((c) => c.id)).toEqual(["company", "rank", "role"]);
    expect(DEFAULT_ORDER).toHaveLength(9);
  });
});
