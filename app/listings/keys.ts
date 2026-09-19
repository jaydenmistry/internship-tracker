/**
 * Which DOM element is "taking text right now".
 *
 * Single-key shortcuts must never fire while the user is typing, but the guard
 * has to be narrow: a checkbox or radio accepts no characters, and ticking
 * "show dismissed" and then pressing `d` is an ordinary thing to do. Blocking
 * on every INPUT would silently eat that keystroke.
 *
 * SELECT stays blocked — it has its own typeahead and arrow-key behaviour.
 */
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  switch (target.tagName) {
    case "TEXTAREA":
    case "SELECT":
      return true;
    case "INPUT": {
      const type = (target as HTMLInputElement).type.toLowerCase();
      return !NON_TEXT_INPUT_TYPES.has(type);
    }
    default:
      return false;
  }
}

/** A shortcut must never shadow a browser or OS chord. Shift is fine — `?`. */
export function isPlainKey(event: {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): boolean {
  return !event.metaKey && !event.ctrlKey && !event.altKey;
}

/**
 * A control that Enter/Space already activates natively — a button, a link,
 * a summary. The table's Enter ("open the cursor row") must yield to it, or
 * pressing Enter on a detail-panel button would do the wrong thing.
 */
export function isActivatable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  switch (target.tagName) {
    case "BUTTON":
    case "SUMMARY":
      return true;
    case "A":
      return target.hasAttribute("href");
    case "INPUT": {
      const type = (target as HTMLInputElement).type.toLowerCase();
      return type === "button" || type === "submit" || type === "reset" || type === "checkbox" || type === "radio";
    }
    default:
      return target.getAttribute("role") === "button" || target.getAttribute("role") === "menuitem";
  }
}
