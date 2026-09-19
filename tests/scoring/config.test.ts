import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  COMPONENT_NAMES,
  SCORING_CONFIG_PATH,
  ScoringConfigError,
  hashScoringConfig,
  loadScoringConfig,
  stableStringify,
} from "@/lib/scoring/config";

const SHIPPED_PATH = path.resolve(process.cwd(), "config/scoring.json");
const SHIPPED_TEXT = readFileSync(SHIPPED_PATH, "utf8");

/** Reader that always returns `text`, recording the path it was asked for. */
function reader(text: string, seen?: string[]): (p: string) => string {
  return (p: string) => {
    seen?.push(p);
    return text;
  };
}

afterEach(() => {
  delete process.env.SCORING_CONFIG_PATH;
});

describe("SCORING_CONFIG_PATH", () => {
  it("points at <repo>/config/scoring.json by default", () => {
    expect(SCORING_CONFIG_PATH).toBe(SHIPPED_PATH);
  });

  it("is overridable via the SCORING_CONFIG_PATH env var", () => {
    const seen: string[] = [];
    process.env.SCORING_CONFIG_PATH = "/mnt/config/scoring.json";
    loadScoringConfig(reader(SHIPPED_TEXT, seen));
    expect(seen).toEqual(["/mnt/config/scoring.json"]);
  });
});

describe("loadScoringConfig — the shipped default file", () => {
  it("loads and validates", () => {
    const { config, hash } = loadScoringConfig();
    expect(config.version).toBe(1);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("round-trips: the parsed config re-serializes to the same hash", () => {
    const { config, hash } = loadScoringConfig();
    expect(hashScoringConfig(config)).toBe(hash);
    const reloaded = loadScoringConfig(reader(JSON.stringify(config)));
    expect(reloaded.hash).toBe(hash);
  });

  it("defines every weight the engine reads", () => {
    const { config } = loadScoringConfig();
    for (const name of COMPONENT_NAMES) {
      expect(typeof config.weights[name], `weights.${name}`).toBe("number");
    }
  });

  it("defines every skill the user's profile calls for", () => {
    const { config } = loadScoringConfig();
    const ids = config.techFit.skills.map((s) => s.id);
    for (const id of [
      "go",
      "typescript",
      "react",
      "nextjs",
      "python",
      "cpp",
      "c",
      "docker",
      "kubernetes",
      "aws",
      "linux",
      "distributed-systems",
      "cybersecurity",
      "backend",
      "infra",
    ]) {
      expect(ids, `skill ${id}`).toContain(id);
    }
  });

  it("blocks exactly the non-US countries deriveCountries can emit", () => {
    const { config } = loadScoringConfig();
    // Mirrors COUNTRY_NAMES / CA_PROVINCES in lib/ingestion/normalize.ts.
    const emittable = [
      "CA", "UK", "DE", "FR", "IE", "NL", "ES", "IT", "PL", "SE",
      "DK", "FI", "NO", "PT", "BE", "AT", "CH", "CZ", "RO", "HU",
    ];
    const blocked = config.disqualifiers.workAuthorization.blockedCountries;
    expect([...blocked].sort()).toEqual([...emittable].sort());
    expect(blocked).not.toContain("US");
  });

  it("keeps the llm threshold at or above the detail-fetch threshold", () => {
    const { config } = loadScoringConfig();
    expect(config.thresholds.llmMin).toBeGreaterThanOrEqual(config.thresholds.detailFetchMin);
    expect(config.llm.maxAdjustment).toBe(15);
  });
});

describe("hashing", () => {
  it("is stable across key order and whitespace", () => {
    const parsed = JSON.parse(SHIPPED_TEXT) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(parsed).reverse());
    const a = loadScoringConfig(reader(JSON.stringify(parsed, null, 2)));
    const b = loadScoringConfig(reader(JSON.stringify(reordered)));
    expect(b.hash).toBe(a.hash);
  });

  it("changes when a weight changes", () => {
    const parsed = JSON.parse(SHIPPED_TEXT) as { weights: Record<string, number> };
    const before = loadScoringConfig(reader(JSON.stringify(parsed)));
    parsed.weights.techFit = parsed.weights.techFit + 1;
    const after = loadScoringConfig(reader(JSON.stringify(parsed)));
    expect(after.hash).not.toBe(before.hash);
  });

  it("changes when a keyword changes", () => {
    const parsed = JSON.parse(SHIPPED_TEXT) as {
      techFit: { skills: Array<{ patterns: string[] }> };
    };
    const before = loadScoringConfig(reader(JSON.stringify(parsed)));
    parsed.techFit.skills[0].patterns.push("\\brust\\b");
    const after = loadScoringConfig(reader(JSON.stringify(parsed)));
    expect(after.hash).not.toBe(before.hash);
  });

  it("re-reads the file on every call (no module-level caching)", () => {
    const parsed = JSON.parse(SHIPPED_TEXT) as { weights: Record<string, number> };
    const first = loadScoringConfig(reader(JSON.stringify(parsed)));
    const edited = { ...parsed, weights: { ...parsed.weights, location: 99 } };
    const second = loadScoringConfig(reader(JSON.stringify(edited)));
    expect(second.config.weights.location).toBe(99);
    expect(second.hash).not.toBe(first.hash);
  });

  it("sorts object keys but preserves array order", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableStringify([{ b: 1, a: 2 }, 3])).toBe('[{"a":2,"b":1},3]');
    expect(stableStringify(["x", "y"])).not.toBe(stableStringify(["y", "x"]));
  });
});

