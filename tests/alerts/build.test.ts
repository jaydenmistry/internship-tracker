import { describe, expect, it } from "vitest";
import {
  buildAlerts,
  buildClosingSoonAlerts,
  buildDailyDigest,
  buildHighScoreAlerts,
  escapeDiscord,
  isAlertable,
  safeHttpUrl,
} from "@/lib/alerts/build";
import { parseAlertSettings, DEFAULT_ALERT_SETTINGS } from "@/lib/alerts/settings";
import { daysFromNow, listing, NOW, settings, TZ } from "./fixtures";

const o = { now: NOW, timeZone: TZ };

describe("eligibility (every kind)", () => {
  const excluded = [
    { flag: "dismissed", l: listing({ id: "d", score: 99, dismissed: true }) },
    { flag: "disqualified", l: listing({ id: "q", score: 99, disqualified: true }) },
    { flag: "likelyClosed", l: listing({ id: "c", score: 99, likelyClosed: true }) },
  ];

  for (const { flag, l } of excluded) {
    it(`excludes ${flag} listings from every alert kind`, () => {
      expect(isAlertable(l)).toBe(false);
      // Give it every reason to qualify: top score, saved, deadline tomorrow.
      const candidate = { ...l, saved: true, deadline: daysFromNow(1) };
      const s = settings({ digestMinScore: 0, highScoreMin: 0 });
      expect(buildDailyDigest([candidate], s, o)).toBeNull();
      expect(buildHighScoreAlerts([candidate], s, o)).toHaveLength(0);
      expect(buildClosingSoonAlerts([candidate], s, o)).toHaveLength(0);
    });
  }
});

describe("buildDailyDigest", () => {
  const s = settings({ digestMinScore: 70, digestLookbackHours: 24 });

  it("includes listings first seen inside the lookback that clear the score", () => {
    const digest = buildDailyDigest(
      [
        listing({ id: "in", score: 88, firstSeen: new Date("2026-09-20T02:00:00Z") }),
        listing({ id: "low", score: 69, firstSeen: new Date("2026-09-20T02:00:00Z") }),
        listing({ id: "old", score: 95, firstSeen: new Date("2026-09-18T02:00:00Z") }),
      ],
      s,
      o,
    );

    expect(digest).not.toBeNull();
    expect(digest!.listingIds).toEqual(["in"]);
    expect(digest!.subject).toContain("1 new role scoring 70+");
  });

  it("returns null when nothing qualifies, so the day's key is not burned", () => {
    expect(buildDailyDigest([listing({ id: "low", score: 10 })], s, o)).toBeNull();
  });

  it("treats an unscored listing as not qualifying", () => {
    expect(buildDailyDigest([listing({ id: "n", score: null })], s, o)).toBeNull();
  });

  it("orders by score and caps the body, counting the remainder", () => {
    const many = [40, 95, 80, 90, 75].map((score, i) => listing({ id: `l${i}`, score }));
    const digest = buildDailyDigest(many, settings({ digestMinScore: 70, maxItemsPerDigest: 2 }), o)!;

    expect(digest.listingIds).toEqual(["l1", "l3"]); // 95, then 90
    expect(digest.text).toContain("…and 2 more in the app.");
    expect(digest.subject).toContain("4 new roles");
  });

  it("carries no listingId — a digest spans many listings", () => {
    const digest = buildDailyDigest([listing({ id: "a", score: 90 })], s, o)!;
    expect(digest.listingId).toBeNull();
    expect(digest.baseKey).toBe("2026-09-20");
  });
});

describe("buildHighScoreAlerts", () => {
  it("fires at the threshold, not above it", () => {
    const alerts = buildHighScoreAlerts(
      [listing({ id: "at", score: 85 }), listing({ id: "below", score: 84 })],
      settings({ highScoreMin: 85 }),
      o,
    );
    expect(alerts.map((a) => a.listingId)).toEqual(["at"]);
  });

  it("keys on the listing id and names the listing in the subject", () => {
    const [alert] = buildHighScoreAlerts(
      [listing({ id: "x1", score: 91, company: "Anduril", title: "SWE Intern" })],
      settings({ highScoreMin: 85 }),
      o,
    );
    expect(alert.baseKey).toBe("x1");
    expect(alert.subject).toBe("High match 91: Anduril — SWE Intern");
    expect(alert.text).toContain("https://jobs.example.test/x1");
  });
});

