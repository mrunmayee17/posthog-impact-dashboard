import { mkdir, readFile, writeFile } from "node:fs/promises";

type Dimension = "delivery" | "leverage" | "quality" | "collaboration" | "scope";
type SearchPr = {
  number: number;
  title: string;
  body: string;
  url: string;
  apiUrl: string;
  mergedAt: string;
  author: string;
  labels: string[];
  comments: number;
};
type Detail = {
  review_comments: number;
  changed_files: number;
  commits: number;
};
type Evidence = {
  kind: "pr" | "review";
  title: string;
  url: string;
  summary: string;
};
type ScorePart = {
  label: string;
  value: number;
  count: number;
};
type ScoreInput = {
  raw: number;
  parts: ScorePart[];
};
type Person = {
  login: string;
  raw: Record<Dimension, number>;
  parts: Record<Dimension, Record<string, ScorePart>>;
  evidence: Record<Dimension, Array<Evidence & { points: number }>>;
  prs: Array<SearchPr & { total: number }>;
};
type Leader = {
  login: string;
  rank: number;
  impactScore: number;
  archetype: string;
  scoreBreakdown: Record<Dimension, number>;
  scoreInputs: Record<Dimension, ScoreInput>;
  whyTheyRanked: string[];
  evidence: Evidence[];
};
type SearchPage = {
  total_count: number;
  incomplete_results: boolean;
  items: Array<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    comments: number;
    closed_at: string;
    user: { login: string };
    labels: Array<{ name: string }>;
    pull_request?: { url: string; merged_at?: string | null };
  }>;
};

const start = "2026-01-07";
const end = "2026-04-07";
const dims: Dimension[] = ["delivery", "leverage", "quality", "collaboration", "scope"];
const weights: Record<Dimension, number> = { delivery: 30, leverage: 25, quality: 20, collaboration: 15, scope: 10 };
const token = process.env.GITHUB_TOKEN ?? "";
const cacheRoot = ".cache/github";
const archetypes: Record<Dimension, string> = {
  delivery: "Feature Driver",
  leverage: "Infrastructure Multiplier",
  quality: "Reliability Owner",
  collaboration: "Coordination Driver",
  scope: "Cross-Cutting Builder"
};
const ignoredAuthors = new Set(["github-actions[bot]", "dependabot[bot]", "web-flow", "copilot-swe-agent"]);
const waitMs = 6500;

async function main() {
  const prs = (await getMergedPrs()).filter((pr) => !skipPr(pr));
  const scored = collect(prs);
  const candidates = scored.slice(0, 12);
  const details = token ? await getDetails(candidates) : new Map<number, Detail>();
  const rescored = collect(prs, details).filter((person) => candidates.some((item) => item.login === person.login));
  const leaders = finalize(rescored).slice(0, 5).map((leader, index) => ({ ...leader, rank: index + 1 }));
  if (leaders.length !== 5) throw new Error(`Expected 5 leaders, got ${leaders.length}`);
  await mkdir("src/data", { recursive: true });
  await writeJson(`${cacheRoot}/prs.json`, prs);
  await writeFile("src/data/impact.json", JSON.stringify({
    generatedAt: new Date().toISOString(),
    timeframe: { start, end, days: 90 },
    methodology: {
      definition: "Impact means visible engineering influence in the repo across delivery, leverage, quality, coordination, and scope over the last 90 days.",
      weights,
      limitations: [
        "This ranks repository evidence, not absolute company impact.",
        token ? "Detailed PR metadata was enriched through authenticated GitHub API access." : "Detailed PR file and review enrichment was skipped because no GitHub token was available.",
        "Collaboration is estimated from coordination signals on important PRs because public review-author data is incomplete without authenticated access.",
        "It cannot see planning, mentoring outside GitHub, or incident leadership outside the repo."
      ]
    },
    leaders
  }, null, 2));
}

