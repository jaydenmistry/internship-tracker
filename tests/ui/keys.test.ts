// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isEditable, isPlainKey } from "@/app/listings/keys";

/**
 * The single-key shortcuts live on `window`, so the guard in front of them is
 * the only thing standing between "d" meaning "dismiss" and "d" landing in the
 * middle of a search term.
 */

function el(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.firstElementChild as HTMLElement;
}

describe("isEditable", () => {
  it("blocks shortcuts inside text fields", () => {
    expect(isEditable(el('<input type="text">'))).toBe(true);
    expect(isEditable(el('<input type="search">'))).toBe(true);
    expect(isEditable(el('<input type="number">'))).toBe(true);
    expect(isEditable(el("<input>"))).toBe(true); // type defaults to text
    expect(isEditable(el("<textarea></textarea>"))).toBe(true);
  });

  it("blocks shortcuts inside a select, which has its own typeahead", () => {
    expect(isEditable(el("<select><option>a</option></select>"))).toBe(true);
  });

  it("blocks shortcuts inside contenteditable", () => {
    const node = el('<div contenteditable="true"></div>');
    // jsdom does not implement isContentEditable from the attribute.
    Object.defineProperty(node, "isContentEditable", { value: true });
    expect(isEditable(node)).toBe(true);
  });

  it("allows shortcuts when a checkbox or radio has focus", () => {
    // Ticking "show dismissed" and then pressing `d` must not be swallowed.
    expect(isEditable(el('<input type="checkbox">'))).toBe(false);
    expect(isEditable(el('<input type="radio">'))).toBe(false);
  });

  it("allows shortcuts on buttons, links and the body", () => {
    expect(isEditable(el("<button>go</button>"))).toBe(false);
    expect(isEditable(el('<input type="submit">'))).toBe(false);
    expect(isEditable(el('<a href="#">x</a>'))).toBe(false);
    expect(isEditable(document.body)).toBe(false);
  });

  it("is safe with a null or non-element target", () => {
    expect(isEditable(null)).toBe(false);
    expect(isEditable(document)).toBe(false);
  });
});

describe("isPlainKey", () => {
  it("rejects browser and OS chords", () => {
    expect(isPlainKey({ metaKey: true, ctrlKey: false, altKey: false })).toBe(false);
    expect(isPlainKey({ metaKey: false, ctrlKey: true, altKey: false })).toBe(false);
    expect(isPlainKey({ metaKey: false, ctrlKey: false, altKey: true })).toBe(false);
  });

  it("accepts an unmodified key, and Shift, so `?` still works", () => {
    expect(isPlainKey({ metaKey: false, ctrlKey: false, altKey: false })).toBe(true);
  });
});
