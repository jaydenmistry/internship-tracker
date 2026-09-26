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
import type { AlertFollowUp } from "@/lib/alerts/types";

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

describe("digest follow-ups", () => {
  const fu = (over: Partial<AlertFollowUp> = {}): AlertFollowUp => ({
    contactId: "c1",
    name: "Sam Lee",
    company: "Stripe",
    kind: "FOLLOW_UP",
    dueAt: NOW,
    overdue: false,
    ...over,
  });
  const s = settings({ digestMinScore: 70 });

  it("sends with follow-ups alone — no new listings needed", () => {
    const d = buildDailyDigest([], s, o, [fu()])!;
    expect(d).not.toBeNull();
    expect(d.subject).toBe("Daily digest: 1 follow-up due");
    expect(d.text).toContain("Sam Lee (Stripe) — follow up, due today");
    expect(d.text).toContain("/network/c1");
    expect(d.listingIds).toEqual([]);
  });

  it("is still null when there are neither listings nor follow-ups", () => {
    expect(buildDailyDigest([], s, o, [])).toBeNull();
  });

  it("puts both in the headline and keeps the one-per-day dedupe key", () => {
    const d = buildDailyDigest([listing({ id: "a", score: 90 })], s, o, [fu(), fu({ contactId: "c2" })])!;
    expect(d.subject).toMatch(/^Daily digest: 1 new role scoring 70\+ \(last 24h\) · 2 follow-ups due$/);
    expect(d.baseKey).toBe(buildDailyDigest([listing({ id: "a", score: 90 })], s, o)!.baseKey);
  });

  it("labels each kind and says how overdue", () => {
    const d = buildDailyDigest([], s, o, [
      fu({ kind: "THANK_YOU", overdue: true, dueAt: new Date("2026-09-17T00:00:00Z") }),
      fu({ contactId: "c2", name: "Ana", company: null, kind: "SEND_OPENER" }),
    ])!;
    expect(d.text).toContain("Sam Lee (Stripe) — send a thank-you, overdue since 2026-09-17");
    expect(d.text).toContain("Ana — send an opener, due today");
  });

  it("links absolutely when APP_URL is an http(s) origin, and never to anything else", () => {
    expect(buildDailyDigest([], s, { ...o, appUrl: "https://jobs.example.com" }, [fu()])!.discord).toContain(
      "<https://jobs.example.com/network/c1>",
    );
    const bad = buildDailyDigest([], s, { ...o, appUrl: "javascript:alert(1)" }, [fu()])!;
    expect(bad.text).not.toContain("javascript:");
    expect(bad.discord).not.toContain("<");
  });

  it("escapes user-typed names for Discord and caps the list", () => {
    const many = Array.from({ length: 13 }, (_, i) => fu({ contactId: `c${i}`, name: `*bold* ${i}` }));
    const d = buildDailyDigest([], s, o, many)!;
    expect(d.discord).toContain("\\*bold\\* 0");
    expect(d.text).toContain("…and 3 more on /network.");
    expect(d.text).not.toContain("*bold* 12");
  });
});

describe("digest follow-ups survive Discord's length limit", () => {
  it("puts follow-ups before a full page of listings, inside the 2,000-char cut", async () => {
    const { truncateForDiscord } = await import("@/lib/alerts/channels/discord");
    const s = settings({ digestMinScore: 0, maxItemsPerDigest: 25 });
    const many = Array.from({ length: 25 }, (_, i) =>
      listing({ id: `l${i}`, score: 90, title: `Software Engineering Intern, Platform Infrastructure ${i}` }),
    );
    const d = buildDailyDigest(many, s, o, [
      { contactId: "c1", name: "Sam Lee", company: "Stripe", kind: "FOLLOW_UP", dueAt: NOW, overdue: false },
    ])!;
    // Built to fit: never over the limit, so the transport never has to cut.
    expect(d.discord.length).toBeLessThanOrEqual(2000);
    expect(truncateForDiscord(d.discord)).toBe(d.discord);
    expect(d.discord).toContain("Sam Lee (Stripe)");
    const shownRoles = (d.discord.match(/Platform Infrastructure \d+/g) ?? []).length;
    expect(shownRoles).toBeGreaterThan(0);
    expect(shownRoles).toBeLessThan(25);
    expect(d.discord).toMatch(new RegExp(`…and ${25 - shownRoles} more roles in the app\\.$`));
    expect(d.text.indexOf("Sam Lee")).toBeLessThan(d.text.indexOf("Platform Infrastructure 0"));
  });

  it("counts follow-ups the limit dropped, plus those past the 10-item cap", () => {
    const s = settings({ digestMinScore: 0 });
    const long = "x".repeat(300);
    const fus = Array.from({ length: 14 }, (_, i) => ({
      contactId: `c${i}`,
      name: `${long} ${i}`,
      company: null,
      kind: "FOLLOW_UP" as const,
      dueAt: NOW,
      overdue: false,
    }));
    const d = buildDailyDigest([], s, o, fus)!;
    expect(d.discord.length).toBeLessThanOrEqual(2000);
    const shown = (d.discord.match(/x{300} \d+/g) ?? []).length;
    expect(shown).toBeLessThan(10);
    // 14 due: 10 pass the cap, `shown` of those fit; the rest are all counted.
    expect(d.discord).toContain(`…and ${14 - shown} more follow-ups on /network.`);
    // Email has no length limit: the cap alone applies.
    expect(d.text).toContain("…and 4 more on /network.");
  });

  it("adds no trailer when everything fits", () => {
    const d = buildDailyDigest([listing({ id: "a", score: 90 })], settings({ digestMinScore: 0 }), o, [])!;
    expect(d.discord).not.toContain("…and");
  });
});
