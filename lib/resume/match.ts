import type { ScoringConfig } from "@/lib/scoring/config";

/**
 * Resume ↔ posting keyword matching — for tailoring a resume, NOT for scoring.
 *
 * Pure: no I/O. The vocabulary is the user's own skills from
 * config/scoring.json (so matching agrees with how tech fit is scored, including
 * the hard cases: "Go" vs "go to", "C" vs "C++"/"C#") plus a broader list of
 * common engineering terms that postings ask for but that don't drive the score.
 */

export interface Keyword {
  label: string;
  patterns: string[];
}

/**
 * Terms outside the user's scored skill list. Patterns are case-insensitive and
 * written to avoid prose collisions: "Spring" only as a framework (never the
 * season), "Spark" only as Apache Spark/PySpark, "Java" never inside
 * "JavaScript". Labels are what the UI shows.
 */
export const EXTRA_KEYWORDS: Keyword[] = [
  { label: "Java", patterns: ["\\bjava\\b(?!\\s*script)"] },
  { label: "JavaScript", patterns: ["\\bjavascript\\b", "\\becmascript\\b"] },
  { label: "Node.js", patterns: ["\\bnode\\.?js\\b"] },
  { label: "Rust", patterns: ["\\brust\\b"] },
  { label: "C#", patterns: ["(?<![\\w])c#", "\\bc\\s?sharp\\b"] },
  { label: "Kotlin", patterns: ["\\bkotlin\\b"] },
  { label: "Swift", patterns: ["\\bswift\\b(?!ly)"] },
  { label: "Scala", patterns: ["\\bscala\\b"] },
  { label: "Ruby", patterns: ["\\bruby\\b"] },
  { label: "Rails", patterns: ["\\bruby\\s+on\\s+rails\\b", "\\brails\\b"] },
  { label: "PHP", patterns: ["\\bphp\\b"] },
  { label: "SQL", patterns: ["\\bsql\\b"] },
  { label: "PostgreSQL", patterns: ["\\bpostgres(?:ql)?\\b"] },
  { label: "MySQL", patterns: ["\\bmysql\\b"] },
  { label: "MongoDB", patterns: ["\\bmongo(?:db)?\\b"] },
  { label: "Redis", patterns: ["\\bredis\\b"] },
  { label: "Kafka", patterns: ["\\bkafka\\b"] },
  { label: "Elasticsearch", patterns: ["\\belastic\\s?search\\b"] },
  { label: "DynamoDB", patterns: ["\\bdynamo\\s?db\\b"] },
  { label: "Cassandra", patterns: ["\\bcassandra\\b"] },
  { label: "Spark", patterns: ["\\bapache\\s+spark\\b", "\\bpyspark\\b", "\\bspark\\s+sql\\b"] },
  { label: "Airflow", patterns: ["\\bairflow\\b"] },
  { label: "GraphQL", patterns: ["\\bgraphql\\b"] },
  { label: "Bash", patterns: ["\\bbash\\b", "\\bshell\\s+script(?:s|ing)?\\b"] },
  { label: "Git", patterns: ["\\bgit\\b(?!hub|lab)"] },
  { label: "GCP", patterns: ["\\bgcp\\b", "\\bgoogle\\s+cloud(?:\\s+platform)?\\b"] },
  { label: "Azure", patterns: ["\\bazure\\b"] },
  { label: "Terraform", patterns: ["\\bterraform\\b"] },
  { label: "Ansible", patterns: ["\\bansible\\b"] },
  { label: "Jenkins", patterns: ["\\bjenkins\\b"] },
  { label: "GitHub Actions", patterns: ["\\bgithub\\s+actions\\b"] },
  { label: "Nginx", patterns: ["\\bnginx\\b"] },
  { label: "Prometheus", patterns: ["\\bprometheus\\b"] },
  { label: "Grafana", patterns: ["\\bgrafana\\b"] },
  { label: "Helm", patterns: ["\\bhelm\\b"] },
  { label: "Vue", patterns: ["\\bvue(?:\\.js)?\\b"] },
  { label: "Angular", patterns: ["\\bangular(?:js)?\\b"] },
  { label: "Svelte", patterns: ["\\bsvelte\\b"] },
  { label: "HTML", patterns: ["\\bhtml5?\\b"] },
  { label: "CSS", patterns: ["\\bcss3?\\b"] },
  { label: "Tailwind", patterns: ["\\btailwind(?:\\s?css)?\\b"] },
  { label: "Django", patterns: ["\\bdjango\\b"] },
  { label: "Flask", patterns: ["\\bflask\\b"] },
  { label: "FastAPI", patterns: ["\\bfast\\s?api\\b"] },
  { label: "Spring", patterns: ["\\bspring\\s+(?:boot|framework|mvc)\\b"] },
  { label: "PyTorch", patterns: ["\\bpytorch\\b"] },
  { label: "TensorFlow", patterns: ["\\btensorflow\\b"] },
  { label: "CUDA", patterns: ["\\bcuda\\b"] },
  { label: "Machine learning", patterns: ["\\bmachine\\s+learning\\b", "\\bml\\b"] },
  { label: "Deep learning", patterns: ["\\bdeep\\s+learning\\b"] },
  { label: "NLP", patterns: ["\\bnlp\\b", "\\bnatural\\s+language\\s+processing\\b"] },
  { label: "Computer vision", patterns: ["\\bcomputer\\s+vision\\b"] },
  { label: "Concurrency", patterns: ["\\bconcurren(?:cy|t)\\b", "\\bmulti-?threading\\b", "\\bmulti-?threaded\\b"] },
  { label: "Networking", patterns: ["\\bnetworking\\b", "\\btcp\\s?/\\s?ip\\b", "\\bnetwork\\s+protocols?\\b"] },
  { label: "Operating systems", patterns: ["\\boperating\\s+systems?\\b", "\\bkernel\\b"] },
  { label: "Compilers", patterns: ["\\bcompilers?\\b"] },
  { label: "Data structures", patterns: ["\\bdata\\s+structures?\\b"] },
  { label: "Algorithms", patterns: ["\\balgorithms?\\b"] },
  { label: "Embedded", patterns: ["\\bembedded\\b", "\\bfirmware\\b"] },
  { label: "FPGA", patterns: ["\\bfpga\\b", "\\bverilog\\b", "\\bvhdl\\b"] },
  { label: "Unit testing", patterns: ["\\bunit\\s+test(?:s|ing)?\\b", "\\btest[-\\s]driven\\b"] },
  { label: "Observability", patterns: ["\\bobservability\\b", "\\bmonitoring\\s+and\\s+alerting\\b"] },
  { label: "Frontend", patterns: ["\\bfront[-\\s]?end\\b"] },
  { label: "Full stack", patterns: ["\\bfull[-\\s]?stack\\b"] },
  { label: "iOS", patterns: ["\\bios\\b"] },
  { label: "Android", patterns: ["\\bandroid\\b"] },
  { label: "Agile", patterns: ["\\bagile\\b", "\\bscrum\\b"] },
];