async function getMergedPrs() {
  const items: SearchPr[] = [];
  for (const day of days(start, end)) {
    for (let page = 1; ; page++) {
      const data = await searchDay(day, page);
      if (data.incomplete_results) throw new Error(`Incomplete results for ${day}`);
      if (data.total_count > 1000) throw new Error(`Too many PRs on ${day}`);
      items.push(...data.items
        .filter((item) => item.pull_request?.merged_at)
        .map((item) => ({
          number: item.number,
          title: item.title,
          body: item.body ?? "",
          url: item.html_url,
          apiUrl: item.pull_request!.url,
          mergedAt: item.pull_request!.merged_at!,
          author: item.user.login,
          labels: item.labels.map((label) => label.name.toLowerCase()),
          comments: item.comments
        })));
      if (data.items.length < 100) break;
    }
  }
  return dedupe(items);
}

async function searchDay(day: string, page: number) {
  const file = `${cacheRoot}/search/${day}-${page}.json`;
  const cached = await readJson<SearchPage>(file);
  if (cached) return cached;
  console.log(`search ${day} page ${page}`);
  const q = new URLSearchParams({
    q: `repo:PostHog/posthog is:pr is:merged merged:${day}..${day}`,
    per_page: "100",
    page: String(page)
  });
  const data = await rest<SearchPage>(`https://api.github.com/search/issues?${q}`, "search");
  await writeJson(file, data);
  await sleep(waitMs);
  return data;
}

async function getDetails(candidates: Person[]) {
  const chosen = new Map<number, SearchPr>();
  for (const person of candidates) {
    for (const pr of person.prs.slice(0, 3)) chosen.set(pr.number, pr);
  }
  const details = new Map<number, Detail>();
  console.log(`detail ${chosen.size}`);
  for (const pr of chosen.values()) {
    const file = `${cacheRoot}/details/${pr.number}.json`;
    const cached = await readJson<Detail>(file);
    const data = cached ?? await rest<Detail>(pr.apiUrl, "core");
    if (!cached) await writeJson(file, data);
    details.set(pr.number, data);
  }
  return details;
}

async function rest<T>(url: string, bucket: "search" | "core") {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "posthog-impact-dashboard",
          ...(token ? { authorization: `Bearer ${token}` } : {})
        }
      });
      if (res.status === 403) {
        const reset = Number(res.headers.get("x-ratelimit-reset") ?? "0") * 1000;
        const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? "0");
        if (!remaining && reset > Date.now()) {
          await sleep(reset - Date.now() + 1000);
          continue;
        }
      }
      if (!res.ok) throw new Error(`${bucket} ${res.status} ${url}`);
      return res.json() as Promise<T>;
    } catch (error) {
      if (attempt === 5) throw error;
      await sleep(attempt * 2000);
    }
  }
  throw new Error(`Unreachable rest failure for ${bucket}`);
}

function collect(prs: SearchPr[], details = new Map<number, Detail>()) {
  const people = new Map<string, Person>();
  for (const pr of prs) addPr(people, pr, details.get(pr.number));
  for (const person of people.values()) addInitiativeBonus(person);
  return [...people.values()].sort((a, b) => totalRaw(b) - totalRaw(a));
}

function addPr(store: Map<string, Person>, pr: SearchPr, detail?: Detail) {
  const who = person(store, pr.author);
  const scored = score(pr, detail);
  const tags = classify(pr, detail);
  for (const dim of dims) {
    const points = scored[dim];
    if (!points) continue;
    who.raw[dim] += points;
    who.evidence[dim].push({ ...evidence(dim, pr, detail), points });
  }
  if (tags.delivery && scored.delivery) addPart(who, "delivery", "feature PR", scored.delivery);
  if (tags.leverage && scored.leverage) addPart(who, "leverage", "shared-system PR", scored.leverage);
  if (tags.quality && scored.quality) addPart(who, "quality", "fix/reliability PR", scored.quality);
  if (tags.collaboration && scored.collaboration) addPart(who, "collaboration", "discussion signal", scored.collaboration);
  if (tags.scope && scored.scope) addPart(who, "scope", "broad PR", scored.scope);
  who.prs.push({ ...pr, total: dims.reduce((sum, dim) => sum + scored[dim], 0) });
}

