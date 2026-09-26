// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/network/actions", () => ({
  editMessageAction: vi.fn(async () => ({ ok: true })),
  deleteMessageAction: vi.fn(async () => ({ ok: true })),
}));

import Timeline from "@/app/network/[id]/Timeline";

afterEach(cleanup);

const NASTY = '<img src=x onerror="window.__pwned=true"><b>bold</b><script>window.__pwned=true</script>';

describe("timeline", () => {
  it("renders subjects, bodies and listing titles as text", () => {
    render(
      <Timeline
        timeZone="America/New_York"
        messages={[
          {
            id: "m1",
            direction: "IN",
            channel: "EMAIL",
            type: "REPLY",
            subject: NASTY,
            body: `${NASTY}\nsecond line`,
            sentAt: "2026-09-25T16:00:00.000Z",
            listing: { id: "l1", title: NASTY },
            drafted: false,
          },
        ]}
      />,
    );
    const list = screen.getByTestId("timeline");
    expect(list.textContent).toContain("<script>");
    expect(list.querySelector("img, b, script")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    const item = within(list).getByTestId("timeline-item");
    expect(item.textContent).toContain("They replied");
    expect(item.textContent).toContain("Sep 25, 2026");
  });

  it("says so when nothing is logged", () => {
    render(<Timeline timeZone="UTC" messages={[]} />);
    expect(screen.getByText("Nothing logged yet.")).toBeTruthy();
  });
});
