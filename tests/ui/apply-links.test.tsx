// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The actions module imports Prisma; the panel only needs callable stubs.
vi.mock("@/app/listings/actions", () => ({
  assessListingAction: vi.fn(async () => ({ ok: true })),
  setApplyLinkAction: vi.fn(async () => ({ ok: false, message: "That's still jobright's page." })),
}));

import { setApplyLinkAction } from "@/app/listings/actions";
import DetailPanel from "@/app/listings/DetailPanel";
import { detailFixture, rowFixture } from "./fixtures/listing-detail";

afterEach(cleanup);

const JOBRIGHT = "https://jobright.ai/jobs/info/6aad91e7de327d3e210d33d9";

function renderPanel(links: { url: string; jobrightUrl: string | null }) {
  const d = detailFixture(links);
  render(
    <DetailPanel
      row={rowFixture({ id: d.id, ...links })}
      load={{ status: "ready", detail: d, refreshing: false }}
      now={Date.now()}
      onCommand={() => {}}
      onSaveNotes={async () => ({ ok: true })}
      onRetry={() => {}}
      onClose={() => {}}
    />,
  );
}

describe("apply links", () => {
  it("goes straight to the employer's posting, with jobright's page one click away", () => {
    renderPanel({ url: "https://job-boards.greenhouse.io/togetherai/jobs/4977391007", jobrightUrl: JOBRIGHT });
    expect(screen.getByRole("link", { name: /open the job posting/i })).toHaveProperty(
      "href",
      "https://job-boards.greenhouse.io/togetherai/jobs/4977391007",
    );
    expect(screen.getByRole("link", { name: /view on jobright/i })).toHaveProperty("href", JOBRIGHT);
    expect(screen.queryByLabelText(/employer.s link/i)).toBeNull();
  });

  it("shows no jobright link for a listing jobright doesn't carry", () => {
    renderPanel({ url: "https://jobs.lever.co/acme/1", jobrightUrl: null });
    expect(screen.queryByRole("link", { name: /jobright/i })).toBeNull();
  });

  it("asks for the employer's link when jobright's page is all there is", async () => {
    renderPanel({ url: JOBRIGHT, jobrightUrl: JOBRIGHT });
    expect(screen.getByRole("link", { name: /open on jobright/i })).toHaveProperty("href", JOBRIGHT);
    expect(screen.queryByRole("link", { name: /view on jobright/i })).toBeNull();

    const input = screen.getByLabelText(/employer.s link/i);
    fireEvent.change(input, { target: { value: `${JOBRIGHT}?jr_id=1` } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save link/i }));
    });
    expect(setApplyLinkAction).toHaveBeenCalledWith({ listingId: "l1", url: `${JOBRIGHT}?jr_id=1` });
    expect(screen.getByRole("alert").textContent).toContain("still jobright");
  });

  it("never links a jobright url that isn't http(s)", () => {
    renderPanel({ url: "https://jobs.lever.co/acme/1", jobrightUrl: "javascript:alert(1)" });
    expect(screen.queryByRole("link", { name: /jobright/i })).toBeNull();
  });
});
