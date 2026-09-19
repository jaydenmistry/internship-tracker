import { describe, expect, it } from "vitest";
import { loadScoringConfig } from "@/lib/scoring/config";
import {
  EXTRA_KEYWORDS,
  buildVocabulary,
  extractKeywords,
  matchResume,
} from "@/lib/resume/match";

const { config } = loadScoringConfig();
const vocab = buildVocabulary(config);
const has = (text: string, label: string) => extractKeywords(text, vocab).includes(label);

describe("buildVocabulary", () => {
  it("puts the user's scored skills first, so matching agrees with the score", () => {
    const skillLabels = config.techFit.skills.map((s) => s.label);
    expect(vocab.slice(0, skillLabels.length).map((k) => k.label)).toEqual(skillLabels);
  });

  it("never lists the same label twice", () => {
    const labels = vocab.map((k) => k.label.toLowerCase());
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("has only compilable patterns", () => {
    for (const k of [...vocab, ...EXTRA_KEYWORDS]) {
      for (const p of k.patterns) expect(() => new RegExp(p, "i")).not.toThrow();
    }
  });
});

describe("extractKeywords — the collisions that make naive matching wrong", () => {
  it.each([
    ["Build services in Go and gRPC.", "Go", true],
    ["We use Golang for everything.", "Go", true],
    ["You will go to standups and go above and beyond.", "Go", false],
    ["Experience with C++ and CUDA.", "C++", true],
    ["Experience with C++ and CUDA.", "C", false],
    ["Low-level C and assembly.", "C", true],
    ["Services written in C# on .NET.", "C#", true],
    ["Services written in C# on .NET.", "C", false],
    ["Java and Spring Boot backends.", "Java", true],
    ["Modern JavaScript and TypeScript.", "Java", false],
    ["Modern JavaScript and TypeScript.", "JavaScript", true],
    ["Spring Boot microservices.", "Spring", true],
    ["Summer 2027 or Spring 2027 start.", "Spring", false],
    ["Pipelines on Apache Spark.", "Spark", true],
    ["Help spark innovation across teams.", "Spark", false],
    ["Git and GitHub Actions workflows.", "Git", true],
    ["Git and GitHub Actions workflows.", "GitHub Actions", true],
    ["Hosted on GitHub.", "Git", false],
  ])("%s → %s: %s", (text, label, expected) => {
    expect(has(text, label)).toBe(expected);
  });

  it("is case-insensitive", () => {
    expect(has("KUBERNETES and PYTHON", "Kubernetes")).toBe(true);
    expect(has("KUBERNETES and PYTHON", "Python")).toBe(true);
  });

  it("orders keywords by where the posting first mentions them", () => {
    const text = "We need Python. Also Kubernetes. Some Go is a plus.";
    const found = extractKeywords(text, vocab);
    expect(found.indexOf("Python")).toBeLessThan(found.indexOf("Kubernetes"));
    expect(found.indexOf("Kubernetes")).toBeLessThan(found.indexOf("Go"));
  });

  it("returns nothing for text with no known terms", () => {
    expect(extractKeywords("A friendly and motivated team player.", vocab)).toEqual([]);
  });
});

describe("matchResume", () => {
  const posting =
    "You will build backend services in Go on Kubernetes, deployed to AWS, with Kafka and PostgreSQL.";

  it("splits the posting's keywords into hits and misses against the resume", () => {
    const resume = "Projects: a Go HTTP server on Kubernetes; coursework in PostgreSQL.";
    const { hits, misses } = matchResume(posting, resume, vocab);
    expect(hits).toEqual(expect.arrayContaining(["Go", "Kubernetes", "PostgreSQL"]));
    expect(misses).toEqual(expect.arrayContaining(["AWS", "Kafka"]));
  });

  it("keeps both lists in the posting's order", () => {
    const { hits, misses } = matchResume(posting, "Go, AWS, PostgreSQL", vocab);
    const order = extractKeywords(posting, vocab);
    const inPostingOrder = (xs: string[]) =>
      xs.every((x, i) => i === 0 || order.indexOf(xs[i - 1]) < order.indexOf(x));
    expect(inPostingOrder(hits)).toBe(true);
    expect(inPostingOrder(misses)).toBe(true);
  });

  it("covers every posting keyword exactly once across hits + misses", () => {
    const { hits, misses } = matchResume(posting, "Go", vocab);
    const all = extractKeywords(posting, vocab);
    expect([...hits, ...misses].sort()).toEqual([...all].sort());
    expect(hits.filter((h) => misses.includes(h))).toEqual([]);
  });

  it("applies the same collision rules on the resume side", () => {
    // A resume that says "go-getter" must not count as knowing Go.
    const { hits, misses } = matchResume("Backend work in Go.", "I am a go-getter.", vocab);
    expect(hits).not.toContain("Go");
    expect(misses).toContain("Go");
  });

  it("treats an empty resume as missing everything", () => {
    const { hits, misses } = matchResume(posting, "", vocab);
    expect(hits).toEqual([]);
    expect(misses.length).toBeGreaterThan(0);
  });
});