function addInitiativeBonus(person: Person) {
  const groups = new Map<string, Array<SearchPr & { total: number }>>();
  for (const pr of person.prs) {
    const key = scopeKey(pr);
    const list = groups.get(key) ?? [];
    list.push(pr);
    groups.set(key, list);
  }
  for (const [key, prs] of groups) {
    if (prs.length < 2) continue;
    const strength = prs.slice().sort((a, b) => b.total - a.total).slice(0, 3).reduce((sum, pr) => sum + pr.total, 0);
    const bonus = Math.min(strength * 0.14, 4);
    const platform = isPlatform(key);
    const scopeBonus = Math.min(prs.length * 0.3, 1.5);
    const coordinationBonus = Math.min(prs.length * 0.12, 0.8);
    person.raw.scope += scopeBonus;
    person.raw.collaboration += coordinationBonus;
    person.raw[platform ? "leverage" : "delivery"] += bonus;
    addPart(person, "scope", "initiative sequence", scopeBonus);
    addPart(person, "collaboration", "initiative coordination signal", coordinationBonus);
    addPart(person, platform ? "leverage" : "delivery", platform ? "platform initiative" : "initiative", bonus);
    person.evidence[platform ? "leverage" : "delivery"].push({
      kind: "pr",
      title: `${key} initiative`,
      url: prs[0].url,
      summary: `Owned a sustained ${key} initiative across ${prs.length} related PRs.`,
      points: bonus
    });
    person.evidence.scope.push({
      kind: "pr",
      title: `${key} rollout`,
      url: prs[0].url,
      summary: `Drove a multi-PR sequence in ${key}, indicating end-to-end ownership.`,
      points: Math.min(prs.length * 0.3, 1.5)
    });
  }
}

function person(store: Map<string, Person>, login: string) {
  let item = store.get(login);
  if (item) return item;
  item = {
    login,
    raw: { delivery: 0, leverage: 0, quality: 0, collaboration: 0, scope: 0 },
    parts: {
      delivery: {},
      leverage: {},
      quality: {},
      collaboration: {},
      scope: {}
    },
    evidence: { delivery: [], leverage: [], quality: [], collaboration: [], scope: [] },
    prs: []
  };
  store.set(login, item);
  return item;
}

function addPart(person: Person, dim: Dimension, label: string, value: number, count = 1) {
  const part = person.parts[dim][label] ?? { label, value: 0, count: 0 };
  part.value += value;
  part.count += count;
  person.parts[dim][label] = part;
}

function score(pr: SearchPr, detail?: Detail) {
  const tags = classify(pr, detail);
  const base = 1 + Math.min(pr.comments, 6) * 0.12 + Math.min(detail?.review_comments ?? 0, 4) * 0.08;
  return {
    delivery: tags.delivery ? base : 0,
    leverage: tags.leverage ? base * 0.95 : 0,
    quality: tags.quality ? base * 0.9 : 0,
    collaboration: tags.collaboration ? collaborationPoints(pr, detail, tags) : 0,
    scope: tags.scope ? scopePoints(pr, detail) : 0
  };
}

function classify(pr: SearchPr, detail?: Detail) {
  const text = `${pr.title} ${pr.body} ${pr.labels.join(" ")}`.toLowerCase();
  const prefix = pr.title.toLowerCase().split(":")[0];
  const tokens = [...scopeTokens(pr), ...teamTokens(pr.labels)];
  const key = scopeKey(pr);
  const infra = /(infra|pipeline|tooling|storybook|docker|terraform|build|sdk|common|shared|plugin|ingestion|clickhouse|kafka|rust|ci)\b/.test(text);
  const quality = /(fix|bug|error|reliability|perf|performance|security|test|flake)\b/.test(text);
  const product = /(feat|feature|enable|support|launch|improve|surveys|replay|session|error-tracking|analytics|insight|dashboard|notebook|flags|experiment)\b/.test(text);
  const areas = new Set(tokens.map(area));
  if (isPlatform(key)) areas.add("platform");
  if (infra) areas.add("platform");
  if (product) areas.add("product");
  if (quality) areas.add("quality");
  if ((detail?.changed_files ?? 0) >= 20) areas.add("breadth");
  return {
    delivery: prefix.startsWith("feat") || (product && !infra),
    leverage: prefix.startsWith("refactor") || infra,
    quality: prefix.startsWith("fix") || prefix.startsWith("perf") || prefix.startsWith("test") || quality,
    collaboration: pr.comments >= 2 || (detail?.review_comments ?? 0) >= 2,
    scope: areas.size >= 2 || (detail?.changed_files ?? 0) >= 12
  };
}