/**
 * The user's scored skills first (so matching agrees with the score), then the
 * extra terms whose label isn't already covered.
 */
export function buildVocabulary(config: ScoringConfig): Keyword[] {
  const skills: Keyword[] = config.techFit.skills.map((s) => ({
    label: s.label,
    patterns: s.patterns,
  }));
  const taken = new Set(skills.map((s) => s.label.toLowerCase()));
  return [...skills, ...EXTRA_KEYWORDS.filter((k) => !taken.has(k.label.toLowerCase()))];
}

// Compiled once per pattern source; none use the /g flag, so no lastIndex state.
const compiled = new Map<string, RegExp>();
function compile(source: string): RegExp {
  let re = compiled.get(source);
  if (!re) {
    re = new RegExp(source, "i");
    compiled.set(source, re);
  }
  return re;
}

/** Position of the keyword's first match in `text`, or -1 when absent. */
function firstIndex(text: string, keyword: Keyword): number {
  let best = -1;
  for (const pattern of keyword.patterns) {
    const m = compile(pattern).exec(text);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  return best;
}

/** Keywords present in `text`, ordered by where they first appear. */
export function extractKeywords(text: string, vocabulary: Keyword[]): string[] {
  return vocabulary
    .map((k) => ({ label: k.label, at: firstIndex(text, k) }))
    .filter((k) => k.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((k) => k.label);
}

export interface KeywordMatch {
  /** Asked for by the posting AND present on the resume. */
  hits: string[];
  /** Asked for by the posting but NOT on the resume — the tailoring list. */
  misses: string[];
}

/**
 * Which of the posting's keywords the resume already covers. Both lists keep
 * the posting's order, so the terms it mentions first (usually the core stack)
 * come first.
 */
export function matchResume(
  postingText: string,
  resumeText: string,
  vocabulary: Keyword[],
): KeywordMatch {
  const byLabel = new Map(vocabulary.map((k) => [k.label, k]));
  const hits: string[] = [];
  const misses: string[] = [];
  for (const label of extractKeywords(postingText, vocabulary)) {
    const keyword = byLabel.get(label)!;
    (firstIndex(resumeText, keyword) >= 0 ? hits : misses).push(label);
  }
  return { hits, misses };
}
