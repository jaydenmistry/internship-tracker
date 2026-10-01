// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/network/actions", () => ({
  draftMessageAction: vi.fn(async () => ({
    ok: true,
    subject: "<b>Payments</b>",
    body: '<img src=x onerror="window.__pwned=true">Hi Sam',
    warning: null,
  })),
  logMessageAction: vi.fn(async () => ({ ok: true })),
}));

import DraftPanel from "@/app/network/[id]/DraftPanel";
import { draftMessageAction, logMessageAction } from "@/app/network/actions";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const base = {
  contactId: "c1",
  contactName: "Sam Lee",
  email: "sam@stripe.com",
  doNotContact: false,
  listings: [],
  availability: { connected: true, reason: null },
  initialType: "COLD" as const,
  initialListingId: null,
  preferLinkedIn: false,
  onClose: () => {},
};

describe("DraftPanel", () => {
  it("drafts into editable fields as text, offers mailto + Copy, and Mark sent sends the edit plus the draft", async () => {
    render(<DraftPanel {...base} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Draft" }));
    });
    expect(draftMessageAction).toHaveBeenCalledWith({ contactId: "c1", type: "COLD", listingId: null, nudge: null });

    const body = screen.getByLabelText("Message") as HTMLTextAreaElement;
    expect(body.value).toContain("<img");
    expect(document.querySelector("[data-testid=draft-panel] img")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeTruthy();

    const mail = screen.getByTestId("mailto").getAttribute("href")!;
    expect(mail.startsWith("mailto:sam@stripe.com?subject=")).toBe(true);
    expect(mail).toContain(encodeURIComponent("<b>Payments</b>"));

    fireEvent.change(body, { target: { value: "My own words" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Mark sent" }));
    });
    const sent = vi.mocked(logMessageAction).mock.calls[0][0] as { contactId: string; message: Record<string, unknown> };
    expect(sent.contactId).toBe("c1");
    expect(sent.message).toMatchObject({
      direction: "OUT",
      type: "COLD",
      channel: "EMAIL",
      body: "My own words",
      draftBody: '<img src=x onerror="window.__pwned=true">Hi Sam',
    });
  });

  it("disables drafting for a do-not-contact contact", () => {
    render(<DraftPanel {...base} doNotContact />);
    expect(screen.queryByRole("button", { name: "Draft" })).toBeNull();
    expect(screen.getByTestId("draft-unavailable").textContent).toMatch(/do-not-contact/);
  });

  it("says Claude isn't connected instead of offering Draft", () => {
    render(<DraftPanel {...base} availability={{ connected: false, reason: "Claude not connected — set the token." }} />);
    expect(screen.queryByRole("button", { name: "Draft" })).toBeNull();
    expect(screen.getByTestId("draft-unavailable").textContent).toMatch(/Claude not connected/);
  });

  it("a LinkedIn note is Copy-only, LinkedIn-only, with a live character count", async () => {
    vi.mocked(draftMessageAction).mockResolvedValueOnce({ ok: true, subject: null, body: "x".repeat(301), warning: "over" });
    render(<DraftPanel {...base} initialType="CONNECT_NOTE" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Draft" }));
    });
    expect(screen.queryByTestId("mailto")).toBeNull();
    expect(screen.queryByLabelText("Subject")).toBeNull();
    expect(screen.getByTestId("length").textContent).toBe("301 / 300");
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });
});

describe("DraftPanel provenance and disclosure", () => {
  it("switching type after drafting drops the draft provenance, so it can't teach the wrong type", async () => {
    render(<DraftPanel {...base} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Draft" }));
    });
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "FOLLOW_UP" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Mark sent" }));
    });
    const sent = vi.mocked(logMessageAction).mock.calls[0][0] as { message: Record<string, unknown> };
    expect(sent.message).toMatchObject({ type: "FOLLOW_UP", draftBody: null });
  });

  it("discloses everything a draft sends", () => {
    render(<DraftPanel {...base} />);
    const text = screen.getByTestId("draft-disclosure").textContent!;
    for (const part of ["name", "notes", "replies", "posting", "resume", "voice notes", "past edited messages"]) {
      expect(text).toContain(part);
    }
  });
});