function collaborationPoints(pr: SearchPr, detail: Detail | undefined, tags: Record<Dimension, boolean>) {
  const depth = Math.min(pr.comments + (detail?.review_comments ?? 0), 8) * 0.18;
  const lift = tags.delivery || tags.leverage || tags.quality ? 0.4 : 0;
  return depth + lift;
}

function scopePoints(pr: SearchPr, detail?: Detail) {
  const count = new Set([...scopeTokens(pr), ...teamTokens(pr.labels)].map(area)).size;
  if ((detail?.changed_files ?? 0) >= 24 || count >= 3) return 1;
  if ((detail?.changed_files ?? 0) >= 12 || count >= 2) return 0.6;
  return 0;
}

function evidence(dim: Dimension, pr: SearchPr, detail?: Detail): Evidence {
  if (dim === "delivery") return { kind: "pr", title: pr.title, url: pr.url, summary: "Shipped visible product movement in PostHog." };
  if (dim === "leverage") return { kind: "pr", title: pr.title, url: pr.url, summary: "Improved infrastructure, shared systems, or engineering leverage." };
  if (dim === "quality") return { kind: "pr", title: pr.title, url: pr.url, summary: "Reduced risk through a fix, reliability update, or quality work." };
  if (dim === "collaboration") return { kind: "pr", title: pr.title, url: pr.url, summary: `Drew coordination around a meaningful PR with ${pr.comments + (detail?.review_comments ?? 0)} discussion signals.` };
  return { kind: "pr", title: pr.title, url: pr.url, summary: `Covered broad surface area with ${detail?.changed_files ?? 0} changed files.` };
}

function finalize(people: Person[]) {
  const peaks = dims.reduce<Record<Dimension, number>>((acc, dim) => {
    acc[dim] = Math.max(...people.map((person) => person.raw[dim]), 1);
    return acc;
  }, {} as Record<Dimension, number>);
  return people
    .map((person) => {
      const scoreBreakdown = dims.reduce<Record<Dimension, number>>((acc, dim) => {
        acc[dim] = Math.round((person.raw[dim] / peaks[dim]) * weights[dim]);
        return acc;
      }, {} as Record<Dimension, number>);
      const order = [...dims].sort((a, b) => scoreBreakdown[b] - scoreBreakdown[a]);
      const evidence = pruneEvidence(uniq(order.flatMap((dim) => person.evidence[dim]
        .sort((a, b) => evidenceRank(b) - evidenceRank(a))
        .map(({ points: _points, ...item }) => item)))).slice(0, 5);
      if (evidence.length < 3) throw new Error(`Not enough evidence for ${person.login}`);
      return {
        login: person.login,
        rank: 0,
        impactScore: dims.reduce((sum, dim) => sum + scoreBreakdown[dim], 0),
        archetype: archetypes[order[0]],
        scoreBreakdown,
        scoreInputs: dims.reduce<Record<Dimension, ScoreInput>>((acc, dim) => {
          acc[dim] = {
            raw: round(person.raw[dim]),
            parts: Object.values(person.parts[dim]).sort((a, b) => b.value - a.value).map((part) => ({
              label: part.label,
              value: round(part.value),
              count: part.count
            }))
          };
          return acc;
        }, {} as Record<Dimension, ScoreInput>),
        whyTheyRanked: order.slice(0, 3).filter((dim) => scoreBreakdown[dim] > 0).map(reason),
        evidence
      } satisfies Leader;
    })
    .sort((a, b) => b.impactScore - a.impactScore);
}

function reason(dim: Dimension) {
  if (dim === "delivery") return "Shipped meaningful product-facing work.";
  if (dim === "leverage") return "Improved shared systems or engineering leverage.";
  if (dim === "quality") return "Reduced risk with fixes, reliability, or quality work.";
  if (dim === "collaboration") return "Handled work that required visible coordination and discussion.";
  return "Landed work that touched broad surface area.";
}