describe("buildClosingSoonAlerts", () => {
  const s = settings({ closingSoonDays: 7, highScoreMin: 85 });

  it("includes saved listings and high scorers, and nothing else", () => {
    const alerts = buildClosingSoonAlerts(
      [
        listing({ id: "saved", score: 40, saved: true, deadline: daysFromNow(3) }),
        listing({ id: "high", score: 90, deadline: daysFromNow(3) }),
        listing({ id: "meh", score: 60, deadline: daysFromNow(3) }),
      ],
      s,
      o,
    );
    expect(alerts.map((a) => a.listingId).sort()).toEqual(["high", "saved"]);
  });

  it("excludes anything with a submitted application", () => {
    const alerts = buildClosingSoonAlerts(
      [listing({ id: "done", saved: true, deadline: daysFromNow(2), applied: true })],
      s,
      o,
    );
    expect(alerts).toHaveLength(0);
  });

  it("covers the window inclusively and drops past deadlines", () => {
    const alerts = buildClosingSoonAlerts(
      [
        listing({ id: "today", saved: true, deadline: new Date("2026-09-20T00:00:00Z") }),
        listing({ id: "edge", saved: true, deadline: daysFromNow(7) }),
        listing({ id: "beyond", saved: true, deadline: daysFromNow(8) }),
        listing({ id: "past", saved: true, deadline: daysFromNow(-1) }),
        listing({ id: "none", saved: true, deadline: null }),
      ],
      s,
      o,
    );
    // "today" is a deadline at midnight this morning: still today, still alertable.
    expect(alerts.map((a) => a.listingId)).toEqual(["today", "edge"]);
  });

  it("sorts by deadline, soonest first", () => {
    const alerts = buildClosingSoonAlerts(
      [
        listing({ id: "later", saved: true, deadline: daysFromNow(5) }),
        listing({ id: "sooner", saved: true, deadline: daysFromNow(1) }),
      ],
      s,
      o,
    );
    expect(alerts.map((a) => a.listingId)).toEqual(["sooner", "later"]);
    expect(alerts[0].subject).toContain("Closing tomorrow");
  });

  it("keys on listing + deadline so a moved deadline re-alerts", () => {
    const first = buildClosingSoonAlerts(
      [listing({ id: "m", saved: true, deadline: daysFromNow(2) })],
      s,
      o,
    )[0];
    const moved = buildClosingSoonAlerts(
      [listing({ id: "m", saved: true, deadline: daysFromNow(5) })],
      s,
      o,
    )[0];
    expect(moved.baseKey).not.toBe(first.baseKey);
  });
});

describe("message rendering", () => {
  it("escapes Discord markdown in scraped text", () => {
    const [alert] = buildHighScoreAlerts(
      [listing({ id: "e", score: 90, title: "SWE *Intern* _2027_" })],
      settings({ highScoreMin: 85 }),
      o,
    );
    expect(alert.discord).toContain("SWE \\*Intern\\* \\_2027\\_");
    // The plain-text body is not markdown, so it stays readable.
    expect(alert.text).toContain("SWE *Intern* _2027_");
  });

  it("never renders a non-http url as a link", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl("https://ok.test/x")).toBe("https://ok.test/x");

    const [alert] = buildHighScoreAlerts(
      [listing({ id: "bad", score: 90, url: "javascript:alert(1)" })],
      settings({ highScoreMin: 85 }),
      o,
    );
    expect(alert.text).toContain("(no apply link)");
    expect(alert.text).not.toContain("javascript:");
  });

  it("escapes a backslash before the characters it would escape", () => {
    expect(escapeDiscord("a\\*b")).toBe("a\\\\\\*b");
  });

  it("names company, role, score, location, deadline and link", () => {
    const [alert] = buildHighScoreAlerts(
      [
        listing({
          id: "full",
          score: 93,
          company: "Stripe",
          title: "Backend Intern",
          location: "Seattle, WA",
          deadline: daysFromNow(3),
          url: "https://apply.test/full",
        }),
      ],
      settings({ highScoreMin: 85 }),
      o,
    );

    for (const part of ["Stripe", "Backend Intern", "93", "Seattle, WA", "https://apply.test/full"]) {
      expect(alert.text).toContain(part);
    }
    expect(alert.text).toContain("closes in 3 days (2026-09-23)");
  });
});

describe("buildAlerts dispatcher", () => {
  it("routes each kind to its builder", () => {
    const rows = [
      listing({ id: "a", score: 95, saved: true, deadline: daysFromNow(2) }),
    ];
    const s = settings({ digestMinScore: 70, highScoreMin: 85, closingSoonDays: 7 });

    expect(buildAlerts("DAILY_DIGEST", rows, s, o).map((a) => a.kind)).toEqual(["DAILY_DIGEST"]);
    expect(buildAlerts("HIGH_SCORE", rows, s, o).map((a) => a.kind)).toEqual(["HIGH_SCORE"]);
    expect(buildAlerts("CLOSING_SOON", rows, s, o).map((a) => a.kind)).toEqual(["CLOSING_SOON"]);
  });
});

describe("parseAlertSettings", () => {
  it("falls back to defaults when the row is absent", () => {
    expect(parseAlertSettings(undefined).settings).toEqual(DEFAULT_ALERT_SETTINGS);
    expect(parseAlertSettings(null).issues).toEqual([]);
  });

  it("keeps the valid fields when one is malformed", () => {
    const { settings: s, issues } = parseAlertSettings({ highScoreMin: 999, closingSoonDays: 3 });
    expect(s.closingSoonDays).toBe(3);
    expect(s.highScoreMin).toBe(DEFAULT_ALERT_SETTINGS.highScoreMin);
    expect(issues.join()).toContain("highScoreMin");
  });

  it("reports an unknown key instead of adopting it", () => {
    const { settings: s, issues } = parseAlertSettings({ scoringWeights: { techFit: 1 } });
    expect(s).toEqual(DEFAULT_ALERT_SETTINGS);
    expect(issues.join()).toContain("scoringWeights");
  });

  it("rejects a non-object row wholesale", () => {
    expect(parseAlertSettings("nope").settings).toEqual(DEFAULT_ALERT_SETTINGS);
    expect(parseAlertSettings([1, 2]).issues).toHaveLength(1);
  });
});