describe("loadScoringConfig — failures name the path and the issue", () => {
  it("throws when the file is missing", () => {
    const missing = () => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    };
    expect(() => loadScoringConfig(missing)).toThrow(ScoringConfigError);
    expect(() => loadScoringConfig(missing)).toThrow(SHIPPED_PATH);
    expect(() => loadScoringConfig(missing)).toThrow(/ENOENT/);
  });

  it("throws when the file is not JSON", () => {
    expect(() => loadScoringConfig(reader("{not json"))).toThrow(/not valid JSON/);
    expect(() => loadScoringConfig(reader("{not json"))).toThrow(SHIPPED_PATH);
  });

  const invalidShapes: Array<[name: string, mutate: (c: Record<string, unknown>) => void, issue: RegExp]> = [
    [
      "weights holding a string",
      (c) => {
        (c.weights as Record<string, unknown>).techFit = "30";
      },
      /weights\.techFit/,
    ],
    [
      "a negative weight",
      (c) => {
        (c.weights as Record<string, unknown>).roleType = -1;
      },
      /weights\.roleType/,
    ],
    [
      "a location fraction above 1",
      (c) => {
        ((c.location as Record<string, unknown>).hubs as Record<string, unknown>).fraction = 1.5;
      },
      /location\.hubs\.fraction/,
    ],
    [
      "a skill with no patterns",
      (c) => {
        ((c.techFit as { skills: Array<{ patterns: string[] }> }).skills[0].patterns = []);
      },
      /techFit\.skills\.0\.patterns/,
    ],
    [
      "an uncompilable regex",
      (c) => {
        (c.techFit as { skills: Array<{ patterns: string[] }> }).skills[0].patterns = ["([a-z"];
      },
      /not a valid regular expression/,
    ],
    [
      "a missing disqualifier section",
      (c) => {
        delete (c.disqualifiers as Record<string, unknown>).closed;
      },
      /disqualifiers\.closed/,
    ],
    [
      "a half-life of zero",
      (c) => {
        (c.freshness as Record<string, unknown>).halfLifeDays = 0;
      },
      /freshness\.halfLifeDays/,
    ],
  ];

  it.each(invalidShapes)("throws on %s", (_name, mutate, issue) => {
    const parsed = JSON.parse(SHIPPED_TEXT) as Record<string, unknown>;
    mutate(parsed);
    const load = () => loadScoringConfig(reader(JSON.stringify(parsed)));
    expect(load).toThrow(ScoringConfigError);
    expect(load).toThrow(issue);
    expect(load).toThrow(SHIPPED_PATH);
  });

  it("accepts a config with a weight key omitted entirely", () => {
    const parsed = JSON.parse(SHIPPED_TEXT) as { weights: Record<string, unknown> };
    delete parsed.weights.deadlineUrgency;
    const { config } = loadScoringConfig(reader(JSON.stringify(parsed)));
    expect(config.weights.deadlineUrgency).toBeUndefined();
  });
});