function evidenceRank(item: Evidence & { points: number }) {
  const title = item.title.toLowerCase();
  let score = item.points;
  if (title.includes(" rollout") || title.includes(" initiative")) score += 2;
  if (title.startsWith("feat")) score += 0.8;
  if (title.startsWith("fix")) score += 0.5;
  if (title.startsWith("revert")) score -= 1.5;
  if (title.startsWith("chore")) score -= 0.7;
  if (title.startsWith("misc ")) score -= 1;
  return score;
}

function pruneEvidence(items: Evidence[]) {
  const keep = items.filter((item) => !lowSignal(item.title));
  return keep.length >= 3 ? keep : items;
}

function lowSignal(title: string) {
  const lower = title.toLowerCase();
  return lower.startsWith("revert") || lower.startsWith("chore") || lower.startsWith("misc ");
}

function skipPr(pr: SearchPr) {
  const lower = `${pr.title} ${pr.body} ${pr.labels.join(" ")}`.toLowerCase();
  const author = pr.author.toLowerCase();
  if (ignoredAuthors.has(author)) return true;
  if (author.endsWith("[bot]")) return true;
  if (/\b(bump|deps|dependency|merge queue|snapshot|changelog|release-please)\b/.test(lower)) return true;
  if (pr.labels.some((label) => /\b(dependencies|graphite-merge-queue|update-snapshots)\b/.test(label))) return true;
  return false;
}

function scopeKey(pr: SearchPr) {
  const scopes = scopeTokens(pr);
  if (scopes.length) return scopes.join("+");
  const teams = teamTokens(pr.labels);
  if (teams.length) return teams.join("+");
  return inferScope(pr);
}

function scopeTokens(pr: SearchPr) {
  const match = pr.title.match(/^[a-z-]+\(([^)]+)\)/i);
  if (!match) return [];
  return match[1].split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function teamTokens(labels: string[]) {
  return labels.filter((label) => label.startsWith("team/")).map((label) => label.slice(5));
}

function area(token: string) {
  if (/(survey|replay|session|error|analytics|dashboard|notebook|flags|experiment|insight|llm)/.test(token)) return "product";
  if (/(infra|pipeline|build|docker|terraform|plugin|sdk|common|shared|storybook|ci|rust|ingestion|kafka|clickhouse)/.test(token)) return "platform";
  return token;
}

function isPlatform(scope: string) {
  return /(capture v1|platform|pipeline|infra|build|docker|terraform|plugin|sdk|common|shared|storybook|ci|rust|ducklake|duckgres|kafka|clickhouse)/.test(scope);
}

function inferScope(pr: SearchPr) {
  const text = `${pr.title} ${pr.body}`.toLowerCase();
  const scopes = [
    "insights",
    "funnels",
    "replay",
    "support",
    "flags",
    "experiments",
    "surveys",
    "paths",
    "llma",
    "data-warehouse",
    "max",
    "navbar",
    "taxonomic-filter",
    "session-replay",
    "error-tracking",
    "cdp",
    "workflows",
    "batch-exports",
    "gateway",
    "hogql",
    "persons",
    "notebooks",
    "dashboards",
    "groups",
    "feature-flags",
    "storyboard",
    "storybook",
    "devex",
    "ci",
    "clickhouse",
    "ducklake",
    "duckgres",
    "rust",
    "plugin-server",
    "ingestion"
  ];
  for (const scope of scopes) {
    if (text.includes(scope)) return scope;
  }
  if (isPlatform(text)) return "platform";
  if (/(frontend|ui|design token|storybook|scene snapshot)/.test(text)) return "frontend";
  return "misc";
}

function totalRaw(person: Person) {
  return dims.reduce((sum, dim) => sum + person.raw[dim], 0);
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function dedupe(items: SearchPr[]) {
  const map = new Map<number, SearchPr>();
  for (const item of items) map.set(item.number, item);
  return [...map.values()].sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
}

function uniq(items: Evidence[]) {
  const map = new Map<string, Evidence>();
  for (const item of items) map.set(item.url, item);
  return [...map.values()];
}

function days(from: string, to: string) {
  const items: string[] = [];
  const date = new Date(`${from}T00:00:00Z`);
  const last = new Date(`${to}T00:00:00Z`);
  while (date <= last) {
    items.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return items;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson<T>(file: string) {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown) {
  await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
