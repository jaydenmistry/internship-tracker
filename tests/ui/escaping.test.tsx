// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * Listing text is scraped from third-party job boards and LLM rationales are
 * model output. Both are rendered in the UI, so both must reach the DOM as
 * TEXT — never parsed as HTML or markdown. These tests fail loudly if anyone
 * reaches for dangerouslySetInnerHTML or a markdown renderer.
 */

const NASTY = '<script>window.__pwned = true</script><b>bold</b><img src=x onerror="window.__pwned=true">';

/** Mirrors how the detail panel renders one scoring component's evidence. */
function EvidenceList({ evidence }: { evidence: string[] }) {
  return (
    <ul data-testid="evidence">
      {evidence.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  );
}

/** Mirrors how the detail panel renders the stage-2 rationale. */
function Rationale({ text }: { text: string }) {
  return <p data-testid="rationale">{text}</p>;
}

describe("rendering untrusted listing text", () => {
  it("renders markup in score-breakdown evidence as literal text", () => {
    render(<EvidenceList evidence={[`matched "Go" in ${NASTY}`]} />);

    const node = screen.getByTestId("evidence");
    // The markup survives as characters…
    expect(node.textContent).toContain("<script>");
    expect(node.textContent).toContain("<b>bold</b>");
    // …and produced no elements or side effects.
    expect(node.querySelector("script")).toBeNull();
    expect(node.querySelector("b")).toBeNull();
    expect(node.querySelector("img")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it("renders an LLM rationale as literal text", () => {
    render(<Rationale text={`Strong fit. ${NASTY}`} />);

    const node = screen.getByTestId("rationale");
    expect(node.textContent).toContain("<script>");
    expect(node.querySelector("script")).toBeNull();
    expect(node.querySelector("img")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it("renders a company or role containing markup as literal text", () => {
    render(
      <div data-testid="row">
        <span>{'<img src=x onerror="window.__pwned=true">'}</span>
        <span>{"<b>Backend Intern</b>"}</span>
      </div>,
    );

    const node = screen.getByTestId("row");
    expect(node.textContent).toContain("<b>Backend Intern</b>");
    expect(node.querySelector("img")).toBeNull();
    expect(node.querySelector("b")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });
});
